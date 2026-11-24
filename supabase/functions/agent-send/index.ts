import { db, isInternalRequest, json, runtimeSecret, setting } from "../_shared/db.ts";
import { syncMessageToCrm } from "../_shared/crm-compat.ts";
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
  action?: "text" | "document" | "quote_preview" | "quote_send";
  presupuesto_id?: string;
  phone?: string;
  text?: string;
  file_url?: string;
  file_name?: string;
  caption?: string;
  client_name?: string;
  chatbot_message_id?: string;
};

const SITE = "https://www.solarpower.com.ar";

// Preview of the quote template: the real client PDF, sent only to the owner's phone.
// It changes nothing in the CRM and never reaches the client.
async function previewQuote(presupuestoId: string): Promise<Response> {
  const template = await setting("meta_quote_template");
  if (!template) return json({ error: "template_not_approved" }, 409);
  const owner = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
  if (!owner) return json({ error: "owner_phone_missing" }, 500);
  const found = await db().from("presupuestos").select("id,cliente_nombre,sistema_tipo,share_token,access_code")
    .eq("id", presupuestoId).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return json({ error: "quote_not_found" }, 404);
  const pdf = await fetch(`${SITE}/api/presupuesto/${found.data.share_token}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: found.data.access_code }),
  });
  if (!pdf.ok) return json({ error: "pdf_failed", status: pdf.status }, 502);
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  const filename = "Presupuesto SolarPower.pdf";
  const path = `presupuestos/pruebas/${presupuestoId}/${Date.now()}.pdf`;
  const uploaded = await db().storage.from("crm-lead-files").upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploaded.error) throw uploaded.error;
  const link = db().storage.from("crm-lead-files").getPublicUrl(path).data.publicUrl;
  const firstName = String(found.data.cliente_nombre ?? "").trim().split(/\s+/)[0] || "qué tal";
  const messageId = await sendMetaTemplate(owner, {
    name: template,
    language: (await setting("meta_template_language")) ?? "es_AR",
    bodyParameters: [firstName],
    document: { link, filename },
  });
  const row = await db().from("agent_outbound_messages").insert({
    phone: owner,
    content: `[Prueba de plantilla] ${firstName}`,
    message_type: "document",
    provider: "meta",
    provider_message_id: messageId,
    kind: "quote_preview",
    status: "sent",
    attempts: 5,
    sent_at: new Date().toISOString(),
    dedupe_key: `quote-preview:${messageId}`,
    metadata: { presupuesto_id: presupuestoId },
  });
  if (row.error) console.error("agent-send preview receipt", errorMessage(row.error));
  return json({ success: true, message_id: messageId, bytes: bytes.byteLength });
}

// Sends one quote to its lead with the approved template and leaves the CRM as the
// admin send route does. Each quote can only be sent once, even if called twice.
async function sendQuote(presupuestoId: string): Promise<Response> {
  const template = await setting("meta_quote_template");
  if (!template) return json({ error: "template_not_approved" }, 409);
  const found = await db().from("presupuestos").select("*").eq("id", presupuestoId).maybeSingle();
  if (found.error) throw found.error;
  const quote = found.data as Record<string, any> | null;
  if (!quote) return json({ error: "quote_not_found" }, 404);
  if (!["borrador", "aprobado"].includes(quote.estado)) return json({ error: "quote_already_sent" }, 409);
  const phone = normalizePhone(String(quote.lead_phone ?? ""));
  if (phone.length < 10 || phone.length > 15) return json({ error: "invalid_phone" }, 400);

  const lead = await db().from("chatbot_wa_contacts").select("phone,name,stage,assigned_to").eq("phone", phone)
    .maybeSingle();
  if (lead.error) throw lead.error;
  if (lead.data?.stage !== "pendiente_presupuesto") return json({ error: "lead_not_pending" }, 409);
  const earlier = await db().from("presupuestos").select("id").eq("lead_phone", quote.lead_phone).eq("estado", "enviado")
    .limit(1).maybeSingle();
  if (earlier.error) throw earlier.error;
  if (earlier.data) return json({ error: "lead_already_has_sent_quote" }, 409);

  const response = await fetch(`${SITE}/api/presupuesto/${quote.share_token}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: quote.access_code }),
  });
  if (!response.ok) return json({ error: "pdf_failed", status: response.status }, 502);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const firstName = String(quote.cliente_nombre ?? "").trim().split(/\s+/)[0] || "qué tal";
  const filename = "Presupuesto SolarPower.pdf";
  const path = `presupuestos/${phone}/${presupuestoId}/${Date.now()}-presupuesto.pdf`;
  const uploaded = await db().storage.from("crm-lead-files").upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploaded.error) throw uploaded.error;
  const link = db().storage.from("crm-lead-files").getPublicUrl(path).data.publicUrl;

  // The unique key is the lock: a second call stops here, before Meta.
  const claim = await db().from("agent_outbound_messages").insert({
    phone,
    content: `[Plantilla ${template}] ${firstName}`,
    message_type: "document",
    provider: "meta",
    kind: "crm_manual",
    status: "sending",
    attempts: 5,
    dedupe_key: `quote-send:${presupuestoId}`,
    metadata: { presupuesto_id: presupuestoId, logical_key: `quote-send:${presupuestoId}`, document: { link, filename } },
  }).select("id").single();
  if (claim.error) {
    if (claim.error.code === "23505") return json({ error: "quote_already_claimed" }, 409);
    throw claim.error;
  }

  let messageId: string;
  try {
    messageId = await sendMetaTemplate(phone, {
      name: template,
      language: (await setting("meta_template_language")) ?? "es_AR",
      bodyParameters: [firstName],
      document: { link, filename },
    });
  } catch (error) {
    const message = errorMessage(error);
    const uncertain = !(error instanceof MetaApiError);
    await db().from("agent_outbound_messages").update({
      status: uncertain ? "uncertain" : "failed",
      error: message,
      updated_at: new Date().toISOString(),
    }).eq("id", claim.data.id);
    await db().from("presupuestos").update({ send_error: message, updated_at: new Date().toISOString() })
      .eq("id", presupuestoId);
    return json({ error: uncertain ? "send_uncertain" : "send_failed", message }, 502);
  }

  // From here Meta already has it: record every step and report what did not save.
  const now = new Date().toISOString();
  const problems: string[] = [];
  const step = async (name: string, run: () => PromiseLike<{ error: unknown } | void>) => {
    try {
      const result = await run();
      if (result && result.error) throw result.error;
    } catch (error) {
      problems.push(`${name}: ${errorMessage(error)}`);
    }
  };
  const text =
    `[Plantilla] Hola ${firstName}, te enviamos en el archivo adjunto el presupuesto que nos pediste. Si tenés dudas o querés modificar algo, respondé este mensaje.`;
  const sourceId = `quote-send:${presupuestoId}`;
  await step("outbox", () =>
    db().from("agent_outbound_messages").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: now,
      updated_at: now,
    }).eq("id", claim.data.id).eq("status", "sending"));
  await step("quote", () =>
    db().from("presupuestos").update({
      estado: "enviado",
      aprobado_at: quote.aprobado_at ?? now,
      enviado_at: now,
      mensaje_enviado: text,
      pdf_file_url: link,
      pdf_file_name: filename,
      pdf_storage_bucket: "crm-lead-files",
      pdf_storage_path: path,
      sendpulse_response: { provider: "meta", mode: "template", message_id: messageId },
      send_error: null,
      updated_at: now,
    }).eq("id", presupuestoId));
  await step("file", () =>
    db().from("crm_lead_files").insert({
      source: "wa",
      contact_phone: phone,
      file_url: link,
      file_name: filename,
      mime_type: "application/pdf",
      file_size: bytes.byteLength,
      kind: "presupuesto",
      source_channel: "presupuestador",
      storage_bucket: "crm-lead-files",
      storage_path: path,
      metadata: { presupuesto_id: presupuestoId, estado: "enviado" },
    }));
  await step("chat", () =>
    syncMessageToCrm({
      phone,
      name: lead.data?.name ?? null,
      role: "assistant",
      content: text,
      sourceId,
      model: "quote-template",
      metadata: {
        sent_by_admin: true,
        admin_name: "Presupuestos",
        contact_actor: "solarpower",
        presupuesto_id: presupuestoId,
        wa_delivery: { provider: "meta", mode: "template", delivered: true, response: { message_id: messageId }, attempted_at: now, warning: null },
      },
      attachments: [{ type: "document", url: link, file_name: filename, mime_type: "application/pdf", presupuesto_id: presupuestoId }],
    }));
  // Lets a later "not delivered" status mark this chat message.
  await step("chat link", async () => {
    const chat = await db().from("chatbot_messages").select("id").contains("metadata", { agent_source_id: sourceId })
      .limit(1).maybeSingle();
    if (chat.error || !chat.data) return { error: chat.error ?? "chat message not found" };
    return await db().from("agent_outbound_messages").update({
      metadata: {
        presupuesto_id: presupuestoId,
        logical_key: sourceId,
        document: { link, filename },
        chatbot_message_id: chat.data.id,
      },
    }).eq("id", claim.data.id);
  });
  const state = { stage: "propuesta_enviada", human_mode: true, last_contact: now, updated_at: now };
  await step("lead", () =>
    db().from("chatbot_wa_contacts").update({ ...state, kanban_taken_by: null, last_activity_at: now })
      .eq("phone", phone).eq("stage", "pendiente_presupuesto"));
  await step("agent contact", () => db().from("agent_contacts").update(state).eq("phone", phone));
  await step("tasks", () =>
    db().from("crm_tasks").update({ estado: "completada", updated_at: now }).eq("lead_phone", phone)
      .ilike("titulo", "%enviar presupuesto%").in("estado", ["pendiente", "en_progreso", "revision"]));
  await step("follow-up", async () => {
    const due = new Date(Date.now() - 3 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 10);
    const open = await db().from("crm_tasks").select("id").eq("lead_phone", phone)
      .in("estado", ["pendiente", "en_progreso"]).ilike("titulo", "%seguimiento%").limit(1).maybeSingle();
    if (open.error) return { error: open.error };
    if (open.data) return await db().from("crm_tasks").update({ fecha_vencimiento: due, updated_at: now }).eq("id", open.data.id);
    return await db().from("crm_tasks").insert({
      titulo: `Seguimiento del presupuesto de ${quote.cliente_nombre || "el lead"}`,
      descripcion: "Presupuesto enviado hace una semana. Llamar o escribir para saber si lo revisó y despejar dudas.",
      estado: "pendiente",
      prioridad: "media",
      tipo: "seguimiento",
      lead_phone: phone,
      asignado_a: lead.data?.assigned_to ?? null,
      fecha_vencimiento: due,
    });
  });
  if (problems.length) console.error("agent-send quote", presupuestoId, problems.join(" | "));
  return json({ success: true, message_id: messageId, problems });
}

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
  if (body.action === "quote_preview" || body.action === "quote_send") {
    const presupuestoId = String(body.presupuesto_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(presupuestoId)) return json({ error: "invalid_quote" }, 400);
    try {
      return body.action === "quote_send" ? await sendQuote(presupuestoId) : await previewQuote(presupuestoId);
    } catch (error) {
      console.error("agent-send quote", errorMessage(error));
      return json({ error: "quote_failed", message: errorMessage(error) }, 502);
    }
  }
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
