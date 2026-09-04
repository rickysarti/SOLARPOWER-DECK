import { db, json, runtimeSecret, setting } from "../_shared/db.ts";
import { applyContactState } from "../_shared/crm-compat.ts";
import { errorMessage } from "../_shared/errors.ts";
import { normalizePhone } from "../_shared/meta.ts";
import { processDueJobs } from "../_shared/processor.ts";
import { enqueuePhone, payloadHash, recordWebhookError, recordWebhookReceipt } from "../_shared/webhook.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const OUTGOING_TITLES = new Set([
  "outgoing_message",
  "message_sent",
  "operator_message",
  "admin_message",
  "sent_message",
  "human_message",
  "agent_message",
]);
const HUMAN_TAG = /humano|human|manual|pausad|tomado|asesor|operador|ricardo/i;

function safeEqual(expected: string | null, supplied: string | null): boolean {
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

function firstPhone(payload: Record<string, any>, message: Record<string, any>): string {
  const candidates = [
    payload?.contact?.phone,
    payload?.phone,
    message?.from,
    message?.phone,
    payload?.info?.message?.contact?.phone,
    payload?.info?.message?.channel_data?.contact?.phone,
  ];
  return normalizePhone(
    String(candidates.find((candidate) => candidate !== null && candidate !== undefined) ?? ""),
  );
}

function parseEvent(payload: Record<string, any>) {
  const channel = payload?.info?.message?.channel_data?.message ?? {};
  const message = payload?.info?.message ?? payload?.message ?? {};
  const type = String(channel?.type ?? message?.type ?? "unknown").toLowerCase();
  const media = channel?.[type] ?? message?.[type] ?? {};
  let content = channel?.text?.body ?? channel?.text ?? message?.text?.body ?? message?.text ?? null;
  if (type === "location") {
    const location = channel?.location ?? message?.location ?? {};
    content = `Ubicación: ${location.latitude ?? ""}, ${location.longitude ?? ""}${
      location.name || location.address ? ` - ${location.name ?? location.address}` : ""
    }`;
  } else if (!content && ["image", "document", "video", "audio"].includes(type)) {
    content = media?.caption ?? media?.filename ?? `[Archivo recibido: ${type}]`;
  } else if (!content && type === "unsupported") {
    content = "[Mensaje no disponible o no soportado por WhatsApp]";
  }
  const tags = Array.isArray(payload?.contact?.tags) ? payload.contact.tags : [];
  return {
    phone: firstPhone(payload, message),
    contactName: payload?.contact?.name ? String(payload.contact.name) : null,
    contactId: payload?.contact?.id ? String(payload.contact.id) : null,
    type,
    content: content ? String(content) : null,
    mediaUrl: media?.url ? String(media.url) : null,
    mimeType: media?.mime_type ? String(media.mime_type) : null,
    title: String(payload?.title ?? "unknown").toLowerCase(),
    isOutgoing: OUTGOING_TITLES.has(String(payload?.title ?? "unknown").toLowerCase()) ||
      message?.direction === "outgoing" || message?.from_me === true,
    humanTagged: tags.some((tag: unknown) =>
      HUMAN_TAG.test(typeof tag === "string" ? tag : JSON.stringify(tag))
    ),
  };
}

async function eventId(payload: Record<string, any>, phone: string): Promise<string> {
  const explicit = payload?.info?.message?.channel_data?.message?.id ??
    payload?.info?.message?.id ?? payload?.message?.id ?? payload?.event_id;
  if (explicit) return `sendpulse:${explicit}`;
  return `sendpulse:${await payloadHash({ phone, payload })}`;
}

async function internalPhones(): Promise<Set<string>> {
  const configured = await Promise.all([
    runtimeSecret("AGENT_RICARDO_PHONE"),
    runtimeSecret("AGENT_AGENDA_PHONE"),
    runtimeSecret("AGENT_GUILLERMO_PHONE"),
    runtimeSecret("AGENT_INTERNAL_PHONES"),
  ]);
  return new Set(
    configured.flatMap((value) => String(value ?? "").split(/[;,\s]+/))
      .map((value) => normalizePhone(value))
      .filter(Boolean),
  );
}

async function setHumanMode(phone: string, name: string | null): Promise<void> {
  await applyContactState({ phone, patch: { name, human_mode: true } });
}

async function isBotEcho(phone: string, content: string | null): Promise<boolean> {
  if (!content) return false;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const recentOutbound = await db().from("agent_outbound_messages")
    .select("content,provider_message_id,status")
    .eq("phone", phone)
    .in("status", ["sending", "sent", "delivered", "read"])
    .gte("created_at", new Date(Date.now() - 15 * 60_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (recentOutbound.error) throw recentOutbound.error;
  if (
    (recentOutbound.data ?? []).some((row) => normalize(String(row.content ?? "")) === normalize(content))
  ) {
    return true;
  }
  const { data, error } = await db().from("agent_messages").select("content")
    .eq("contact_phone", phone).eq("role", "assistant").order("created_at", { ascending: false }).limit(1)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.content === "string" && normalize(data.content) === normalize(content);
}

async function processPayload(
  raw: unknown,
): Promise<{ accepted: number; ignored: number; duplicates: number }> {
  const payloads = Array.isArray(raw) ? raw : [raw];
  const phones = new Set<string>();
  const admins = await internalPhones();
  let accepted = 0;
  let ignored = 0;
  let duplicates = 0;

  for (const candidate of payloads) {
    const fallbackId = `invalid:${await payloadHash(candidate)}`;
    if (!candidate || typeof candidate !== "object") {
      await recordWebhookReceipt({
        provider: "sendpulse",
        providerEventId: fallbackId,
        outcome: "rejected",
        reason: "invalid_payload",
        payload: candidate,
      });
      ignored += 1;
      continue;
    }
    const payload = candidate as Record<string, any>;
    const event = parseEvent(payload);
    const providerEventId = await eventId(payload, event.phone || "unknown");
    const receiptBase = {
      provider: "sendpulse",
      providerEventId,
      phone: event.phone || null,
      payload,
      metadata: { title: event.title, type: event.type, contact_id: event.contactId },
    };
    try {
      if (!event.phone) {
        await recordWebhookReceipt({ ...receiptBase, outcome: "ignored", reason: "missing_phone" });
        ignored += 1;
        continue;
      }
      if (event.isOutgoing) {
        const botEcho = await isBotEcho(event.phone, event.content);
        if (!admins.has(event.phone) && !botEcho) await setHumanMode(event.phone, event.contactName);
        await recordWebhookReceipt({
          ...receiptBase,
          outcome: "ignored",
          reason: botEcho ? "bot_echo" : admins.has(event.phone) ? "internal_outgoing" : "human_outgoing",
        });
        ignored += 1;
        continue;
      }
      if (event.title !== "incoming_message" && event.title !== "unknown") {
        await recordWebhookReceipt({
          ...receiptBase,
          outcome: "ignored",
          reason: `unsupported_title:${event.title}`,
        });
        ignored += 1;
        continue;
      }
      if (event.humanTagged) {
        await setHumanMode(event.phone, event.contactName);
        await recordWebhookReceipt({ ...receiptBase, outcome: "ignored", reason: "human_tag" });
        ignored += 1;
        continue;
      }

      const inserted = await db().from("agent_inbound_events").upsert({
        provider_message_id: providerEventId,
        provider: "sendpulse",
        provider_contact_id: event.contactId,
        phone: event.phone,
        contact_name: event.contactName,
        message_type: event.type,
        content: event.content,
        media_url: event.mediaUrl,
        media_mime_type: event.mimeType,
        raw_payload: payload,
        received_at: new Date().toISOString(),
        disposition: "pending",
      }, { onConflict: "provider_message_id", ignoreDuplicates: true }).select("id").maybeSingle();
      if (inserted.error) throw inserted.error;
      if (!inserted.data) {
        await recordWebhookReceipt({ ...receiptBase, outcome: "duplicate", reason: "provider_message_id" });
        duplicates += 1;
        continue;
      }
      await recordWebhookReceipt({
        ...receiptBase,
        outcome: "accepted",
        inboundEventId: inserted.data.id,
      });
      phones.add(event.phone);
      accepted += 1;
    } catch (error) {
      await recordWebhookError("sendpulse", providerEventId, payload, error, event.phone);
      throw error;
    }
  }

  for (const phone of phones) await enqueuePhone(phone, 5);
  if (phones.size) {
    EdgeRuntime.waitUntil((async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      try {
        await processDueJobs(Math.max(phones.size, 10));
      } catch (error) {
        console.error("agent sendpulse background processor", errorMessage(error));
      }
    })());
  }
  return { accepted, ignored, duplicates };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);
  const expected = await setting("sendpulse_webhook_secret");
  const supplied = url.searchParams.get("token") ?? req.headers.get("x-agent-webhook-secret");
  if (!safeEqual(expected, supplied)) return json({ error: "invalid_webhook_secret" }, 401);
  try {
    return json({ received: true, ...await processPayload(await req.json()) });
  } catch (error) {
    console.error("agent-sendpulse-webhook", errorMessage(error));
    return json({ error: "webhook_processing_failed" }, 500);
  }
});
