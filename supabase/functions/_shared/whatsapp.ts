import { db, setting } from "./db.ts";
import { errorMessage } from "./errors.ts";
import { downloadMetaMedia, sendMetaText } from "./meta.ts";
import { downloadSendPulseMedia, sendSendPulseChunk, splitText } from "./sendpulse.ts";
import { sanitizePlainText } from "./output.ts";

export async function whatsappProvider(): Promise<string> {
  return (await setting("whatsapp_provider")) ?? "sendpulse";
}

type OutboundRow = {
  id: number;
  phone: string;
  content: string;
  provider: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  metadata?: Record<string, unknown> | null;
};

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

async function deliverRow(row: OutboundRow): Promise<string> {
  if (["sent", "delivered", "read"].includes(row.status) && row.provider_message_id) {
    return row.provider_message_id;
  }
  const attempts = Number(row.attempts ?? 0) + 1;
  const locking = await db().from("agent_outbound_messages").update({
    status: "sending",
    attempts,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).in("status", ["pending", "failed"]).select("id").maybeSingle();
  if (locking.error) throw locking.error;
  if (!locking.data) {
    const current = await db().from("agent_outbound_messages")
      .select("provider_message_id,status").eq("id", row.id).single();
    if (current.error) throw current.error;
    if (current.data.provider_message_id && ["sent", "delivered", "read"].includes(current.data.status)) {
      return current.data.provider_message_id;
    }
    throw new Error("Outbound message is already being delivered");
  }
  try {
    const messageId = row.provider === "meta"
      ? await sendMetaText(row.phone, row.content)
      : await sendSendPulseChunk(row.phone, row.content);
    await db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return messageId;
  } catch (sendError) {
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
      row.phone !== input.phone || row.provider !== input.provider || row.content !== input.content ||
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
    status: "failed",
    error: "Delivery lock expired before the provider result was recorded",
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
    } catch {
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
