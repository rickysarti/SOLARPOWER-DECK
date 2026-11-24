import { db, setting } from "./db.ts";
import { DeliveryUncertainError, errorMessage } from "./errors.ts";
import {
  downloadMetaMedia,
  sendMetaDocument,
  sendMetaTemplate,
  sendMetaText,
  sendMetaTextOrTemplate,
} from "./meta.ts";
import { downloadSendPulseMedia, sendSendPulseChunk, splitText } from "./sendpulse.ts";
import { sanitizePlainText } from "./output.ts";
import { applyContactState } from "./crm-compat.ts";

export class CustomerReplySuppressedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CustomerReplySuppressedError";
  }
}

async function suppressReply(row: OutboundRow, reason: string, review = false): Promise<never> {
  const cancelled = await db().from("agent_outbound_messages").update({
    status: "cancelled",
    error: reason,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).in("status", ["pending", "failed", "sending"]);
  if (cancelled.error) throw cancelled.error;
  const logged = await db().from("agent_conversation_logs").insert({
    contact_phone: row.phone,
    event_type: "reply_suppressed",
    summary: reason,
    metadata: { outbound_id: row.id },
  });
  if (logged.error) throw logged.error;
  if (review) {
    await applyContactState({
      phone: row.phone,
      patch: { human_mode: true, label: "Revisión humana" },
      taskTitle: "Revisar respuesta repetida bloqueada",
      taskDescription:
        "El bloqueo final impidió repetir un mensaje. Continuar personalmente con el historial disponible.",
    });
  }
  throw new CustomerReplySuppressedError(reason);
}

export async function whatsappProvider(): Promise<string> {
  return (await setting("whatsapp_provider")) ?? "sendpulse";
}

type OutboundRow = {
  id: number;
  phone: string;
  content: string;
  provider: string;
  kind: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

export class CustomerReplySupersededError extends Error {
  constructor() {
    super("Customer reply was superseded by a newer inbound message");
    this.name = "CustomerReplySupersededError";
  }
}

export type PreparedWhatsAppText = {
  content: string;
  model: string | null;
};

export async function preparedWhatsAppText(logicalKey: string): Promise<PreparedWhatsAppText | null> {
  const existing = await db().from("agent_outbound_messages")
    .select("content,metadata")
    .eq("dedupe_key", `${logicalKey}:0`)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) return null;
  const metadata = existing.data.metadata && typeof existing.data.metadata === "object"
    ? existing.data.metadata as Record<string, unknown>
    : {};
  if (typeof metadata.logical_content !== "string") return null;
  return {
    content: sanitizePlainText(metadata.logical_content),
    model: typeof metadata.response_model === "string" ? metadata.response_model : null,
  };
}

type OutboundDocument = { link: string; filename: string };

function outboundDocument(row: OutboundRow): OutboundDocument | null {
  const document = row.metadata?.document as Record<string, unknown> | undefined;
  if (typeof document?.link !== "string" || typeof document?.filename !== "string") return null;
  return { link: document.link, filename: document.filename };
}

async function deliverViaMeta(row: OutboundRow): Promise<string> {
  const document = outboundDocument(row);
  if (document) return await sendMetaDocument(row.phone, { ...document, caption: row.content });
  // Bot replies always answer a fresh customer message. Anything else (CRM
  // follow-ups, internal notices) can fall outside the 24-hour window and then
  // only goes out as the approved follow-up template.
  if (row.kind === "customer_reply") return await sendMetaText(row.phone, row.content);
  const template = {
    name: await setting(
      ["agenda_reminder", "morning_report"].includes(row.kind) ? "meta_internal_template" : "meta_followup_template",
    ),
    language: (await setting("meta_template_language")) ?? "es_AR",
  };
  // Outside the window Meta accepts a free text and only fails it later through a
  // status callback, so the window is checked before calling the provider.
  const last = await db().from("agent_inbound_events").select("received_at").eq("phone", row.phone)
    .order("received_at", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw last.error;
  if (!last.data || Date.now() - new Date(last.data.received_at).getTime() >= 24 * 60 * 60_000) {
    if (!template.name) throw new Error("Outside the 24-hour window and no approved template is configured");
    return await sendMetaTemplate(row.phone, {
      name: template.name,
      language: template.language,
      bodyParameters: [row.content],
    });
  }
  return await sendMetaTextOrTemplate(row.phone, row.content, template);
}

async function deliverRow(row: OutboundRow): Promise<string> {
  if (["sent", "delivered", "read"].includes(row.status) && row.provider_message_id) {
    return row.provider_message_id;
  }
  if (row.kind === "customer_reply") {
    if (["cancelled", "uncertain"].includes(row.status)) {
      throw new CustomerReplySuppressedError(`Customer reply ${row.status}`);
    }
    if ((await setting("bot_enabled")) !== "true") return await suppressReply(row, "Bot paused");
    const contact = await db().from("chatbot_wa_contacts").select("human_mode,updated_at")
      .eq("phone", row.phone).maybeSingle();
    if (contact.error) throw contact.error;
    if (
      contact.data?.human_mode
    ) {
      return await suppressReply(row, "Contact in human mode");
    }
  }
  const attempts = Number(row.attempts ?? 0) + 1;
  // Unsent rows follow the provider configured now, so the cutover to Meta also
  // covers messages queued while SendPulse was still active.
  const provider = await whatsappProvider();
  const locking = await db().from("agent_outbound_messages").update({
    status: "sending",
    provider,
    attempts,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).in("status", ["pending", "failed"]).select("id").maybeSingle();
  if (locking.error) {
    if (row.kind === "customer_reply" && locking.error.message.includes("customer_turn_already_answered")) {
      return await suppressReply(row, "Inbound turn already answered by another worker");
    }
    if (row.kind === "customer_reply" && locking.error.message.includes("customer_reply_duplicate")) {
      return await suppressReply(row, "Duplicate customer reply blocked before provider call", true);
    }
    throw locking.error;
  }
  if (!locking.data) {
    const current = await db().from("agent_outbound_messages")
      .select("provider_message_id,status").eq("id", row.id).single();
    if (current.error) throw current.error;
    if (current.data.provider_message_id && ["sent", "delivered", "read"].includes(current.data.status)) {
      return current.data.provider_message_id;
    }
    if (row.kind === "customer_reply" && current.data.status === "cancelled") {
      throw new CustomerReplySupersededError();
    }
    throw new Error("Outbound message is already being delivered");
  }
  try {
    if (row.kind === "customer_reply") {
      const inboundIds = new Set(
        Array.isArray(row.metadata?.inbound_event_ids)
          ? row.metadata.inbound_event_ids.map((id) => String(id))
          : [],
      );
      const inbound = await db().from("agent_inbound_events")
        .select("id,received_at,processed_at").eq("phone", row.phone)
        .order("received_at", { ascending: false }).limit(200);
      if (inbound.error) throw inbound.error;
      const superseded = (inbound.data ?? []).some((event) =>
        !inboundIds.has(String(event.id)) &&
        (event.processed_at === null ||
          new Date(event.received_at).getTime() > new Date(row.created_at).getTime())
      );
      if (superseded) {
        const cancelled = await db().from("agent_outbound_messages").update({
          status: "cancelled",
          error: "Superseded by a newer inbound message",
          updated_at: new Date().toISOString(),
        }).eq("id", row.id).eq("status", "sending");
        if (cancelled.error) throw cancelled.error;
        throw new CustomerReplySupersededError();
      }
      const current = await db().from("agent_outbound_messages").select("status").eq("id", row.id).single();
      if (current.error) throw current.error;
      if (current.data.status === "cancelled") throw new CustomerReplySupersededError();
      // A human can take over while the worker checks the inbox and claims the
      // outbound row. Re-read the authoritative contact immediately before send.
      if ((await setting("bot_enabled")) !== "true") return await suppressReply(row, "Bot paused");
      const latestContact = await db().from("chatbot_wa_contacts").select("human_mode")
        .eq("phone", row.phone).maybeSingle();
      if (latestContact.error) throw latestContact.error;
      if (!latestContact.data || latestContact.data.human_mode !== false) {
        return await suppressReply(row, "Contact unavailable or in human mode before provider call");
      }
    }
    const messageId = provider === "meta"
      ? await deliverViaMeta(row)
      : await sendSendPulseChunk(row.phone, row.content);
    const recorded = await db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (recorded.error) {
      throw new DeliveryUncertainError("Provider accepted message but receipt persistence failed");
    }
    return messageId;
  } catch (sendError) {
    if (
      sendError instanceof CustomerReplySupersededError || sendError instanceof CustomerReplySuppressedError
    ) throw sendError;
    if (sendError instanceof DeliveryUncertainError) {
      const held = await db().from("agent_outbound_messages").update({
        status: "uncertain",
        error: sendError.message,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (held.error) throw held.error;
      if (row.kind === "customer_reply") {
        await applyContactState({
          phone: row.phone,
          patch: { human_mode: true, label: "Revisión humana" },
          taskTitle: "Verificar entrega de WhatsApp",
          taskDescription:
            "El proveedor no confirmó el resultado del envío. Revisar el chat antes de reenviar para evitar duplicados.",
        });
        throw new CustomerReplySuppressedError(sendError.message);
      }
      throw sendError;
    }
    const terminal = attempts >= 5;
    await db().from("agent_outbound_messages").update({
      status: "failed",
      error: errorMessage(sendError),
      available_at: new Date(Date.now() + Math.min(30, 2 ** attempts) * 60_000).toISOString(),
      metadata: { ...(row.metadata ?? {}), terminal },
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    throw sendError;
  }
}

async function getOrCreateOutbound(input: {
  phone: string;
  content: string;
  provider: string;
  dedupeKey: string;
  kind: string;
  chunkIndex: number;
  chunkCount: number;
  metadata: Record<string, unknown>;
  availableAt: string;
}): Promise<OutboundRow> {
  const validate = (row: OutboundRow): OutboundRow => {
    if (
      // The provider is resolved again at delivery time, so it is not part of the identity.
      row.phone !== input.phone || row.content !== input.content ||
      Number((row as any).chunk_index ?? 0) !== input.chunkIndex ||
      Number((row as any).chunk_count ?? 1) !== input.chunkCount
    ) {
      throw new Error(`Outbound idempotency conflict for ${input.dedupeKey}`);
    }
    return row;
  };
  const existing = await db().from("agent_outbound_messages").select("*")
    .eq("dedupe_key", input.dedupeKey).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return validate(existing.data as OutboundRow);
  const inserted = await db().from("agent_outbound_messages").insert({
    phone: input.phone,
    content: input.content,
    provider: input.provider,
    dedupe_key: input.dedupeKey,
    kind: input.kind,
    chunk_index: input.chunkIndex,
    chunk_count: input.chunkCount,
    metadata: input.metadata,
    available_at: input.availableAt,
    status: "pending",
  }).select("*").single();
  if (!inserted.error) return validate(inserted.data as OutboundRow);
  const raced = await db().from("agent_outbound_messages").select("*")
    .eq("dedupe_key", input.dedupeKey).single();
  if (raced.error) throw inserted.error;
  return validate(raced.data as OutboundRow);
}

export async function sendWhatsAppText(
  phone: string,
  content: string,
  options: { dedupeKey?: string; kind?: string; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  const clean = sanitizePlainText(content);
  if (!clean) throw new Error("Outbound message became empty after sanitization");
  const provider = await whatsappProvider();
  const chunks = splitText(clean);
  const logicalKey = options.dedupeKey ?? `outbound:${crypto.randomUUID()}`;
  const preparedRows: OutboundRow[] = [];
  const availableAt = new Date(Date.now() + 60_000).toISOString();
  // Persist the complete immutable delivery manifest before the first provider
  // call. A retry can then resume the same answer instead of regenerating and
  // combining chunks from two different model outputs.
  for (let index = 0; index < chunks.length; index += 1) {
    preparedRows.push(
      await getOrCreateOutbound({
        phone,
        content: chunks[index],
        provider,
        dedupeKey: `${logicalKey}:${index}`,
        kind: options.kind ?? "customer_reply",
        chunkIndex: index,
        chunkCount: chunks.length,
        metadata: {
          ...(options.metadata ?? {}),
          logical_key: logicalKey,
          logical_content: clean,
        },
        availableAt,
      }),
    );
  }
  let messageId = "";
  for (const row of preparedRows) {
    messageId = await deliverRow(row);
  }
  return messageId;
}

export async function retryDueOutboundMessages(limit = 20): Promise<{ sent: number; failed: number }> {
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const recovered = await db().from("agent_outbound_messages").update({
    status: "uncertain",
    error: "Delivery result unknown; automatic retry blocked to prevent duplicates",
    available_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("status", "sending").lt("updated_at", staleBefore).is("provider_message_id", null);
  if (recovered.error) throw recovered.error;
  const due = await db().from("agent_outbound_messages").select("*")
    .in("status", ["pending", "failed"])
    .lt("attempts", 5)
    .lte("available_at", new Date().toISOString())
    .order("available_at")
    .order("created_at")
    .order("chunk_index")
    .limit(limit);
  if (due.error) throw due.error;
  let sent = 0;
  let failed = 0;
  for (const row of (due.data ?? []) as OutboundRow[]) {
    try {
      await deliverRow(row);
      sent += 1;
    } catch (error) {
      if (error instanceof CustomerReplySupersededError || error instanceof CustomerReplySuppressedError) {
        continue;
      }
      failed += 1;
    }
  }
  return { sent, failed };
}

export async function downloadWhatsAppMedia(event: Record<string, unknown>) {
  if (String(event.provider ?? "meta") === "sendpulse" && event.media_url) {
    return await downloadSendPulseMedia(String(event.media_url));
  }
  return await downloadMetaMedia(String(event.media_id ?? ""));
}
