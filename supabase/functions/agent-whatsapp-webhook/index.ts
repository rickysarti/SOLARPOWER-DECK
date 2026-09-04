import { db, json, runtimeSecret } from "../_shared/db.ts";
import { errorMessage } from "../_shared/errors.ts";
import { normalizePhone, verifyMetaSignature } from "../_shared/meta.ts";
import { processDueJobs } from "../_shared/processor.ts";
import { enqueuePhone, payloadHash, recordWebhookError, recordWebhookReceipt } from "../_shared/webhook.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type MetaMessage = Record<string, any>;

function messageContent(
  message: MetaMessage,
): { content: string | null; mediaId: string | null; mimeType: string | null } {
  switch (message.type) {
    case "text":
      return { content: message.text?.body ?? null, mediaId: null, mimeType: null };
    case "image":
    case "document":
    case "audio":
    case "video": {
      const media = message[message.type] ?? {};
      return {
        content: media.caption ?? media.filename ?? null,
        mediaId: media.id ?? null,
        mimeType: media.mime_type ?? null,
      };
    }
    case "location":
      return {
        content: `Ubicación: ${message.location?.latitude}, ${message.location?.longitude}${
          message.location?.name ? ` - ${message.location.name}` : ""
        }`,
        mediaId: null,
        mimeType: null,
      };
    case "button":
      return {
        content: message.button?.text ?? message.button?.payload ?? null,
        mediaId: null,
        mimeType: null,
      };
    case "interactive":
      return {
        content: message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ??
          "[Respuesta interactiva]",
        mediaId: null,
        mimeType: null,
      };
    default:
      return { content: `[Mensaje ${message.type ?? "no compatible"}]`, mediaId: null, mimeType: null };
  }
}

async function processWebhook(
  payload: Record<string, any>,
): Promise<{ accepted: number; duplicates: number; statuses: number }> {
  let accepted = 0;
  let duplicates = 0;
  let statuses = 0;
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
        await db().from("agent_outbound_messages").update({
          status: status.status ?? "unknown",
          updated_at: new Date().toISOString(),
        }).eq("provider_message_id", status.id);
        statuses += 1;
      }

      for (const message of value.messages ?? []) {
        const phone = normalizePhone(message.from ?? "");
        const providerEventId = String(message.id ?? `meta:${await payloadHash(message)}`);
        if (!phone || !message.id) {
          await recordWebhookReceipt({
            provider: "meta",
            providerEventId,
            phone: phone || null,
            outcome: "ignored",
            reason: !phone ? "missing_phone" : "missing_message_id",
            payload: message,
            metadata: { type: message.type ?? "unknown" },
          });
          continue;
        }
        try {
          const parsed = messageContent(message);
          const inserted = await db().from("agent_inbound_events").upsert({
            provider_message_id: message.id,
            provider: "meta",
            phone,
            contact_name: names.get(phone) || null,
            message_type: message.type ?? "unknown",
            content: parsed.content,
            media_id: parsed.mediaId,
            media_mime_type: parsed.mimeType,
            raw_payload: message,
            received_at: message.timestamp
              ? new Date(Number(message.timestamp) * 1000).toISOString()
              : new Date().toISOString(),
            disposition: "pending",
          }, { onConflict: "provider_message_id", ignoreDuplicates: true }).select("id").maybeSingle();
          if (inserted.error) throw inserted.error;
          if (!inserted.data) {
            await recordWebhookReceipt({
              provider: "meta",
              providerEventId,
              phone,
              outcome: "duplicate",
              reason: "provider_message_id",
              payload: message,
              metadata: { type: message.type ?? "unknown" },
            });
            duplicates += 1;
            continue;
          }
          await recordWebhookReceipt({
            provider: "meta",
            providerEventId,
            phone,
            outcome: "accepted",
            inboundEventId: inserted.data.id,
            payload: message,
            metadata: { type: message.type ?? "unknown" },
          });
          phones.add(phone);
          accepted += 1;
        } catch (error) {
          await recordWebhookError("meta", providerEventId, message, error, phone);
          throw error;
        }
      }
    }
  }

  for (const phone of phones) await enqueuePhone(phone, 5);
  if (phones.size) {
    EdgeRuntime.waitUntil((async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      try {
        await processDueJobs(Math.max(phones.size, 10));
      } catch (error) {
        console.error("agent webhook background processor", errorMessage(error));
      }
    })());
  }
  return { accepted, duplicates, statuses };
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
    return json({ received: true, ...await processWebhook(JSON.parse(rawBody)) });
  } catch (error) {
    console.error("agent-whatsapp-webhook", errorMessage(error));
    return json({ error: "webhook_processing_failed" }, 500);
  }
});
