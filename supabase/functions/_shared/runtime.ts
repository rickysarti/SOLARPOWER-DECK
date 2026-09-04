import { db } from "./db.ts";
import { sanitizePlainText } from "./output.ts";

type SecretNamespace = "energy" | "newapp";
type SecretGetter = (name: string) => Promise<string | null>;

const secretCache = new Map<string, Promise<string | null>>();
const sendPulseTokens = new Map<string, { token: string; expiresAt: number }>();
const sendPulseBots = new Map<string, string>();

async function namespacedSecret(namespace: SecretNamespace, name: string): Promise<string | null> {
  const environmentValue = Deno.env.get(name);
  if (environmentValue) return environmentValue;
  const cacheKey = `${namespace}:${name}`;
  if (!secretCache.has(cacheKey)) {
    secretCache.set(
      cacheKey,
      (async () => {
        const { data, error } = await db().rpc(`${namespace}_get_runtime_secret`, { p_name: name });
        if (error) throw error;
        return typeof data === "string" && data ? data : null;
      })(),
    );
  }
  return await secretCache.get(cacheKey)!;
}

export const energySecret = (name: string) => namespacedSecret("energy", name);
export const newappSecret = (name: string) => namespacedSecret("newapp", name);

export async function runtimeSetting(
  table: "energy_analysis_settings" | "newapp_bot_settings",
  key: string,
): Promise<string | null> {
  const { data, error } = await db().from(table).select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export function safeEqual(expected: string | null, supplied: string | null): boolean {
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function isRuntimeRequest(
  req: Request,
  table: "energy_analysis_settings" | "newapp_bot_settings",
  header: string,
): Promise<boolean> {
  return safeEqual(await runtimeSetting(table, "cron_secret"), req.headers.get(header));
}

export class HttpError extends Error {
  status: number;
  body: string;

  constructor(label: string, status: number, body: string) {
    super(`${label} HTTP ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<T = any>(
  url: string,
  init: RequestInit = {},
  label = "request",
  timeoutMs = 20_000,
): Promise<{ data: T; response: Response }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new HttpError(label, response.status, raw);
    let data: T;
    try {
      data = (raw ? JSON.parse(raw) : {}) as T;
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
    return { data, response };
  } finally {
    clearTimeout(timeout);
  }
}

function splitText(text: string, maxChars = 3800): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
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

async function sendPulseToken(namespace: string, secret: SecretGetter, force = false): Promise<string> {
  const cached = sendPulseTokens.get(namespace);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.token;
  const clientId = await secret("SENDPULSE_API_ID");
  const clientSecret = await secret("SENDPULSE_API_SECRET");
  if (!clientId || !clientSecret) throw new Error(`${namespace}: SendPulse credentials are missing`);
  const { data } = await fetchJson<any>("https://api.sendpulse.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }, "SendPulse OAuth");
  if (!data?.access_token) throw new Error("SendPulse OAuth returned no access token");
  const token = String(data.access_token);
  sendPulseTokens.set(namespace, {
    token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000,
  });
  return token;
}

async function sendPulseBotId(namespace: string, secret: SecretGetter): Promise<string> {
  const cached = sendPulseBots.get(namespace);
  if (cached) return cached;
  const configured = await secret("SENDPULSE_BOT_ID");
  if (configured) {
    sendPulseBots.set(namespace, configured);
    return configured;
  }
  const token = await sendPulseToken(namespace, secret);
  const { data } = await fetchJson<any>("https://api.sendpulse.com/whatsapp/bots", {
    headers: { authorization: `Bearer ${token}` },
  }, "SendPulse bots");
  const bots = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  if (!bots[0]?.id) throw new Error("No SendPulse WhatsApp bot is available");
  const botId = String(bots[0].id);
  sendPulseBots.set(namespace, botId);
  return botId;
}

export async function sendPulseText(
  namespace: SecretNamespace,
  secret: SecretGetter,
  phone: string,
  content: string,
): Promise<string> {
  const normalizedPhone = phone.replace(/[^0-9]/g, "");
  if (!normalizedPhone) throw new Error("SendPulse destination phone is invalid");
  const cleanContent = sanitizePlainText(content);
  if (!cleanContent) throw new Error("SendPulse content became empty after sanitization");
  let messageId = "";
  for (const chunk of splitText(cleanContent)) {
    let attempt = 0;
    while (true) {
      try {
        const token = await sendPulseToken(namespace, secret, attempt > 0);
        const { data } = await fetchJson<any>("https://api.sendpulse.com/whatsapp/contacts/sendByPhone", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            phone: normalizedPhone,
            bot_id: await sendPulseBotId(namespace, secret),
            message: { type: "text", text: { body: chunk } },
          }),
        }, "SendPulse send");
        messageId = String(data?.data?.message_id ?? data?.message_id ?? data?.id ?? messageId);
        break;
      } catch (error) {
        if (
          attempt >= 2 || !(error instanceof HttpError) ||
          ![401, 408, 425, 429, 500, 502, 503, 504].includes(error.status)
        ) {
          throw error;
        }
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  return messageId || `sendpulse:${crypto.randomUUID()}`;
}

export function argentinaDate(offsetDays = 0, now = new Date()): string {
  const shifted = new Date(now.getTime() - 3 * 3_600_000 + offsetDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function argentinaHour(now = new Date()): number {
  return (now.getUTCHours() + 21) % 24;
}
