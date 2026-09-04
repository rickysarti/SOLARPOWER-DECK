import { runtimeSecret } from "./db.ts";
import { normalizePhone } from "./meta.ts";

const API_BASE = "https://api.sendpulse.com";
let tokenCache: { value: string; expiresAt: number } | null = null;
let botIdCache: string | null = null;

export type SendPulseChatMessage = {
  id?: string;
  contact_id?: string;
  bot_id?: string;
  data?: Record<string, unknown> | string | null;
  direction?: number | string;
  created_at?: string;
  [key: string]: unknown;
};

export type SendPulseChat = {
  contact?: Record<string, unknown>;
  inbox_last_message?: SendPulseChatMessage;
  inbox_unread?: number;
  [key: string]: unknown;
};

async function requestToken(force = false): Promise<string> {
  if (!force && tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const clientId = await runtimeSecret("SENDPULSE_API_ID");
  const clientSecret = await runtimeSecret("SENDPULSE_API_SECRET");
  if (!clientId || !clientSecret) throw new Error("SendPulse credentials are not configured");
  const response = await fetch(`${API_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result?.access_token) throw new Error(`SendPulse OAuth ${response.status}`);
  tokenCache = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in ?? 3600) - 60) * 1000,
  };
  return tokenCache.value;
}

async function botId(): Promise<string> {
  if (botIdCache) return botIdCache;
  const configured = await runtimeSecret("SENDPULSE_BOT_ID");
  if (configured) return botIdCache = configured;
  const token = await requestToken();
  const response = await fetch(`${API_BASE}/whatsapp/bots`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  const bots = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
  if (!response.ok || !bots[0]?.id) throw new Error("No SendPulse WhatsApp bot is available");
  return botIdCache = String(bots[0].id);
}

function responseRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter((row) => row && typeof row === "object");
  if (!result || typeof result !== "object") return [];
  const data = (result as Record<string, unknown>).data;
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === "object");
  if (!data || typeof data !== "object") return [];
  for (const key of ["list", "items", "data"]) {
    const rows = (data as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows.filter((row) => row && typeof row === "object");
  }
  return [];
}

async function getRows(
  path: string,
  params: URLSearchParams,
  attempt = 0,
): Promise<Record<string, unknown>[]> {
  const token = await requestToken();
  const response = await fetch(`${API_BASE}/whatsapp/${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const raw = await response.text();
  if (response.status === 401 && attempt === 0) {
    await requestToken(true);
    return await getRows(path, params, 1);
  }
  if (!response.ok) throw new Error(`SendPulse ${path} ${response.status}: ${raw.slice(0, 300)}`);
  let result: unknown;
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`SendPulse ${path} returned invalid JSON`);
  }
  return responseRows(result);
}

export async function listRecentSendPulseChats(size = 100): Promise<SendPulseChat[]> {
  const params = new URLSearchParams({
    bot_id: await botId(),
    size: String(Math.max(1, Math.min(size, 100))),
    skip: "0",
  });
  return await getRows("chats", params) as SendPulseChat[];
}

export async function listSendPulseChatMessages(
  contactId: string,
  size = 25,
): Promise<SendPulseChatMessage[]> {
  const params = new URLSearchParams({
    contact_id: contactId,
    size: String(Math.max(1, Math.min(size, 100))),
    order: "desc",
  });
  return await getRows("chats/messages", params) as SendPulseChatMessage[];
}

// SendPulse allows up to 512 characters for a WhatsApp text message. Keep a
// small safety margin so normal customer replies are always delivered as one
// coherent message instead of being split mid-sentence.
export function splitText(text: string, maxChars = 500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    const window = remaining.slice(0, maxChars + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const end = boundary > maxChars * 0.55
      ? boundary + (window.slice(boundary, boundary + 2) === ". " ? 1 : 0)
      : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  return chunks;
}

async function sendChunk(phone: string, text: string, attempt = 0): Promise<Record<string, unknown>> {
  const token = await requestToken();
  const response = await fetch(`${API_BASE}/whatsapp/contacts/sendByPhone`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      phone: normalizePhone(phone),
      bot_id: await botId(),
      message: { type: "text", text: { body: text } },
    }),
  });
  const raw = await response.text();
  let result: Record<string, unknown> = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = { response: raw.slice(0, 300) };
  }
  const retryable = response.status === 401 || response.status === 408 || response.status === 425 ||
    response.status === 429 || response.status >= 500 ||
    (response.status === 400 && /temporar|unavailable|try again|timeout|internal error/i.test(raw));
  if (!response.ok && retryable && attempt < 2) {
    if (response.status === 401) await requestToken(true);
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    return await sendChunk(phone, text, attempt + 1);
  }
  if (!response.ok) throw new Error(`SendPulse ${response.status}: ${raw.slice(0, 400)}`);
  return result;
}

export async function sendSendPulseChunk(phone: string, content: string): Promise<string> {
  const result: any = await sendChunk(phone, content);
  return String(result?.data?.message_id ?? result?.message_id ?? result?.id ?? "") ||
    `sendpulse:${crypto.randomUUID()}`;
}

export async function sendSendPulseText(phone: string, content: string): Promise<string> {
  let messageId: string | null = null;
  const chunks = splitText(content);
  for (let index = 0; index < chunks.length; index += 1) {
    messageId = await sendSendPulseChunk(phone, chunks[index]);
    if (index < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return messageId ?? `sendpulse:${crypto.randomUUID()}`;
}

export async function downloadSendPulseMedia(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const token = await requestToken();
  let response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    response = await fetch(url, { headers: { authorization: `Bearer ${await requestToken(true)}` } });
  }
  if (!response.ok) throw new Error(`Unable to download SendPulse media (${response.status})`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

export async function checkSendPulse(): Promise<boolean> {
  await botId();
  return true;
}
