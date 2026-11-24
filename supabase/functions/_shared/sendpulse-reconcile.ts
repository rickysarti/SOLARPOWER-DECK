import { db } from "./db.ts";
import { normalizePhone } from "./meta.ts";
import {
  listRecentSendPulseChats,
  listSendPulseChatMessages,
  type SendPulseChat,
  type SendPulseChatMessage,
} from "./sendpulse.ts";
import { cancelPendingCustomerReplies, enqueuePhone, recordWebhookReceipt } from "./webhook.ts";
import { applyContactState, syncMessageToCrm } from "./crm-compat.ts";

type ExistingInbound = {
  provider_message_id: string;
  provider_contact_id: string | null;
  content: string | null;
  received_at: string;
  raw_payload: Record<string, unknown> | null;
};

export type ReconciliationResult = {
  scannedChats: number;
  candidateChats: number;
  inspectedChats: number;
  recoveredMessages: number;
  skippedMessages: number;
  directionCounts: Record<string, number>;
  newestInboxMessageAt: string | null;
};

function normalizedText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function isInboundSendPulseMessage(message: SendPulseChatMessage | null | undefined): boolean {
  if (!message) return false;
  const direction = String(message.direction ?? "").toLowerCase();
  return direction === "1" || direction === "in" || direction === "incoming" || direction === "inbound";
}

export function sendPulseMessageContent(message: SendPulseChatMessage): {
  type: string;
  content: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
} {
  const data = message.data;
  if (typeof data === "string") {
    return { type: "text", content: data, mediaUrl: null, mimeType: null };
  }
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  const body = root.message && typeof root.message === "object" ? root.message : root;
  const text = body.text;
  const content = typeof text === "string"
    ? text
    : typeof text?.body === "string"
    ? text.body
    : typeof body.body === "string"
    ? body.body
    : typeof root.caption === "string"
    ? root.caption
    : null;
  const type = String(body.type ?? root.type ?? (content ? "text" : "unknown")).toLowerCase();
  const media = body[type] && typeof body[type] === "object" ? body[type] : root[type] ?? {};
  return {
    type,
    content: content ?? media?.caption ?? media?.filename ??
      (type !== "unknown" ? `[Archivo recibido: ${type}]` : null),
    mediaUrl: typeof media?.url === "string"
      ? media.url
      : typeof media?.link === "string"
      ? media.link
      : null,
    mimeType: typeof media?.mime_type === "string" ? media.mime_type : null,
  };
}

function contactId(chat: SendPulseChat): string {
  const contact = chat.contact && typeof chat.contact === "object" ? chat.contact : {};
  return String(contact.id ?? chat.inbox_last_message?.contact_id ?? "").trim();
}

function contactPhone(chat: SendPulseChat): string {
  const contact = chat.contact && typeof chat.contact === "object" ? chat.contact as Record<string, any> : {};
  const variables = contact.variables && typeof contact.variables === "object" ? contact.variables : {};
  const channel = contact.channel_data && typeof contact.channel_data === "object"
    ? contact.channel_data
    : {};
  return normalizePhone(String(contact.phone ?? channel.phone ?? variables.phone ?? ""));
}

function contactName(chat: SendPulseChat): string | null {
  const contact = chat.contact && typeof chat.contact === "object" ? chat.contact as Record<string, any> : {};
  const channel = contact.channel_data && typeof contact.channel_data === "object"
    ? contact.channel_data
    : {};
  const combined = [channel.first_name, channel.last_name].filter(Boolean).join(" ").trim();
  return normalizedText(channel.name ?? contact.name ?? combined) || null;
}

function messageTime(message: SendPulseChatMessage): string {
  const value = new Date(String(message.created_at ?? ""));
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

function knownProviderIds(row: ExistingInbound): string[] {
  const payload = row.raw_payload ?? {};
  const info = (payload as any)?.info?.message;
  return [
    row.provider_message_id,
    info?.id ? `sendpulse:${info.id}` : null,
    info?.channel_data?.message?.id ? `sendpulse:${info.channel_data.message.id}` : null,
  ].filter((value): value is string => Boolean(value));
}

function alreadyStored(
  message: SendPulseChatMessage,
  content: string | null,
  contact: string,
  existing: ExistingInbound[],
): boolean {
  const providerId = message.id ? `sendpulse:${message.id}` : "";
  const received = new Date(messageTime(message)).getTime();
  return existing.some((row) => {
    if (providerId && knownProviderIds(row).includes(providerId)) return true;
    if (row.provider_contact_id && row.provider_contact_id !== contact) return false;
    const sameText = normalizedText(row.content) === normalizedText(content);
    const distance = Math.abs(new Date(row.received_at).getTime() - received);
    return sameText && distance <= 10 * 60_000;
  });
}

export async function reconcileSendPulseInbound(): Promise<ReconciliationResult> {
  const chats = await listRecentSendPulseChats(100);
  const directionCounts: Record<string, number> = {};
  let newestInboxMessageAt: string | null = null;
  for (const chat of chats) {
    const last = chat.inbox_last_message;
    const direction = String(last?.direction ?? "missing").toLowerCase();
    directionCounts[direction] = (directionCounts[direction] ?? 0) + 1;
    const timestamp = new Date(String(last?.created_at ?? ""));
    if (
      Number.isFinite(timestamp.getTime()) &&
      (!newestInboxMessageAt || timestamp.getTime() > new Date(newestInboxMessageAt).getTime())
    ) {
      newestInboxMessageAt = timestamp.toISOString();
    }
  }
  // Keep a full WhatsApp customer-service window so a longer SendPulse or
  // deployment outage is also repaired once the cron resumes.
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const recent = chats.filter((chat) => {
    const last = chat.inbox_last_message;
    return isInboundSendPulseMessage(last) && new Date(String(last?.created_at ?? "")).getTime() >= cutoff;
  });
  if (!recent.length) {
    return {
      scannedChats: chats.length,
      candidateChats: 0,
      inspectedChats: 0,
      recoveredMessages: 0,
      skippedMessages: 0,
      directionCounts,
      newestInboxMessageAt,
    };
  }

  const since = new Date(cutoff - 15 * 60_000).toISOString();
  const stored = await db().from("agent_inbound_events")
    .select("provider_message_id,provider_contact_id,content,received_at,raw_payload")
    .eq("provider", "sendpulse").gte("received_at", since).limit(2000);
  if (stored.error) throw stored.error;
  const existing = (stored.data ?? []) as ExistingInbound[];
  const phoneByContact = new Map<string, string>();
  for (const row of existing) {
    if (row.provider_contact_id) {
      const phone = normalizePhone(String((row.raw_payload as any)?.contact?.phone ?? ""));
      if (phone) phoneByContact.set(row.provider_contact_id, phone);
    }
  }
  const historicalMappings = await db().from("agent_inbound_events")
    .select("provider_contact_id,phone").eq("provider", "sendpulse")
    .not("provider_contact_id", "is", null).order("received_at", { ascending: false }).limit(2000);
  if (historicalMappings.error) throw historicalMappings.error;
  for (const row of historicalMappings.data ?? []) {
    if (row.provider_contact_id && !phoneByContact.has(row.provider_contact_id)) {
      phoneByContact.set(row.provider_contact_id, normalizePhone(row.phone));
    }
  }

  let inspectedChats = 0;
  let recoveredMessages = 0;
  let skippedMessages = 0;
  const phones = new Set<string>();
  for (const chat of recent) {
    const id = contactId(chat);
    if (!id) continue;
    const latestContent = sendPulseMessageContent(chat.inbox_last_message!).content;
    if (alreadyStored(chat.inbox_last_message!, latestContent, id, existing)) continue;
    inspectedChats += 1;
    const phone = contactPhone(chat) || phoneByContact.get(id) || "";
    if (!phone) {
      skippedMessages += 1;
      continue;
    }
    const messages = await listSendPulseChatMessages(id, 25);
    for (const message of [...messages].reverse()) {
      if (!isInboundSendPulseMessage(message)) continue;
      if (new Date(messageTime(message)).getTime() < cutoff) continue;
      const parsed = sendPulseMessageContent(message);
      if (!parsed.content && !parsed.mediaUrl) {
        skippedMessages += 1;
        continue;
      }
      if (alreadyStored(message, parsed.content, id, existing)) continue;
      const providerMessageId = message.id
        ? `sendpulse:${message.id}`
        : `sendpulse:reconciled:${id}:${messageTime(message)}:${normalizedText(parsed.content).slice(0, 80)}`;
      const inserted = await db().from("agent_inbound_events").upsert({
        provider_message_id: providerMessageId,
        provider: "sendpulse",
        provider_contact_id: id,
        phone,
        contact_name: contactName(chat),
        message_type: parsed.type,
        content: parsed.content,
        media_url: parsed.mediaUrl,
        media_mime_type: parsed.mimeType,
        raw_payload: { source: "sendpulse_reconciliation", message, contact: chat.contact ?? null },
        received_at: messageTime(message),
        disposition: "pending",
      }, { onConflict: "provider_message_id", ignoreDuplicates: true }).select("id").maybeSingle();
      if (inserted.error) throw inserted.error;
      if (!inserted.data) continue;
      existing.push({
        provider_message_id: providerMessageId,
        provider_contact_id: id,
        content: parsed.content,
        received_at: messageTime(message),
        raw_payload: { source: "sendpulse_reconciliation" },
      });
      await recordWebhookReceipt({
        provider: "sendpulse",
        providerEventId: providerMessageId,
        phone,
        outcome: "accepted",
        reason: "reconciled_missing_webhook",
        inboundEventId: inserted.data.id,
        payload: message,
        metadata: { contact_id: id },
      });
      phones.add(phone);
      recoveredMessages += 1;
    }
  }
  for (const phone of phones) {
    await cancelPendingCustomerReplies(phone);
    await enqueuePhone(phone);
  }
  return {
    scannedChats: chats.length,
    candidateChats: recent.length,
    inspectedChats,
    recoveredMessages,
    skippedMessages,
    directionCounts,
    newestInboxMessageAt,
  };
}

type DeliveredReply = { content: string; created_at: string; metadata?: Record<string, any> | null };

// Outgoing SendPulse messages the bot did not send: replies a person wrote from
// the SendPulse inbox. They never reach agent_* tables, so without this the bot
// would answer as if the human conversation had not happened.
export function operatorRepliesFromHistory(
  messages: SendPulseChatMessage[],
  delivered: DeliveredReply[],
): Array<{ content: string; created_at: string }> {
  const botTexts = delivered.flatMap((row) => [row.content, row.metadata?.logical_content])
    .map(normalizedText).filter(Boolean);
  const replies: Array<{ content: string; created_at: string }> = [];
  for (const message of messages) {
    if (isInboundSendPulseMessage(message)) continue;
    const content = normalizedText(sendPulseMessageContent(message).content);
    if (!content || botTexts.some((text) => text.includes(content))) continue;
    replies.push({ content, created_at: messageTime(message) });
  }
  return replies;
}

export async function fetchOperatorReplies(
  contactId: string,
  delivered: DeliveredReply[],
): Promise<Array<{ content: string; created_at: string }>> {
  return operatorRepliesFromHistory(await listSendPulseChatMessages(contactId, 50), delivered);
}

export type OutageContact = {
  phone: string;
  name: string | null;
  inbound: number;
  outbound: number;
  firstInboundAt: string;
  lastInboundAt: string;
};

// Messages sent while the WhatsApp connection was down reached only the phone,
// where the team answered them by hand. Store them as already handled history,
// never as pending turns, and put the contact in human mode.
export async function quarantineOutageMessages(
  since: string,
  until: string,
  apply: boolean,
): Promise<{ contacts: OutageContact[]; applied: boolean }> {
  const from = new Date(since).getTime();
  const to = new Date(until).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("Invalid outage window");
  const contacts: OutageContact[] = [];
  for (const chat of await listRecentSendPulseChats(100)) {
    const id = contactId(chat);
    const phone = contactPhone(chat);
    if (!id || !phone) continue;
    const window = (await listSendPulseChatMessages(id, 100)).filter((message) => {
      const at = new Date(messageTime(message)).getTime();
      return at >= from && at <= to;
    }).reverse();
    const inbound = window.filter((message) => isInboundSendPulseMessage(message));
    if (!inbound.length) continue;
    const name = contactName(chat);
    contacts.push({
      phone,
      name,
      inbound: inbound.length,
      outbound: window.length - inbound.length,
      firstInboundAt: messageTime(inbound[0]),
      lastInboundAt: messageTime(inbound.at(-1)!),
    });
    if (!apply) continue;
    await applyContactState({
      phone,
      patch: { name, human_mode: true, label: "Revisión humana" },
      taskTitle: "Revisar mensajes de la caída de WhatsApp",
      taskDescription:
        "Escribió mientras WhatsApp estaba desconectado de la API (19/10 20:55 a 20/10). Los mensajes se respondieron a mano desde el celular; el bot quedó pausado para este contacto.",
    });
    for (const message of window) {
      const parsed = sendPulseMessageContent(message);
      const providerMessageId = message.id
        ? `sendpulse:${message.id}`
        : `sendpulse:outage:${id}:${messageTime(message)}`;
      if (isInboundSendPulseMessage(message)) {
        const stored = await db().from("agent_inbound_events").upsert({
          provider_message_id: providerMessageId,
          provider: "sendpulse",
          provider_contact_id: id,
          phone,
          contact_name: name,
          message_type: parsed.type,
          content: parsed.content,
          media_url: parsed.mediaUrl,
          media_mime_type: parsed.mimeType,
          raw_payload: { source: "outage_quarantine", message },
          received_at: messageTime(message),
          processed_at: new Date().toISOString(),
          disposition: "human_mode",
        }, { onConflict: "provider_message_id", ignoreDuplicates: true });
        if (stored.error) throw stored.error;
      }
      if (parsed.content) {
        await syncMessageToCrm({
          phone,
          name,
          role: isInboundSendPulseMessage(message) ? "user" : "assistant",
          content: parsed.content,
          sourceId: `outage:${providerMessageId}`,
          model: isInboundSendPulseMessage(message) ? null : "whatsapp-business-app",
        });
      }
    }
  }
  return { contacts, applied: apply };
}
