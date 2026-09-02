import { db, json, runtimeSecret } from "../_shared/db.ts";
import { normalizePhone, verifyMetaSignature } from "../_shared/meta.ts";
import { processDueJobs } from "../_shared/processor.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type MetaMessage = Record<string, any>;

function messageContent(message: MetaMessage): { content: string | null; mediaId: string | null; mimeType: string | null } {
  switch (message.type) {
    case "text":
      return { content: message.text?.body ?? null, mediaId: null, mimeType: null };
    case "image":
    case "document":
    case "audio":
    case "video": {
      const media = message[message.type] ?? {};
      const detail = media.caption ?? media.filename ?? null;
      return { content: detail, mediaId: media.id ?? null, mimeType: media.mime_type ?? null };
    }
    case "location":
      return {
        content: `Ubicacion: ${message.location?.latitude}, ${message.location?.longitude}${message.location?.name ? ` - ${message.location.name}` : ""}`,
        mediaId: null,
        mimeType: null,
      };
    case "button":
      return { content: message.button?.text ?? message.button?.payload ?? null, mediaId: null, mimeType: null };
    case "interactive":
      return {
        content: message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "[Respuesta interactiva]",
        mediaId: null,
        mimeType: null,
      };
    default:
      return { content: `[Mensaje ${message.type ?? "no compatible"}]`, mediaId: null, mimeType: null };
  }
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

async function processWebhook(payload: Record<string, any>): Promise<number> {
  let accepted = 0;
  const phones = new Set<string>();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        names.set(normalizePhone(contact.wa_id ?? ""), contact.profile?.name ?? "");
      }

      for (const status of value.statuses ?? []) {
        if (!status.id) continue;
        await db().from("agent_outbound_messages").update({ status: status.status ?? "unknown" })
          .eq("provider_message_id", status.id);
      }

      for (const message of value.messages ?? []) {
        const phone = normalizePhone(message.from ?? "");
        if (!phone || !message.id) continue;
        const parsed = messageContent(message);
        const { error } = await db().from("agent_inbound_events").upsert({
          provider_message_id: message.id,
          provider: "meta",
          phone,
          contact_name: names.get(phone) || null,
          message_type: message.type ?? "unknown",
          content: parsed.content,
          media_id: parsed.mediaId,
          media_mime_type: parsed.mimeType,
          raw_payload: message,
          received_at: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
        }, { onConflict: "provider_message_id", ignoreDuplicates: true });
        if (error) throw error;
        phones.add(phone);
        accepted += 1;
      }
    }
  }

  for (const phone of phones) await schedulePhone(phone);
  if (phones.size) {
    EdgeRuntime.waitUntil((async () => {
      await new Promise((resolve) => setTimeout(resolve, 21_000));
      try {
        await processDueJobs(Math.max(phones.size, 10));
      } catch (error) {
        console.error("agent webhook background processor", error);
      }
    })());
  }
  return accepted;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === await runtimeSecret("META_VERIFY_TOKEN")) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return json({ error: "verification_failed" }, 403);
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const rawBody = await req.text();
  if (!(await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256")))) {
    return json({ error: "invalid_signature" }, 401);
  }

  try {
    const accepted = await processWebhook(JSON.parse(rawBody));
    return json({ received: true, accepted });
  } catch (error) {
    console.error("agent-whatsapp-webhook", error);
    return json({ error: "webhook_processing_failed" }, 500);
  }
});
