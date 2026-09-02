import { db, json, runtimeSecret, setting } from "../_shared/db.ts";
import { syncContactToCrm } from "../_shared/crm-compat.ts";
import { normalizePhone } from "../_shared/meta.ts";
import { processDueJobs } from "../_shared/processor.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const OUTGOING_TITLES = new Set([
  "outgoing_message", "message_sent", "operator_message", "admin_message",
  "sent_message", "human_message", "agent_message",
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

function parseEvent(payload: Record<string, any>) {
  const channel = payload?.info?.message?.channel_data?.message ?? {};
  const message = payload?.info?.message ?? payload?.message ?? {};
  const type = channel?.type ?? message?.type ?? "unknown";
  const media = channel?.[type] ?? message?.[type] ?? {};
  let content = channel?.text?.body ?? channel?.text ?? message?.text?.body ?? message?.text ?? null;
  if (type === "location") {
    const location = channel?.location ?? message?.location ?? {};
    content = `Ubicacion: ${location.latitude ?? ""}, ${location.longitude ?? ""}${location.name || location.address ? ` - ${location.name ?? location.address}` : ""}`;
  } else if (!content && ["image", "document", "video", "audio"].includes(type)) {
    content = media?.caption ?? media?.filename ?? `[Archivo recibido: ${type}]`;
  } else if (!content && type === "unsupported") {
    content = "[Mensaje no disponible o no soportado por WhatsApp]";
  }
  const tags = Array.isArray(payload?.contact?.tags) ? payload.contact.tags : [];
  return {
    phone: normalizePhone(String(payload?.contact?.phone ?? "")),
    contactName: payload?.contact?.name ? String(payload.contact.name) : null,
    contactId: payload?.contact?.id ? String(payload.contact.id) : null,
    type,
    content: content ? String(content) : null,
    mediaUrl: media?.url ? String(media.url) : null,
    mimeType: media?.mime_type ? String(media.mime_type) : null,
    title: String(payload?.title ?? "unknown"),
    isOutgoing: OUTGOING_TITLES.has(String(payload?.title ?? "unknown")) ||
      message?.direction === "outgoing" || message?.from_me === true,
    humanTagged: tags.some((tag: unknown) => HUMAN_TAG.test(typeof tag === "string" ? tag : JSON.stringify(tag))),
  };
}

async function eventId(payload: Record<string, any>, phone: string): Promise<string> {
  const explicit = payload?.info?.message?.channel_data?.message?.id ?? payload?.info?.message?.id ?? payload?.message?.id;
  if (explicit) return `sendpulse:${explicit}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${phone}:${JSON.stringify(payload)}`));
  return `sendpulse:${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function setHumanMode(phone: string, name: string | null): Promise<void> {
  const { data: existing, error: lookupError } = await db().from("agent_contacts").select("name")
    .eq("phone", phone).maybeSingle();
  if (lookupError) throw lookupError;
  const row = {
    phone,
    name: existing?.name ?? name,
    human_mode: true,
    last_contact: new Date().toISOString(),
  };
  const query = existing
    ? db().from("agent_contacts").update(row).eq("phone", phone)
    : db().from("agent_contacts").insert(row);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  await syncContactToCrm(data);
}

async function isBotEcho(phone: string, content: string | null): Promise<boolean> {
  if (!content) return false;
  const { data, error } = await db().from("agent_messages").select("content")
    .eq("contact_phone", phone).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return Boolean(data?.content) && normalize(data.content) === normalize(content);
}

async function schedulePhone(phone: string): Promise<void> {
  const { error } = await db().from("agent_jobs").upsert({
    dedupe_key: `inbound:${phone}`,
    job_type: "process_inbound",
    payload: { phone },
    status: "pending",
    attempts: 0,
    available_at: new Date(Date.now() + 20_000).toISOString(),
    locked_at: null,
    completed_at: null,
    last_error: null,
  }, { onConflict: "dedupe_key" });
  if (error) throw error;
}

async function processPayload(raw: unknown): Promise<number> {
  const payloads = Array.isArray(raw) ? raw : [raw];
  const phones = new Set<string>();
  let accepted = 0;
  for (const candidate of payloads) {
    if (!candidate || typeof candidate !== "object") continue;
    const payload = candidate as Record<string, any>;
    const event = parseEvent(payload);
    if (!event.phone) continue;
    if (event.isOutgoing) {
      const internal = await Promise.all([
        runtimeSecret("AGENT_RICARDO_PHONE"),
        runtimeSecret("AGENT_AGENDA_PHONE"),
        runtimeSecret("AGENT_GUILLERMO_PHONE"),
      ]);
      const internalPhones = internal.map((value) => normalizePhone(value ?? "")).filter(Boolean);
      if (!internalPhones.includes(event.phone) && !(await isBotEcho(event.phone, event.content))) {
        await setHumanMode(event.phone, event.contactName);
      }
      continue;
    }
    if (event.title !== "incoming_message" && event.title !== "unknown") continue;
    if (event.humanTagged) {
      await setHumanMode(event.phone, event.contactName);
      continue;
    }
    const providerMessageId = await eventId(payload, event.phone);
    const { error } = await db().from("agent_inbound_events").upsert({
      provider_message_id: providerMessageId,
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
    }, { onConflict: "provider_message_id", ignoreDuplicates: true });
    if (error) throw error;
    phones.add(event.phone);
    accepted += 1;
  }
  for (const phone of phones) await schedulePhone(phone);
  if (phones.size) {
    EdgeRuntime.waitUntil((async () => {
      await new Promise((resolve) => setTimeout(resolve, 21_000));
      try { await processDueJobs(Math.max(phones.size, 10)); }
      catch (error) { console.error("agent sendpulse background processor", error); }
    })());
  }
  return accepted;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);
  const expected = await setting("sendpulse_webhook_secret");
  const supplied = url.searchParams.get("token") ?? req.headers.get("x-agent-webhook-secret");
  if (!safeEqual(expected, supplied)) return json({ error: "invalid_webhook_secret" }, 401);
  try {
    const accepted = await processPayload(await req.json());
    return json({ received: true, accepted });
  } catch (error) {
    console.error("agent-sendpulse-webhook", error);
    return json({ error: "webhook_processing_failed" }, 500);
  }
});
