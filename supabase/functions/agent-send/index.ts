import { db, isInternalRequest, json, setting } from "../_shared/db.ts";
import { errorMessage } from "../_shared/errors.ts";
import {
  META_OUTSIDE_WINDOW,
  MetaApiError,
  normalizePhone,
  sendMetaDocument,
  sendMetaTemplate,
  sendMetaText,
} from "../_shared/meta.ts";

// Manual WhatsApp sends from the CRM (chat and quote PDFs). Internal-only: the web
// server authenticates with the internal secret and never holds the Meta token.
const WINDOW_MS = 24 * 60 * 60_000;

type SendBody = {
  action?: "text" | "document";
  phone?: string;
  text?: string;
  file_url?: string;
  file_name?: string;
  caption?: string;
  client_name?: string;
  chatbot_message_id?: string;
};

async function windowOpen(phone: string): Promise<boolean> {
  const last = await db().from("agent_inbound_events").select("received_at").eq("phone", phone)
    .order("received_at", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw last.error;
  return Boolean(last.data && Date.now() - new Date(last.data.received_at).getTime() < WINDOW_MS);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({})) as SendBody;
  const phone = normalizePhone(String(body.phone ?? ""));
  if (phone.length < 10 || phone.length > 15) return json({ error: "invalid_phone" }, 400);

  const isDocument = body.action === "document";
  const text = String((isDocument ? body.caption : body.text) ?? "").trim();
  const link = String(body.file_url ?? "");
  const filename = String(body.file_name ?? "").trim() || "documento.pdf";
  if (isDocument) {
    // Only files from this project's own storage can be sent.
    if (!link.startsWith(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/`)) {
      return json({ error: "invalid_file_url" }, 400);
    }
    if (text.length > 1024) return json({ error: "caption_too_long" }, 400);
  } else if (body.action !== "text" || !text || text.length > 4096) {
    return json({ error: "invalid_message" }, 400);
  }

  const id = crypto.randomUUID();
  let rowId: number | null = null;
  try {
    const open = await windowOpen(phone);
    const template = await setting(isDocument ? "meta_quote_template" : "meta_followup_template");
    if (!open && !template) {
      return json({
        error: "outside_window",
        message:
          "Pasaron más de 24 horas desde el último mensaje del cliente y no hay una plantilla aprobada. WhatsApp sólo permite plantillas.",
      }, 409);
    }
    // attempts=5 keeps the outbox worker from ever resending a manual message.
    const row = await db().from("agent_outbound_messages").insert({
      phone,
      content: text || filename,
      message_type: isDocument ? "document" : "text",
      provider: "meta",
      kind: "crm_manual",
      status: "sending",
      attempts: 5,
      dedupe_key: `crm-manual:${body.chatbot_message_id ?? id}`,
      metadata: {
        logical_key: `crm-manual:${id}`,
        ...(body.chatbot_message_id ? { chatbot_message_id: body.chatbot_message_id } : {}),
        ...(isDocument ? { document: { link, filename } } : {}),
      },
    }).select("id").single();
    if (row.error) throw row.error;
    rowId = row.data.id;

    const language = (await setting("meta_template_language")) ?? "es_AR";
    const firstName = String(body.client_name ?? "").trim().split(/\s+/)[0] || "qué tal";
    let messageId: string;
    if (!open) {
      messageId = await sendMetaTemplate(phone, {
        name: template!,
        language,
        bodyParameters: isDocument ? [firstName] : [text],
        ...(isDocument ? { document: { link, filename } } : {}),
      });
    } else if (isDocument) {
      messageId = await sendMetaDocument(phone, { link, filename, caption: text || null });
    } else {
      messageId = await sendMetaText(phone, text);
    }
    const sent = await db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", rowId);
    if (!open && body.chatbot_message_id) {
      // The history must show what the customer really received, not the draft.
      const shown = isDocument
        ? `[Plantilla] Hola ${firstName}, te enviamos en el archivo adjunto el presupuesto que nos pediste. Si tenés dudas o querés modificar algo, respondé este mensaje.`
        : `[Plantilla] Hola, te escribimos de SolarPower por la consulta que nos hiciste. ${text} Podés responder este mensaje para continuar.`;
      const updated = await db().from("chatbot_messages").update({ content: shown }).eq("id", body.chatbot_message_id);
      if (updated.error) console.error("agent-send history", errorMessage(updated.error));
    }
    // Meta already has the message: never report a failure that would invite a resend.
    if (sent.error) console.error("agent-send receipt", errorMessage(sent.error));
    return json({
      success: true,
      provider: "meta",
      message_id: messageId,
      mode: !open ? "template" : isDocument ? "free_document" : "text",
    });
  } catch (error) {
    const message = errorMessage(error);
    if (rowId) {
      await db().from("agent_outbound_messages").update({
        status: "failed",
        error: message,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);
    }
    console.error("agent-send", message);
    const code = error instanceof MetaApiError ? error.code : null;
    return json({
      error: code === META_OUTSIDE_WINDOW ? "outside_window" : "send_failed",
      code,
      message,
    }, code === META_OUTSIDE_WINDOW ? 409 : 502);
  }
});
