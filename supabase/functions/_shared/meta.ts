import { runtimeSecret } from "./db.ts";

export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyMetaSignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = await runtimeSecret("META_APP_SECRET");
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${bytesToHex(digest)}`;
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return mismatch === 0;
}

async function metaConfig() {
  const token = await runtimeSecret("META_ACCESS_TOKEN");
  const phoneNumberId = await runtimeSecret("META_PHONE_NUMBER_ID");
  const version = await runtimeSecret("META_GRAPH_API_VERSION") ?? "v23.0";
  if (!token || !phoneNumberId) throw new Error("Meta WhatsApp credentials are not configured");
  return { token, phoneNumberId, version };
}

// WhatsApp error 131047: more than 24 hours since the customer's last message,
// so only an approved template can be delivered.
export const META_OUTSIDE_WINDOW = 131047;

export class MetaApiError extends Error {
  constructor(readonly status: number, readonly code: number | null, detail: string) {
    super(`Meta ${status}${code ? ` (${code})` : ""}: ${detail.slice(0, 500)}`);
    this.name = "MetaApiError";
  }
}

async function sendMetaMessage(phone: string, message: Record<string, unknown>): Promise<string> {
  const { token, phoneNumberId, version } = await metaConfig();
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(phone),
      ...message,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = Number(result?.error?.code);
    throw new MetaApiError(response.status, Number.isFinite(code) ? code : null, JSON.stringify(result));
  }
  return result?.messages?.[0]?.id ?? `meta:${crypto.randomUUID()}`;
}

export async function sendMetaText(phone: string, content: string): Promise<string> {
  return await sendMetaMessage(phone, { type: "text", text: { preview_url: false, body: content } });
}

export async function sendMetaDocument(
  phone: string,
  document: { link: string; filename: string; caption?: string | null },
): Promise<string> {
  return await sendMetaMessage(phone, {
    type: "document",
    document: {
      link: document.link,
      filename: document.filename,
      ...(document.caption ? { caption: document.caption } : {}),
    },
  });
}

// Template parameters cannot contain newlines, tabs or more than four spaces in a row.
export function templateParameter(value: string): string {
  return value.replace(/\s*\n+\s*/g, " · ").replace(/\t/g, " ").replace(/ {4,}/g, "   ").trim()
    .slice(0, 1000);
}

export async function sendMetaTemplate(
  phone: string,
  template: {
    name: string;
    language: string;
    bodyParameters: string[];
    document?: { link: string; filename: string };
  },
): Promise<string> {
  return await sendMetaMessage(phone, {
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        ...(template.document
          ? [{ type: "header", parameters: [{ type: "document", document: template.document }] }]
          : []),
        ...(template.bodyParameters.length
          ? [{
            type: "body",
            parameters: template.bodyParameters.map((text) => ({ type: "text", text: templateParameter(text) })),
          }]
          : []),
      ],
    },
  });
}

export async function downloadMetaMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { token, version } = await metaConfig();
  const metadataResponse = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || !metadata?.url) throw new Error(`Unable to resolve Meta media ${mediaId}`);

  const mediaResponse = await fetch(metadata.url, { headers: { authorization: `Bearer ${token}` } });
  if (!mediaResponse.ok) throw new Error(`Unable to download Meta media ${mediaId}`);
  return {
    bytes: new Uint8Array(await mediaResponse.arrayBuffer()),
    mimeType: mediaResponse.headers.get("content-type") ?? metadata.mime_type ?? "application/octet-stream",
  };
}

// Internal notices (morning report, reminders) usually go to staff phones that have
// not written in the last 24 hours, so they fall back to the approved template.
export async function sendMetaTextOrTemplate(
  phone: string,
  content: string,
  template: { name: string | null; language: string },
): Promise<string> {
  try {
    return await sendMetaText(phone, content);
  } catch (error) {
    if (!(error instanceof MetaApiError) || error.code !== META_OUTSIDE_WINDOW || !template.name) throw error;
    return await sendMetaTemplate(phone, {
      name: template.name,
      language: template.language,
      bodyParameters: [content],
    });
  }
}
