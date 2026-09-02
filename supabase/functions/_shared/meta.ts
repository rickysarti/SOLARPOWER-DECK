import { db } from "./db.ts";

export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyMetaSignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get("META_APP_SECRET");
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

function metaConfig() {
  const token = Deno.env.get("META_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID");
  const version = Deno.env.get("META_GRAPH_API_VERSION") ?? "v23.0";
  if (!token || !phoneNumberId) throw new Error("Meta WhatsApp credentials are not configured");
  return { token, phoneNumberId, version };
}

export async function sendWhatsAppText(phone: string, content: string): Promise<string> {
  const { token, phoneNumberId, version } = metaConfig();
  const cleanPhone = normalizePhone(phone);
  const { data: queued, error: queueError } = await db().from("agent_outbound_messages").insert({
    phone: cleanPhone,
    content,
  }).select("id").single();
  if (queueError) throw queueError;

  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanPhone,
        type: "text",
        text: { preview_url: false, body: content },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Meta ${response.status}: ${JSON.stringify(result).slice(0, 500)}`);
    const messageId = result?.messages?.[0]?.id ?? null;
    await db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
    }).eq("id", queued.id);
    return messageId ?? "sent";
  } catch (error) {
    await db().from("agent_outbound_messages").update({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).eq("id", queued.id);
    throw error;
  }
}

export async function downloadMetaMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { token, version } = metaConfig();
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
