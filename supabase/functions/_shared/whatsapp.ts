import { db, setting } from "./db.ts";
import { downloadMetaMedia, sendMetaText } from "./meta.ts";
import { downloadSendPulseMedia, sendSendPulseText } from "./sendpulse.ts";

export async function whatsappProvider(): Promise<string> {
  return (await setting("whatsapp_provider")) ?? "sendpulse";
}

export async function sendWhatsAppText(phone: string, content: string): Promise<string> {
  const provider = await whatsappProvider();
  const { data: queued, error } = await db().from("agent_outbound_messages").insert({
    phone,
    content,
    provider,
  }).select("id").single();
  if (error) throw error;
  try {
    const messageId = provider === "meta"
      ? await sendMetaText(phone, content)
      : await sendSendPulseText(phone, content);
    await db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
    }).eq("id", queued.id);
    return messageId;
  } catch (sendError) {
    await db().from("agent_outbound_messages").update({
      status: "failed",
      error: sendError instanceof Error ? sendError.message : String(sendError),
    }).eq("id", queued.id);
    throw sendError;
  }
}

export async function downloadWhatsAppMedia(event: Record<string, unknown>) {
  if (String(event.provider ?? "meta") === "sendpulse" && event.media_url) {
    return await downloadSendPulseMedia(String(event.media_url));
  }
  return await downloadMetaMedia(String(event.media_id ?? ""));
}
