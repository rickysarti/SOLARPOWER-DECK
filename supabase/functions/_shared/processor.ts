import { analyzeImage, askClaude, classifyContact, type AgentMessage } from "./anthropic.ts";
import { processAgendaMessage } from "./agenda.ts";
import { db, runtimeSecret, setting } from "./db.ts";
import { normalizePhone } from "./meta.ts";
import { downloadWhatsAppMedia, sendWhatsAppText } from "./whatsapp.ts";
import { agentSystemPrompt, notificationPrompt } from "./prompts.ts";
import { readCrmContact, syncActionToCrm, syncContactToCrm, syncMessageToCrm } from "./crm-compat.ts";

type Job = {
  id: string;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

function cleanResponse(raw: string): string {
  return raw.replace(/##(?:ETIQUETAR:[^#]+|NOTIFICAR_RICARDO|DERIVAR_HUMANO)##/gi, "").trim();
}

function marker(raw: string, name: string): boolean {
  return raw.toUpperCase().includes(`##${name.toUpperCase()}##`);
}

function extractLabel(raw: string): string | null {
  return raw.match(/##ETIQUETAR:([^#]+)##/i)?.[1]?.trim() ?? null;
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const INVOICE_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function mediaMimeType(event: Record<string, unknown>, downloaded: string): string {
  const declared = String(event.media_mime_type ?? "").split(";")[0].trim().toLowerCase();
  const received = downloaded.split(";")[0].trim().toLowerCase();
  if (received && received !== "application/octet-stream") return received;
  if (declared) return declared;
  return /\.pdf(?:\s|$)/i.test(String(event.content ?? "")) ? "application/pdf" : received || "application/octet-stream";
}

function mediaExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return extensions[mimeType] ?? mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

export function isElectricityInvoiceMedia(
  event: Record<string, unknown>,
  mimeType: string,
  analysis: string | null,
): boolean {
  if (!INVOICE_MIME_TYPES.has(mimeType)) return false;
  const evidence = `${event.content ?? ""}\n${analysis ?? ""}`;
  if (/\b(cv|curr[ií]culum|resume|hoja de vida)\b/i.test(evidence)) return false;
  if (/\b(edenor|edesur|edelap|epec|factura\s+(?:de\s+)?(?:luz|electricidad|el[eé]ctrica|energ[ií]a)|boleta\s+(?:de\s+)?(?:luz|electricidad|el[eé]ctrica|energ[ií]a)|servicio\s+el[eé]ctrico|tarifa\s+t[123])\b/i.test(evidence)) {
    return true;
  }
  return String(event.message_type ?? "") === "document" && mimeType === "application/pdf";
}

function safeFileName(event: Record<string, unknown>, extension: string): string {
  const content = String(event.content ?? "").trim();
  const candidate = /\.(?:pdf|jpe?g|png|webp|gif)$/i.test(content)
    ? content
    : `factura_${event.id}.${extension}`;
  return candidate.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

async function registerInvoice(
  event: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
  analysis: string | null,
): Promise<void> {
  const markedAgent = await db().from("agent_contacts").update({
    bill_received: true,
    updated_at: new Date().toISOString(),
  }).eq("phone", event.phone);
  if (markedAgent.error) throw markedAgent.error;
  const markedCrm = await db().from("chatbot_wa_contacts").update({
    bill_received: true,
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  }).eq("phone", event.phone);
  if (markedCrm.error) throw markedCrm.error;

  const extension = mediaExtension(mimeType);
  const filename = safeFileName(event, extension);
  const storagePath = `wa/${event.phone}/${event.id}-${filename}`;
  const existing = await db().from("crm_lead_files").select("id")
    .eq("storage_bucket", "crm-lead-files").eq("storage_path", storagePath).limit(1).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;

  const uploaded = await db().storage.from("crm-lead-files").upload(storagePath, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploaded.error && !uploaded.error.message.toLowerCase().includes("already exists")) throw uploaded.error;
  const publicUrl = db().storage.from("crm-lead-files").getPublicUrl(storagePath).data.publicUrl;
  const inserted = await db().from("crm_lead_files").insert({
    source: "wa",
    contact_phone: event.phone,
    file_url: publicUrl,
    file_name: filename,
    mime_type: mimeType,
    file_size: bytes.byteLength,
    kind: "invoice",
    source_channel: "whatsapp",
    storage_bucket: "crm-lead-files",
    storage_path: storagePath,
    metadata: {
      source: "agent-supabase",
      inbound_event_id: event.id,
      invoice_detection: analysis ?? event.content ?? null,
    },
  });
  if (inserted.error) throw inserted.error;
}

export async function recoverStoredInvoice(agentFileId: string): Promise<{ linked: boolean; agentFileId: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(agentFileId)) throw new Error("Invalid agent file id");
  const stored = await db().from("agent_files")
    .select("id,contact_phone,inbound_event_id,storage_path,file_name,mime_type,provider_media_id,analysis")
    .eq("id", agentFileId).maybeSingle();
  if (stored.error) throw stored.error;
  if (!stored.data) throw new Error("Agent file not found");
  const mimeType = String(stored.data.mime_type ?? "application/octet-stream").split(";")[0].toLowerCase();
  const event = {
    id: stored.data.inbound_event_id ?? stored.data.id,
    phone: stored.data.contact_phone,
    content: stored.data.file_name,
    message_type: mimeType === "application/pdf" ? "document" : "image",
    media_id: stored.data.provider_media_id,
  };
  if (!isElectricityInvoiceMedia(event, mimeType, stored.data.analysis)) {
    throw new Error("Stored file is not classified as an electricity invoice");
  }
  const downloaded = await db().storage.from("agent-files").download(stored.data.storage_path);
  if (downloaded.error) throw downloaded.error;
  await registerInvoice(
    event,
    new Uint8Array(await downloaded.data.arrayBuffer()),
    mimeType,
    stored.data.analysis,
  );
  return { linked: true, agentFileId };
}

async function describeAndStoreMedia(event: Record<string, unknown>): Promise<{ description: string; invoice: boolean }> {
  const mediaId = String(event.media_id ?? event.media_url ?? "");
  if (!mediaId) return { description: "[Archivo sin identificador de descarga]", invoice: false };
  const downloaded = await downloadWhatsAppMedia(event);
  const { bytes } = downloaded;
  const mimeType = mediaMimeType(event, downloaded.mimeType);
  const extension = mediaExtension(mimeType);
  const path = `${event.phone}/${event.id}.${extension}`;
  const { error: uploadError } = await db().storage.from("agent-files").upload(path, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError && !uploadError.message.toLowerCase().includes("already exists")) throw uploadError;

  let analysis: string | null = null;
  if (mimeType.startsWith("image/")) {
    analysis = await analyzeImage(mimeType, arrayBufferToBase64(bytes));
  }
  const stored = await db().from("agent_files").upsert({
    contact_phone: event.phone,
    inbound_event_id: event.id,
    storage_path: path,
    file_name: `${event.id}.${extension}`,
    mime_type: mimeType,
    provider_media_id: mediaId,
    analysis,
  }, { onConflict: "storage_path" });
  if (stored.error) throw stored.error;
  const invoice = isElectricityInvoiceMedia(event, mimeType, analysis);
  if (invoice) await registerInvoice(event, bytes, mimeType, analysis);
  return { description: analysis ?? `[Archivo recibido: ${mimeType}]`, invoice };
}

async function ensureContact(phone: string, name: string | null) {
  const crmContact = await readCrmContact(phone);
  const { data: existing, error } = await db().from("agent_contacts").select("*").eq("phone", phone).maybeSingle();
  if (error) throw error;
  if (existing) {
    const updates: Record<string, unknown> = { last_contact: new Date().toISOString() };
    if (name && !existing.name) updates.name = name;
    if (crmContact) {
      for (const key of ["name", "email", "label", "stage", "tipo", "bill_received", "roof_type", "connection_type", "locality", "product_interest", "notes", "notified_ricardo", "human_mode"]) {
        if (crmContact[key] !== undefined && crmContact[key] !== null) updates[key] = crmContact[key];
      }
    }
    const { data, error: updateError } = await db().from("agent_contacts").update(updates).eq("phone", phone).select("*").single();
    if (updateError) throw updateError;
    await syncContactToCrm(data);
    return data;
  }
  const { data, error: insertError } = await db().from("agent_contacts")
    .insert({ ...(crmContact ?? {}), phone, name: crmContact?.name || name }).select("*").single();
  if (insertError) throw insertError;
  await syncContactToCrm(data);
  return data;
}

async function notifyRicardo(contact: Record<string, unknown>, history: AgentMessage[]): Promise<void> {
  const ricardo = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
  if (!ricardo) return;
  const transcript = history.map((message) => `${message.role}: ${message.content}`).join("\n");
  const alert = await askClaude(
    "Redacta notificaciones internas breves y concretas para SolarPower.",
    [{
      role: "user",
      content: notificationPrompt(String(contact.name ?? "") || null, String(contact.phone), transcript),
    }],
    350,
  );
  try {
    await sendWhatsAppText(ricardo, alert);
  } catch (error) {
    await db().from("agent_pending_notifications").insert({
      phone: ricardo,
      message: alert,
      last_error: error instanceof Error ? error.message : String(error),
    });
  }
  const action = {
    contact_phone: contact.phone,
    contact_name: contact.name ?? null,
    action_type: "call",
    description: alert,
  };
  await db().from("agent_pending_actions").insert({
    contact_phone: action.contact_phone,
    action_type: action.action_type,
    description: action.description,
  });
  await syncActionToCrm(action);
}

async function processInbound(phone: string): Promise<void> {
  const { data: events, error } = await db().from("agent_inbound_events")
    .select("*").eq("phone", phone).is("processed_at", null).order("received_at").limit(20);
  if (error) throw error;
  if (!events?.length) return;

  const name = events.map((event) => event.contact_name).find(Boolean) ?? null;
  const contact = await ensureContact(phone, name);
  const parts: string[] = [];
  let invoiceReceived = false;
  for (const event of events) {
    if (event.content) parts.push(event.content);
    if (event.media_id || event.media_url) {
      const media = await describeAndStoreMedia(event);
      parts.push(media.description);
      invoiceReceived ||= media.invoice;
    }
  }
  if (invoiceReceived && !contact.bill_received) {
    contact.bill_received = true;
    const updated = await db().from("agent_contacts").update({ bill_received: true, updated_at: new Date().toISOString() })
      .eq("phone", phone);
    if (updated.error) throw updated.error;
    await syncContactToCrm(contact);
  }
  const incoming = parts.join("\n").trim() || "[Mensaje sin texto]";

  const batchId = `agent-batch:${events.map((event) => event.provider_message_id ?? event.id).join(":")}`;
  await db().from("agent_messages").upsert({
    contact_phone: phone,
    role: "user",
    content: incoming,
    provider_message_id: batchId,
  }, { onConflict: "provider_message_id" });
  await syncMessageToCrm({ phone, name: contact.name ?? null, role: "user", content: incoming, sourceId: batchId });
  const processedAt = new Date().toISOString();

  if ((await setting("bot_enabled")) !== "true" || contact.human_mode) {
    await db().from("agent_inbound_events").update({ processed_at: processedAt }).in("id", events.map((event) => event.id));
    return;
  }

  const agendaPhone = normalizePhone(await runtimeSecret("AGENT_AGENDA_PHONE") ?? "");
  const ricardoPhone = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
  const guillermoPhone = normalizePhone(await runtimeSecret("AGENT_GUILLERMO_PHONE") ?? "");
  let responseText: string;
  if ((agendaPhone && phone === agendaPhone) || (ricardoPhone && phone === ricardoPhone)) {
    const control = incoming.match(/^\s*(tomar|liberar)\s+\+?(\d{8,15})\s*$/i);
    if (control) {
      const target = normalizePhone(control[2]);
      const humanMode = control[1].toLowerCase() === "tomar";
      await ensureContact(target, null);
      await db().from("agent_contacts").update({ human_mode: humanMode }).eq("phone", target);
      const { data: updated } = await db().from("agent_contacts").select("*").eq("phone", target).single();
      if (updated) await syncContactToCrm(updated);
      responseText = humanMode ? `Chat ${target} tomado por humano.` : `Bot liberado para ${target}.`;
    } else {
      responseText = await processAgendaMessage(incoming);
    }
  } else if (guillermoPhone && phone === guillermoPhone) {
    await db().from("agent_inbound_events").update({ processed_at: processedAt }).in("id", events.map((event) => event.id));
    return;
  } else {
    let tipo = contact.tipo;
    if (!tipo) {
      tipo = await classifyContact(incoming);
      await db().from("agent_contacts").update({ tipo }).eq("phone", phone);
      contact.tipo = tipo;
      await syncContactToCrm(contact);
    }

    const { data: rows, error: historyError } = await db().from("agent_messages")
      .select("role,content").eq("contact_phone", phone).order("created_at", { ascending: false }).limit(30);
    if (historyError) throw historyError;
    const history = (rows ?? []).reverse().filter((row) => row.role !== "system") as AgentMessage[];
    const raw = await askClaude(agentSystemPrompt(contact), history, 900);
    responseText = cleanResponse(raw);

    const updates: Record<string, unknown> = {};
    const label = extractLabel(raw);
    if (label) updates.label = label;
    if (marker(raw, "DERIVAR_HUMANO")) updates.human_mode = true;
    if (Object.keys(updates).length) {
      const { data: updated } = await db().from("agent_contacts").update(updates).eq("phone", phone).select("*").single();
      if (updated) await syncContactToCrm(updated);
    }
    if (marker(raw, "NOTIFICAR_RICARDO") || marker(raw, "DERIVAR_HUMANO")) {
      await notifyRicardo(contact, history);
    }
  }

  if (!responseText) responseText = "Gracias por escribirnos. Un asesor revisara tu consulta.";
  const outboundId = await sendWhatsAppText(phone, responseText);
  await db().from("agent_messages").insert({
    contact_phone: phone,
    role: "assistant",
    content: responseText,
    model: await runtimeSecret("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001",
  });
  await syncMessageToCrm({
    phone,
    name: contact.name ?? null,
    role: "assistant",
    content: responseText,
    sourceId: outboundId,
    model: await runtimeSecret("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001",
  });
  await db().from("agent_inbound_events").update({ processed_at: processedAt, processing_error: null })
    .in("id", events.map((event) => event.id));
}

async function finishJob(job: Job, error?: unknown): Promise<void> {
  if (!error) {
    await db().from("agent_jobs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      last_error: null,
    }).eq("id", job.id);
    return;
  }

  const attempts = job.attempts + 1;
  const failed = attempts >= 5;
  await db().from("agent_jobs").update({
    status: failed ? "failed" : "pending",
    attempts,
    available_at: new Date(Date.now() + Math.min(15, 2 ** attempts) * 60_000).toISOString(),
    last_error: error instanceof Error ? error.message : String(error),
  }).eq("id", job.id);
}

export async function processDueJobs(limit = 10): Promise<{ completed: number; failed: number }> {
  await db().from("agent_jobs").update({ status: "pending", locked_at: null })
    .eq("status", "processing").lt("locked_at", new Date(Date.now() - 5 * 60_000).toISOString());

  const { data: jobs, error } = await db().from("agent_jobs").select("id,dedupe_key,payload,attempts")
    .eq("status", "pending").lte("available_at", new Date().toISOString()).order("available_at").limit(limit);
  if (error) throw error;

  let completed = 0;
  let failed = 0;
  for (const job of (jobs ?? []) as Job[]) {
    const { data: locked } = await db().from("agent_jobs").update({
      status: "processing",
      locked_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "pending").select("id").maybeSingle();
    if (!locked) continue;

    try {
      const phone = normalizePhone(String(job.payload.phone ?? ""));
      if (!phone) throw new Error("Job has no phone");
      await processInbound(phone);
      await finishJob(job);
      completed += 1;
    } catch (jobError) {
      console.error("agent job failed", job.id, jobError);
      await finishJob(job, jobError);
      failed += 1;
    }
  }
  return { completed, failed };
}

export async function runScheduledTasks(): Promise<Record<string, number>> {
  const queue = await processDueJobs(20);
  let reminders = 0;
  let notifications = 0;
  const ricardo = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");

  if (ricardo && (await setting("bot_enabled")) === "true") {
    const now = new Date();
    const horizon = new Date(now.getTime() + 16 * 60_000);
    const { data: events } = await db().from("agent_agenda_events").select("*")
      .eq("status", "pendiente").eq("reminder_sent", false)
      .gte("date_time", now.toISOString()).lte("date_time", horizon.toISOString()).limit(20);
    for (const event of events ?? []) {
      await sendWhatsAppText(ricardo, `Recordatorio: ${event.title} a las ${new Date(event.date_time).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}${event.location ? ` en ${event.location}` : ""}.`);
      await db().from("agent_agenda_events").update({ reminder_sent: true }).eq("id", event.id);
      reminders += 1;
    }

    const { data: pending } = await db().from("agent_pending_notifications").select("*")
      .eq("sent", false).is("archived_at", null).order("created_at").limit(10);
    for (const item of pending ?? []) {
      try {
        await sendWhatsAppText(item.phone, item.message);
        await db().from("agent_pending_notifications").update({ sent: true, sent_at: new Date().toISOString(), last_error: null }).eq("id", item.id);
        notifications += 1;
      } catch (error) {
        await db().from("agent_pending_notifications").update({ last_error: error instanceof Error ? error.message : String(error) }).eq("id", item.id);
      }
    }
  }
  return { ...queue, reminders, notifications };
}
