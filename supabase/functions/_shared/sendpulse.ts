import { runtimeSecret } from "./db.ts";
import { normalizePhone } from "./meta.ts";

const API_BASE = "https://api.sendpulse.com";
let tokenCache: { value: string; expiresAt: number } | null = null;
let botIdCache: string | null = null;

async function requestToken(force = false): Promise<string> {
  if (!force && tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const clientId = await runtimeSecret("SENDPULSE_API_ID");
  const clientSecret = await runtimeSecret("SENDPULSE_API_SECRET");
  if (!clientId || !clientSecret) throw new Error("SendPulse credentials are not configured");
  const response = await fetch(`${API_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
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
  const response = await fetch(`${API_BASE}/whatsapp/bots`, { headers: { authorization: `Bearer ${token}` } });
  const result = await response.json();
  const bots = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
  if (!response.ok || !bots[0]?.id) throw new Error("No SendPulse WhatsApp bot is available");
  return botIdCache = String(bots[0].id);
}

function splitText(text: string, maxChars = 300): string[] {
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
    const end = boundary > maxChars * 0.55 ? boundary + (window.slice(boundary, boundary + 2) === ". " ? 1 : 0) : maxChars;
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
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { response: raw.slice(0, 300) }; }
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

export async function sendSendPulseText(phone: string, content: string): Promise<string> {
  let messageId: string | null = null;
  const chunks = splitText(content);
  for (let index = 0; index < chunks.length; index += 1) {
    const result: any = await sendChunk(phone, chunks[index]);
    messageId = String(result?.data?.message_id ?? result?.message_id ?? result?.id ?? messageId ?? "") || null;
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
