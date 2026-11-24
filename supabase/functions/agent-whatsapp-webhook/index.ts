import { db, json, runtimeSecret, setting } from "../_shared/db.ts";
import { applyContactState, syncMessageToCrm } from "../_shared/crm-compat.ts";
import { errorMessage } from "../_shared/errors.ts";
import { downloadMetaMedia, normalizePhone, verifyMetaSignature } from "../_shared/meta.ts";
import {
  cancelPendingCustomerReplies,
  enqueuePhone,
  payloadHash,
  recordWebhookError,
  recordWebhookReceipt,
} from "../_shared/webhook.ts";

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
    case "video":
    case "sticker": {
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
    case "contacts":
      return {
        content: `Contacto compartido: ${
          (message.contacts ?? []).map((contact: any) =>
            [contact.name?.formatted_name, contact.phones?.[0]?.phone].filter(Boolean).join(" ")
          ).join(", ")
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

// Reactions, edits and deletions are not a customer turn nor a manual reply.
const NON_MESSAGE_TYPES = new Set(["reaction", "edit", "revoke", "system"]);

async function internalPhones(): Promise<Set<string>> {
  const configured = await Promise.all([
    runtimeSecret("AGENT_RICARDO_PHONE"),
    runtimeSecret("AGENT_AGENDA_PHONE"),
    runtimeSecret("AGENT_GUILLERMO_PHONE"),
    runtimeSecret("AGENT_INTERNAL_PHONES"),
  ]);
  return new Set(
    configured.flatMap((value) => String(value ?? "").split(/[;,\s]+/)).map(normalizePhone).filter(Boolean),
  );
}

// Meta only echoes messages typed in the phone app, never the ones sent through the
// API. This guard covers an echo of our own text anyway, so the bot cannot pause itself.
async function isOwnMessage(phone: string, content: string | null, id: string | null): Promise<boolean> {
  const recent = await db().from("agent_outbound_messages").select("content,provider_message_id")
    .eq("phone", phone).in("status", ["sending", "sent", "delivered", "read"])
    .gte("created_at", new Date(Date.now() - 15 * 60_000).toISOString())
    .order("created_at", { ascending: false }).limit(20);
  if (recent.error) throw recent.error;
  const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  return (recent.data ?? []).some((row) =>
    (id && row.provider_message_id === id) || (content && normalize(row.content) === normalize(content))
  );
}

const MEDIA_LABELS: Record<string, string> = {
  image: "Imagen enviada",
  document: "Documento enviado",
  audio: "Audio enviado",
  video: "Video enviado",
  sticker: "Sticker enviado",
};

// Files sent from the phone go to the private bucket, like the ones customers send.
// A download problem never loses the message itself.
async function storeEchoMedia(
  phone: string,
  echo: MetaMessage,
): Promise<{ attachments: Array<Record<string, unknown>>; fileName: string | null }> {
  const media = echo[echo.type];
  if (!MEDIA_LABELS[echo.type] || !media?.id) return { attachments: [], fileName: null };
  const fileName = typeof media.filename === "string" ? media.filename.slice(0, 180) : null;
  try {
    const { bytes, mimeType } = await downloadMetaMedia(String(media.id));
    const type = mimeType.split(";")[0].trim().toLowerCase();
    const extension = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? type.split("/")[1]?.replace(/[^a-z0-9]/g, "") ?? "bin";
    const path = `${phone}/echo-${String(echo.id).replace(/[^a-zA-Z0-9]/g, "").slice(-40)}.${extension}`;
    const uploaded = await db().storage.from("agent-files").upload(path, bytes, { contentType: type, upsert: false });
    if (uploaded.error && !uploaded.error.message.toLowerCase().includes("already exists")) throw uploaded.error;
    const stored = await db().from("agent_files").upsert({
      contact_phone: phone,
      storage_path: path,
      file_name: fileName ?? path.split("/")[1],
      mime_type: type,
      provider_media_id: String(media.id),
      analysis: JSON.stringify({ kind: "other", confidence: "high", description: "Enviado desde el teléfono", evidence: "" }),
    }, { onConflict: "storage_path" });
    if (stored.error) throw stored.error;
    return {
      attachments: [{
        type: echo.type,
        storage_bucket: "agent-files",
        storage_path: path,
        file_name: fileName ?? path.split("/")[1],
        mime_type: type,
      }],
      fileName,
    };
  } catch (error) {
    console.error("echo media", errorMessage(error));
    return { attachments: [], fileName };
  }
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

async function applyStatus(status: Record<string, any>): Promise<void> {
  const current = await db().from("agent_outbound_messages").select("id,phone,kind,status,metadata")
    .eq("provider", "meta").eq("provider_message_id", status.id).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return;
  const next = String(status.status ?? "");
  if (next === "failed") {
    const detail = (status.errors ?? []).map((e: any) => `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim())
      .join("; ");
    const failed = await db().from("agent_outbound_messages").update({
      status: "failed",
      error: `Meta delivery failed: ${detail || "sin detalle"}`,
      // Meta already accepted it once: exhaust the attempts so the outbox never resends it.
      attempts: 5,
      metadata: { ...(current.data.metadata ?? {}), terminal: true },
      updated_at: new Date().toISOString(),
    }).eq("id", current.data.id).neq("status", "failed").select("id").maybeSingle();
    if (failed.error) throw failed.error;
    if (!failed.data) return;
    const chatMessageId = current.data.metadata?.chatbot_message_id;
    if (chatMessageId) {
      const chat = await db().from("chatbot_messages").select("metadata").eq("id", chatMessageId).maybeSingle();
      if (chat.error) throw chat.error;
      if (chat.data) {
        const marked = await db().from("chatbot_messages").update({
          metadata: {
            ...(chat.data.metadata ?? {}),
            wa_delivery: {
              ...(chat.data.metadata?.wa_delivery ?? {}),
              delivered: false,
              warning: `WhatsApp no lo entregó: ${detail || "sin detalle"}`,
            },
          },
        }).eq("id", chatMessageId);
        if (marked.error) throw marked.error;
      }
    }
    if (["customer_reply", "crm_manual"].includes(current.data.kind)) {
      await applyContactState({
        phone: current.data.phone,
        patch: {},
        taskTitle: "WhatsApp no entregó un mensaje",
        taskDescription: `Meta informó que no se entregó: ${detail || "sin detalle"}. Revisar el chat y contactar al cliente.`,
      });
    }
    return;
  }
  // Meta may deliver status callbacks out of order; never move backwards.
  if ((STATUS_RANK[next] ?? 0) <= (STATUS_RANK[current.data.status] ?? 0)) return;
  const updated = await db().from("agent_outbound_messages").update({
    status: next,
    updated_at: new Date().toISOString(),
  }).eq("id", current.data.id);
  if (updated.error) throw updated.error;
}

const TEMPLATE_SETTINGS: Record<string, string> = {
  presupuesto_solarpower: "meta_quote_template",
  seguimiento_solarpower: "meta_followup_template",
  aviso_interno_solarpower: "meta_internal_template",
};

// A template is used only while Meta has it approved.
async function applyTemplateStatus(value: Record<string, any>): Promise<void> {
  const key = TEMPLATE_SETTINGS[String(value.message_template_name ?? "")];
  const event = String(value.event ?? "");
  if (!key) return;
  const result = event === "APPROVED"
    ? await db().from("agent_settings").upsert(
      { key, value: value.message_template_name, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    )
    : ["REJECTED", "PAUSED", "DISABLED", "PENDING_DELETION", "DELETED"].includes(event)
    ? await db().from("agent_settings").delete().eq("key", key)
    : { error: null };
  if (result.error) throw result.error;
}

async function processWebhook(
  payload: Record<string, any>,
): Promise<{ accepted: number; duplicates: number; statuses: number; shadow: number }> {
  // Until whatsapp_provider is "meta", SendPulse still owns the conversation. Meta
  // events are only receipted so the subscription can be verified without double replies.
  const shadow = (await setting("whatsapp_provider")) !== "meta";
  let shadowed = 0;
  let accepted = 0;
  let duplicates = 0;
  let statuses = 0;
  const phones = new Set<string>();
  const internal = await internalPhones();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (change.field === "message_template_status_update") {
        await applyTemplateStatus(value);
        continue;
      }
      const names = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        names.set(normalizePhone(contact.wa_id ?? ""), contact.profile?.name ?? "");
      }

      for (const status of value.statuses ?? []) {
        if (!status.id) continue;
        await applyStatus(status);
        statuses += 1;
      }

      // Coexistence: replies typed in the WhatsApp Business phone app arrive as
      // echoes. A person took over, so they enter the history and pause the bot,
      // exactly as SendPulse operator replies did.
      for (const echo of change.field === "smb_message_echoes" ? value.message_echoes ?? [] : []) {
        const phone = normalizePhone(echo.to ?? "");
        const providerEventId = `meta-echo:${echo.id ?? await payloadHash(echo)}`;
        const receipt = {
          provider: "meta",
          providerEventId,
          phone: phone || null,
          payload: echo,
          metadata: { type: echo.type ?? "unknown", field: change.field },
        };
        // Echoes count even before the cutover: SendPulse never reported replies typed
        // on the phone, so this is the only signal that a person took over.
        if (!phone) {
          await recordWebhookReceipt({ ...receipt, outcome: "ignored", reason: "missing_phone" });
          continue;
        }
        if (NON_MESSAGE_TYPES.has(echo.type)) {
          await recordWebhookReceipt({ ...receipt, outcome: "ignored", reason: "non_message_echo" });
          continue;
        }
        const echoed = messageContent(echo).content;
        if (await isOwnMessage(phone, echoed, echo.id ?? null)) {
          await recordWebhookReceipt({ ...receipt, outcome: "ignored", reason: "bot_echo" });
          continue;
        }
        const isInternal = internal.has(phone);
        if (!isInternal) {
          // Pause first: the bot must not answer while the history is being written.
          await applyContactState({ phone, patch: { human_mode: true } });
          await cancelPendingCustomerReplies(phone);
        }
        const { attachments, fileName } = await storeEchoMedia(phone, echo);
        const label = MEDIA_LABELS[echo.type];
        const content = label
          ? [`[${label} desde el teléfono${fileName ? `: ${fileName}` : ""}]`, echo[echo.type]?.caption]
            .filter(Boolean).join("\n")
          : echoed ?? "[Mensaje enviado desde el teléfono]";
        await syncMessageToCrm({
          phone,
          name: null,
          role: "assistant",
          content,
          sourceId: providerEventId,
          model: "whatsapp-business-app",
          metadata: {
            sent_by_admin: true,
            admin_name: "Teléfono SolarPower",
            contact_actor: "solarpower",
            channel_source: "whatsapp_business_app",
          },
          attachments,
        });
        await recordWebhookReceipt({
          ...receipt,
          outcome: "ignored",
          reason: isInternal ? "internal_outgoing" : "human_outgoing",
        });
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
        if (NON_MESSAGE_TYPES.has(message.type)) {
          await recordWebhookReceipt({
            provider: "meta",
            providerEventId,
            phone,
            outcome: "ignored",
            reason: `non_message_type:${message.type}`,
            payload: message,
            metadata: { type: message.type },
          });
          continue;
        }
        if (shadow) {
          await recordWebhookReceipt({
            provider: "meta",
            providerEventId,
            phone,
            outcome: "ignored",
            reason: "shadow_until_meta_cutover",
            payload: message,
            metadata: { type: message.type ?? "unknown" },
          });
          shadowed += 1;
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

  for (const phone of phones) {
    await cancelPendingCustomerReplies(phone);
    await enqueuePhone(phone);
  }
  // Webhooks only persist and enqueue. The minute scheduler owns processing.
  return { accepted, duplicates, statuses, shadow: shadowed };
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
