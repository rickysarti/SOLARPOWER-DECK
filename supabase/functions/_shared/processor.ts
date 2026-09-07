import { type AgentMessage, classifyContact, classifyMedia, type MediaClassification } from "./anthropic.ts";
import { processAgendaMessage } from "./agenda.ts";
import {
  contactCategory,
  conversationMissingFields,
  explicitAgentFields,
  isQuoteEligible,
  safeAgentPatch,
  taskFor,
} from "./agent-state.ts";
import { authorizedControlCommand, type ControlCommand } from "./control.ts";
import {
  applyContactState,
  ensureCrmContact,
  readCrmConversationHistory,
  syncMessageToCrm,
} from "./crm-compat.ts";
import { maybeSendDailyReport } from "./daily-report.ts";
import { db, runtimeSecret, setting } from "./db.ts";
import {
  type AgentCategory,
  type AgentDecision,
  type AgentFieldUpdates,
  asksAssistantIdentity,
  chargerScopeFromText,
  isStandaloneLighting,
  parseAgentDecision,
  replyViolations,
  requestsHumanRepresentative,
} from "./decision.ts";
import { errorMessage } from "./errors.ts";
import { normalizePhone } from "./meta.ts";
import { sanitizePlainText } from "./output.ts";
import { agentSystemPrompt, type ContactPromptData } from "./prompts.ts";
import { reconcileSendPulseInbound } from "./sendpulse-reconcile.ts";
import {
  CustomerReplySupersededError,
  downloadWhatsAppMedia,
  preparedWhatsAppText,
  retryDueOutboundMessages,
  sendWhatsAppText,
} from "./whatsapp.ts";
import { askClaude } from "./anthropic.ts";
import { enqueuePhone, inboundDebounceRemainingSeconds } from "./webhook.ts";

type Job = {
  id: string;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

type StoredMedia = { description: string; invoice: boolean; kind: string; confidence: string };

class InboundProcessingError extends Error {
  eventIds: string[];

  constructor(cause: unknown, eventIds: string[]) {
    super(errorMessage(cause));
    this.name = "InboundProcessingError";
    this.eventIds = eventIds;
  }
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

const SUPPORTED_MEDIA = new Set([
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
  return /\.pdf(?:\s|$)/i.test(String(event.content ?? ""))
    ? "application/pdf"
    : received || "application/octet-stream";
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

function safeFileName(event: Record<string, unknown>, extension: string): string {
  const content = String(event.content ?? "").trim();
  const candidate = /\.(?:pdf|jpe?g|png|webp|gif)$/i.test(content)
    ? content
    : `archivo_${event.id}.${extension}`;
  return candidate.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function fallbackMediaClassification(event: Record<string, unknown>): MediaClassification {
  const text = String(event.content ?? "");
  const invoiceEvidence =
    /\b(edenor|edesur|edelap|epec|epe|medidor|tarifa|kwh|factura\s+(?:de\s+)?(?:luz|electricidad|energ[ií]a)|boleta\s+(?:de\s+)?luz)\b/i
      .test(text);
  const cvEvidence = /\b(cv|curr[ií]culum|resume|hoja de vida)\b/i.test(text);
  const catalogEvidence = /\b(cat[aá]logo|lista de precios|ficha t[eé]cnica|productos)\b/i.test(text);
  return {
    kind: invoiceEvidence ? "invoice" : cvEvidence ? "cv" : catalogEvidence ? "catalog" : "other",
    confidence: invoiceEvidence || cvEvidence || catalogEvidence ? "medium" : "low",
    description: text || "Archivo recibido",
    evidence: invoiceEvidence || cvEvidence || catalogEvidence ? text.slice(0, 300) : "",
  };
}

export function isElectricityInvoiceMedia(
  event: Record<string, unknown>,
  mimeType: string,
  classification: MediaClassification | string | null,
): boolean {
  if (!SUPPORTED_MEDIA.has(mimeType)) return false;
  let parsed: MediaClassification | null = null;
  if (classification && typeof classification === "object") parsed = classification;
  if (typeof classification === "string") {
    try {
      parsed = JSON.parse(classification) as MediaClassification;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || parsed.kind !== "invoice" || !["high", "medium"].includes(parsed.confidence)) return false;
  const evidence = `${event.content ?? ""}\n${parsed.evidence ?? ""}\n${parsed.description ?? ""}`;
  return /\b(edenor|edesur|edelap|eden|edes|edea|epec|epe|cooperativa|medidor|tarifa|kwh|consumo|factura|boleta|servicio el[eé]ctrico)\b/i
    .test(evidence);
}

async function registerCrmFile(
  event: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
  classification: MediaClassification,
): Promise<boolean> {
  const extension = mediaExtension(mimeType);
  const filename = safeFileName(event, extension);
  const storagePath = `wa/${event.phone}/${event.id}-${filename}`;
  const existing = await db().from("crm_lead_files").select("id,kind")
    .eq("storage_bucket", "crm-lead-files").eq("storage_path", storagePath).limit(1).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data.kind === "invoice";

  const uploaded = await db().storage.from("crm-lead-files").upload(storagePath, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploaded.error && !uploaded.error.message.toLowerCase().includes("already exists")) {
    throw uploaded.error;
  }
  const publicUrl = db().storage.from("crm-lead-files").getPublicUrl(storagePath).data.publicUrl;
  const invoice = isElectricityInvoiceMedia(event, mimeType, classification);
  const inserted = await db().from("crm_lead_files").insert({
    source: "wa",
    contact_phone: event.phone,
    file_url: publicUrl,
    file_name: filename,
    mime_type: mimeType,
    file_size: bytes.byteLength,
    kind: invoice ? "invoice" : classification.kind === "cv" ? "cv" : "document",
    source_channel: "whatsapp",
    storage_bucket: "crm-lead-files",
    storage_path: storagePath,
    metadata: {
      source: "agent-supabase-v2",
      inbound_event_id: event.id,
      media_classification: classification,
      needs_review: !invoice && classification.confidence === "low",
    },
  });
  if (inserted.error) throw inserted.error;
  if (invoice) {
    await applyContactState({
      phone: String(event.phone),
      patch: { bill_received: true, agent_state: { consumption_evidence: "Factura eléctrica recibida" } },
    });
  }
  return invoice;
}

export async function recoverStoredInvoice(
  agentFileId: string,
): Promise<{ linked: boolean; agentFileId: string }> {
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
  let classification: MediaClassification | null = null;
  try {
    classification = JSON.parse(String(stored.data.analysis ?? ""));
  } catch {
    classification = null;
  }
  if (!isElectricityInvoiceMedia(event, mimeType, classification)) {
    throw new Error("Stored file is not classified as an electricity invoice");
  }
  const downloaded = await db().storage.from("agent-files").download(stored.data.storage_path);
  if (downloaded.error) throw downloaded.error;
  await registerCrmFile(
    event,
    new Uint8Array(await downloaded.data.arrayBuffer()),
    mimeType,
    classification!,
  );
  return { linked: true, agentFileId };
}

async function describeAndStoreMedia(event: Record<string, unknown>): Promise<StoredMedia> {
  const mediaId = String(event.media_id ?? event.media_url ?? "");
  if (!mediaId) {
    return {
      description: "[Archivo sin identificador de descarga]",
      invoice: false,
      kind: "other",
      confidence: "low",
    };
  }
  const downloaded = await downloadWhatsAppMedia(event);
  const { bytes } = downloaded;
  const mimeType = mediaMimeType(event, downloaded.mimeType);
  const extension = mediaExtension(mimeType);
  const path = `${event.phone}/${event.id}.${extension}`;
  const uploaded = await db().storage.from("agent-files").upload(path, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploaded.error && !uploaded.error.message.toLowerCase().includes("already exists")) {
    throw uploaded.error;
  }

  let classification = fallbackMediaClassification(event);
  if (SUPPORTED_MEDIA.has(mimeType)) {
    try {
      classification = await classifyMedia(
        mimeType,
        arrayBufferToBase64(bytes),
        safeFileName(event, extension),
      );
    } catch (error) {
      console.error("media classification fallback", errorMessage(error));
    }
  }
  const stored = await db().from("agent_files").upsert({
    contact_phone: event.phone,
    inbound_event_id: event.id,
    storage_path: path,
    file_name: safeFileName(event, extension),
    mime_type: mimeType,
    provider_media_id: mediaId,
    analysis: JSON.stringify(classification),
  }, { onConflict: "storage_path" });
  if (stored.error) throw stored.error;
  const invoice = SUPPORTED_MEDIA.has(mimeType)
    ? await registerCrmFile(event, bytes, mimeType, classification)
    : false;
  return {
    description: invoice
      ? "[Factura eléctrica recibida]"
      : `[Archivo recibido: ${classification.description}]`,
    invoice,
    kind: classification.kind,
    confidence: classification.confidence,
  };
}

async function internalPhoneSet(): Promise<Set<string>> {
  const values = await Promise.all([
    runtimeSecret("AGENT_RICARDO_PHONE"),
    runtimeSecret("AGENT_AGENDA_PHONE"),
    runtimeSecret("AGENT_GUILLERMO_PHONE"),
    runtimeSecret("AGENT_INTERNAL_PHONES"),
  ]);
  return new Set(
    values.flatMap((value) => String(value ?? "").split(/[;,\s]+/))
      .map((value) => normalizePhone(value))
      .filter(Boolean),
  );
}

async function executeControlCommand(command: ControlCommand): Promise<string> {
  if (command.type === "status") {
    return (await setting("bot_enabled")) === "true"
      ? "Bot activo. Tomás está respondiendo automáticamente."
      : "Bot pausado globalmente. Ningún cliente recibe respuestas automáticas.";
  }
  if (command.type === "global_mode") {
    const updated = await db().from("agent_settings").update({
      value: command.enabled ? "true" : "false",
      updated_at: new Date().toISOString(),
    }).eq("key", "bot_enabled");
    if (updated.error) throw updated.error;
    return command.enabled
      ? "Bot reactivado. Tomás vuelve a responder automáticamente."
      : "Bot pausado globalmente. Ningún cliente recibirá respuestas automáticas.";
  }
  await applyContactState({ phone: command.phone, patch: { human_mode: command.humanMode } });
  return command.humanMode
    ? `Contacto ${command.phone} agregado y puesto en modo humano.`
    : `Bot reactivado para el contacto ${command.phone}.`;
}

async function markEvents(
  ids: string[],
  disposition: string,
  processingError: string | null = null,
  processed = true,
): Promise<void> {
  const update = await db().from("agent_inbound_events").update({
    processed_at: processed ? new Date().toISOString() : null,
    disposition,
    disposition_at: new Date().toISOString(),
    processing_error: processingError,
  }).in("id", ids);
  if (update.error) throw update.error;
}

export function deterministicDecision(
  incoming: string,
  category: AgentCategory,
  isFirstConversation: boolean,
): AgentDecision | null {
  if (requestsHumanRepresentative(incoming)) {
    return {
      reply:
        "Por supuesto. Ya paso tu consulta a un representante para que continúe personalmente con vos por este mismo número.",
      classification: category,
      fields: explicitAgentFields(incoming),
      missingFields: [],
      completeForQuote: false,
      handoff: true,
      handoffReason: "El cliente pidió hablar con un representante",
      label: "Solicita representante",
    };
  }
  if (asksAssistantIdentity(incoming)) {
    return {
      reply:
        "Soy Tomás, el asistente virtual de SolarPower. Estoy acá para ayudarte con tu consulta y registrar la información para el equipo.",
      classification: category,
      fields: explicitAgentFields(incoming),
      missingFields: [],
      completeForQuote: false,
      handoff: false,
      handoffReason: null,
      label: null,
    };
  }
  if (isStandaloneLighting(incoming)) {
    return {
      reply:
        "SolarPower no vende ni instala luminarias. Si lo que buscás es un sistema solar para alimentar iluminación, podemos ayudarte con ese proyecto.",
      classification: "otro",
      fields: {},
      missingFields: [],
      completeForQuote: false,
      handoff: false,
      handoffReason: null,
      label: "Fuera de alcance",
    };
  }
  const chargerScope = chargerScopeFromText(incoming);
  if (chargerScope === "solo_cargador") {
    return {
      reply: "Para un cargador sin sistema solar, voy a pasarle tu contacto a un instalador especializado.",
      classification: "cargador_electrico",
      fields: { charger_scope: chargerScope, product_interest: "Cargador eléctrico sin sistema solar" },
      missingFields: [],
      completeForQuote: false,
      handoff: true,
      handoffReason: "Derivar a instalador de cargadores",
      label: "Derivación cargador eléctrico",
    };
  }
  if (chargerScope === "solar_y_cargador") {
    return null;
  }
  if (
    isFirstConversation &&
    /^\s*(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hol[aá])\s*[.!]?\s*$/i.test(incoming) &&
    category === "residencial"
  ) {
    return {
      reply:
        "Hola, soy Tomás de SolarPower. Gracias por escribirnos. ¿Hace cuánto venís pensando en instalar energía solar?",
      classification: "residencial",
      fields: {},
      missingFields: [],
      completeForQuote: false,
      handoff: false,
      handoffReason: null,
      label: null,
    };
  }
  return null;
}

export function repeatsPreviousAssistantReply(reply: string, history: AgentMessage[]): boolean {
  const previousAssistantReply = [...history].reverse().find((message) => message.role === "assistant")
    ?.content;
  return Boolean(
    previousAssistantReply &&
      sanitizePlainText(previousAssistantReply).toLocaleLowerCase("es") ===
        sanitizePlainText(reply).toLocaleLowerCase("es"),
  );
}

const CONVERSATION_FIELDS = [
  "nombre completo",
  "email",
  "localidad o provincia",
  "factura, consumo o lista de cargas",
  "techo o superficie",
  "tipo de conexión",
  "necesidad o producto",
] as const;

export function explicitFieldsFromConversation(history: AgentMessage[]): AgentFieldUpdates {
  const fields: AgentFieldUpdates = {};
  let expectedField: string | null = null;
  for (const message of history) {
    if (message.role === "assistant") {
      expectedField = CONVERSATION_FIELDS.find((field) => replyRequestsField(message.content, field)) ?? null;
      continue;
    }
    Object.assign(fields, explicitAgentFields(message.content, expectedField));
  }
  return fields;
}

export function isQuoteStatusFollowup(incoming: string): boolean {
  return /\b(?:no\s+(?:me\s+)?(?:lleg[oó]|llegaron|recib[ií])|todav[ií]a\s+(?:no|nada)|sigo\s+esperando|qued(?:aron|[oó])\s+en\s+(?:enviar|mandar)\w*|alg[uú]n\s+inconveniente|qu[eé]\s+pas[oó])\b/i
    .test(incoming) ||
    /\b(?:presupuesto|cotizaci[oó]n|propuestas?)\b.{0,55}\b(?:estado|demora|pendiente|esperando|enviar|mandar|llegar)\w*\b/i
      .test(incoming);
}

function previousAssistantReply(history: AgentMessage[]): string | null {
  return [...history].reverse().find((message) => message.role === "assistant")?.content ?? null;
}

export function repeatedAssistantQuestionField(
  reply: string,
  history: AgentMessage[],
): string | null {
  const previous = previousAssistantReply(history);
  if (!previous) return null;
  return CONVERSATION_FIELDS.find((field) =>
    replyRequestsField(reply, field) && replyRequestsField(previous, field)
  ) ?? null;
}

async function modelDecision(
  contact: ContactPromptData,
  category: AgentCategory,
  history: AgentMessage[],
  incoming: string,
): Promise<AgentDecision> {
  let correction: string | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await askClaude(agentSystemPrompt(contact, category, correction), history, 1200);
      const decision = parseAgentDecision(raw, category);
      const violations = replyViolations(decision.reply, incoming);
      if (repeatsPreviousAssistantReply(decision.reply, history)) {
        violations.push("repite exactamente la respuesta anterior");
      }
      const repeatedQuestion = repeatedAssistantQuestionField(decision.reply, history);
      if (repeatedQuestion) {
        violations.push(`repite la pregunta anterior sobre ${repeatedQuestion}`);
      }
      if (violations.length) {
        correction = violations.join("; ");
        lastError = correction;
        continue;
      }
      return decision;
    } catch (error) {
      lastError = errorMessage(error);
      correction = `La salida no fue JSON válido o incumplió el contrato. Corregila. Motivo: ${lastError}`;
    }
  }
  console.error("agent model response rejected; handing conversation to a human", lastError);
  return uncertaintyHandoffDecision(category, lastError);
}

export function uncertaintyHandoffDecision(category: AgentCategory, diagnostic = ""): AgentDecision {
  const diagnosticSuffix = diagnostic ? `: ${diagnostic.slice(0, 500)}` : "";
  return {
    reply:
      "Gracias por explicarlo. Para no hacerte repetir información ni interpretar mal tu caso, voy a pasar la conversación al equipo para que continúe personalmente por este medio.",
    classification: category,
    fields: {},
    missingFields: [],
    completeForQuote: false,
    handoff: true,
    handoffReason:
      `El asistente no pudo determinar una respuesta segura con suficiente confianza${diagnosticSuffix}`,
    label: "Revisión humana",
  };
}

export function academyCompletionDecision(contact: ContactPromptData): AgentDecision {
  const firstName = String(contact.name ?? "").trim().split(/\s+/)[0];
  const thanks = firstName ? `Gracias, ${firstName}.` : "Gracias.";
  const channel = contact.email ? "por email" : "por este medio";
  return {
    reply:
      `${thanks} La Academia Solar está en preparación; estamos terminando de armar los contenidos y la modalidad. Ya registramos tu interés y te vamos a avisar ${channel} cuando haya novedades.`,
    classification: "academia",
    fields: {},
    missingFields: [],
    completeForQuote: false,
    handoff: false,
    handoffReason: null,
    label: "Academia Solar",
  };
}

function contactWithPatch(
  contact: ContactPromptData,
  patch: Record<string, unknown>,
): ContactPromptData {
  const currentState = contact.agent_state && typeof contact.agent_state === "object"
    ? contact.agent_state
    : {};
  const patchState = patch.agent_state && typeof patch.agent_state === "object"
    ? patch.agent_state as Record<string, unknown>
    : {};
  return { ...contact, ...patch, agent_state: { ...currentState, ...patchState } };
}

function mergeContactPatches(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Record<string, unknown> {
  const firstState = first.agent_state && typeof first.agent_state === "object"
    ? first.agent_state as Record<string, unknown>
    : {};
  const secondState = second.agent_state && typeof second.agent_state === "object"
    ? second.agent_state as Record<string, unknown>
    : {};
  return { ...first, ...second, agent_state: { ...firstState, ...secondState } };
}

async function hasUnbatchedInbound(phone: string, batchIds: string[]): Promise<boolean> {
  const pending = await db().from("agent_inbound_events").select("id")
    .eq("phone", phone).is("processed_at", null).limit(Math.min(batchIds.length + 1, 1000));
  if (pending.error) throw pending.error;
  const batch = new Set(batchIds);
  return (pending.data ?? []).some((event) => !batch.has(String(event.id)));
}

export function replyRequestsField(reply: string, field: string): boolean {
  const patterns: Record<string, RegExp> = {
    "nombre completo": /\b(nombre completo|nombre y apellido|c[oó]mo te llam)/i,
    email: /\b(email|correo electr[oó]nico)\b/i,
    "localidad o provincia": /\b(localidad|provincia|d[oó]nde (?:ser[ií]a|est[aá]|viv[ií]s|se instalar))/i,
    "factura, consumo o lista de cargas": /\b(factura|consumo|kwh|kilowatt|monto|equipos|cargas)\b/i,
    "techo o superficie": /\b(techo|superficie|lugar.{0,25}paneles|paneles.{0,25}instalar)/i,
    "tipo de conexión": /\b(conexi[oó]n|monof[aá]sic|trif[aá]sic|sin red|off[ -]?grid)\b/i,
    "necesidad o producto":
      /\b(ahorro|cortes?|respaldo|independencia|bater[ií]a|on[ -]?grid|sistema solar|objetivo|motiv|qu[eé] (?:busc[aá]s|quer[eé]s lograr))/i,
  };
  return (patterns[field]?.test(reply) ?? true) && reply.includes("?");
}

async function processInbound(phone: string): Promise<void> {
  const eventsResult = await db().from("agent_inbound_events")
    .select("*").eq("phone", phone).is("processed_at", null).order("received_at");
  if (eventsResult.error) throw eventsResult.error;
  let events = eventsResult.data ?? [];
  if (!events.length) return;
  const latestReceivedAt = events.reduce(
    (latest, event) =>
      new Date(event.received_at).getTime() > new Date(latest).getTime() ? String(event.received_at) : latest,
    String(events[0].received_at),
  );
  if (inboundDebounceRemainingSeconds(latestReceivedAt) > 0) return;
  const allIds = events.map((event) => event.id);
  try {
    const admins = await internalPhoneSet();
    const commandEvents: typeof events = [];
    const commandResponses: string[] = [];
    for (const event of events) {
      const command = authorizedControlCommand(phone, String(event.content ?? ""), admins);
      if (!command) continue;
      commandEvents.push(event);
      commandResponses.push(await executeControlCommand(command));
    }
    if (commandResponses.length) {
      const commandIds = commandEvents.map((event) => event.id);
      const commandBatchId = `agent-control:${
        commandEvents.map((event) => event.provider_message_id ?? event.id).join(":")
      }`;
      const response = sanitizePlainText(commandResponses.join("\n"));
      const outboundId = await sendWhatsAppText(phone, response, {
        dedupeKey: `control:${commandBatchId}`,
        kind: "control_ack",
      });
      const commandName = commandEvents.map((event) => event.contact_name).find(Boolean) ?? null;
      const commandContact = await ensureCrmContact(phone, commandName);
      await db().from("agent_messages").upsert({
        contact_phone: phone,
        role: "assistant",
        content: response,
        provider_message_id: `assistant:${commandBatchId}`,
        model: "deterministic-control-v2",
      }, { onConflict: "provider_message_id", ignoreDuplicates: true });
      await syncMessageToCrm({
        phone,
        name: commandContact.name ?? null,
        role: "assistant",
        content: response,
        sourceId: outboundId,
        model: "deterministic-control-v2",
      });
      await markEvents(commandIds, "responded");
      const commandIdSet = new Set(commandIds);
      events = events.filter((event) => !commandIdSet.has(event.id));
      if (!events.length) return;
    }

    const ids = events.map((event) => event.id);
    const name = events.map((event) => event.contact_name).find(Boolean) ?? null;
    let contact = await ensureCrmContact(phone, name);

    const parts: string[] = [];
    for (const event of events) {
      if (event.content) parts.push(event.content);
      if (event.media_id || event.media_url) parts.push((await describeAndStoreMedia(event)).description);
    }
    const incoming = parts.join("\n").trim() || "[Mensaje sin texto]";
    const batchId = `agent-batch:${events.map((event) => event.provider_message_id ?? event.id).join(":")}`;
    const replyKey = `reply:${batchId}`;
    const messageInsert = await db().from("agent_messages").upsert({
      contact_phone: phone,
      role: "user",
      content: incoming,
      provider_message_id: batchId,
    }, { onConflict: "provider_message_id", ignoreDuplicates: true });
    if (messageInsert.error) throw messageInsert.error;
    await syncMessageToCrm({
      phone,
      name: contact.name ?? null,
      role: "user",
      content: incoming,
      sourceId: batchId,
    });

    contact = await ensureCrmContact(phone, name);
    if ((await setting("bot_enabled")) !== "true") {
      await markEvents(ids, "bot_disabled");
      return;
    }
    if (contact.human_mode) {
      await markEvents(ids, "human_mode");
      return;
    }

    const agendaPhone = normalizePhone(await runtimeSecret("AGENT_AGENDA_PHONE") ?? "");
    const ricardoPhone = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
    const guillermoPhone = normalizePhone(await runtimeSecret("AGENT_GUILLERMO_PHONE") ?? "");
    let responseText = "";
    let responseModel = "deterministic-v2";
    const prepared = await preparedWhatsAppText(replyKey);
    if (prepared) {
      responseText = prepared.content;
      responseModel = prepared.model ?? "prepared-outbox-v2";
    } else if ((agendaPhone && phone === agendaPhone) || (ricardoPhone && phone === ricardoPhone)) {
      responseText = sanitizePlainText(await processAgendaMessage(incoming));
      responseModel = "agenda-v2";
    } else if (guillermoPhone && phone === guillermoPhone) {
      await markEvents(ids, "internal_ignored");
      return;
    } else {
      let category = contactCategory(contact);
      const chargerScope = chargerScopeFromText(incoming);
      if (chargerScope) category = "cargador_electrico";
      if (!contact.tipo || contact.tipo === "otro") {
        category = chargerScope ? "cargador_electrico" : await classifyContact(incoming);
      }

      const storedContact = contact;
      const crmHistory = await readCrmConversationHistory(phone, 160);
      let history = crmHistory.map(({ role, content }) => ({ role, content })) as AgentMessage[];
      if (!history.length) {
        const historyResult = await db().from("agent_messages")
          .select("role,content").eq("contact_phone", phone).order("created_at", { ascending: false }).limit(
            100,
          );
        if (historyResult.error) throw historyResult.error;
        history = (historyResult.data ?? []).reverse().filter((row) =>
          row.role !== "system"
        ) as AgentMessage[];
      }
      const historicalFields = explicitFieldsFromConversation(history);
      const historyEvidence = history.filter((message) => message.role === "user")
        .map((message) => message.content).join("\n");
      const missingBeforeExplicitExtraction = conversationMissingFields(category, storedContact);
      const explicitFields = {
        ...historicalFields,
        ...explicitAgentFields(incoming, missingBeforeExplicitExtraction[0] ?? null),
      };
      const explicitPatch = safeAgentPatch(
        storedContact,
        explicitFields,
        category,
        historyEvidence || incoming,
      );
      contact = contactWithPatch(storedContact, explicitPatch) as typeof contact;

      const isFirstConversation = !history.some((row) => row.role === "assistant");
      const explicitHumanHandoff = requestsHumanRepresentative(incoming);
      const quoteAlreadyQueued = contact.stage === "pendiente_presupuesto" ||
        contact.label === "Pendiente enviar presupuesto";
      const pendingQuoteFollowup = quoteAlreadyQueued && isQuoteStatusFollowup(incoming);
      const academyAlreadyQueued = contact.label === "Academia Solar" && contact.notified_ricardo === true;
      const academyReady = category === "academia" &&
        conversationMissingFields(category, contact).length === 0;
      const deterministic = deterministicDecision(incoming, category, isFirstConversation);
      let decisionSource = "claude";
      let decision: AgentDecision;
      if (pendingQuoteFollowup) {
        decisionSource = "deterministic-quote-followup-v7";
        decision = {
          reply:
            "Disculpá la demora. Veo que tu propuesta sigue pendiente. Ya dejé el reclamo al equipo para que revise el estado y continúe personalmente por este medio.",
          classification: category,
          fields: {},
          missingFields: [],
          completeForQuote: false,
          handoff: true,
          handoffReason: "El cliente reclamó una propuesta pendiente",
          label: "Reclamo presupuesto pendiente",
        };
      } else if (deterministic) {
        decisionSource = "deterministic-policy-v7";
        decision = deterministic;
      } else if (academyReady && !academyAlreadyQueued) {
        decisionSource = "deterministic-academy-v7";
        decision = academyCompletionDecision(contact);
      } else {
        decision = await modelDecision(contact, category, history, incoming);
        if (decision.handoffReason?.startsWith("El asistente no pudo determinar")) {
          decisionSource = "deterministic-uncertainty-v7";
        }
      }
      category = decision.classification;
      const storedChargerScope = contact.agent_state?.charger_scope;
      const effectiveChargerScope = chargerScope ??
        (["solar_y_cargador", "solo_cargador", "desconocido"].includes(String(storedChargerScope))
          ? storedChargerScope as AgentDecision["fields"]["charger_scope"]
          : null);
      if (effectiveChargerScope === "solar_y_cargador") {
        category = "cargador_electrico";
        decision.handoff = false;
        if (/derivaci[oó]n/i.test(String(decision.label ?? ""))) decision.label = null;
      } else if (chargerScope && category !== "cargador_electrico") {
        category = "cargador_electrico";
      }
      const patch = safeAgentPatch(
        storedContact,
        {
          ...decision.fields,
          ...explicitFields,
          ...(effectiveChargerScope ? { charger_scope: effectiveChargerScope } : {}),
        },
        category,
        historyEvidence || incoming,
      );
      if (decision.label) patch.label = decision.label;
      contact = contactWithPatch(storedContact, patch) as typeof contact;

      const missing = conversationMissingFields(category, contact);
      const completeForQuote = isQuoteEligible(category, contact) && missing.length === 0;
      const academyComplete = category === "academia" && missing.length === 0;
      const chargerOnly = category === "cargador_electrico" &&
        contact.agent_state?.charger_scope === "solo_cargador";
      const needsFollowup = decision.handoff || chargerOnly ||
        ["cv", "soporte"].includes(category) || academyComplete || completeForQuote;
      const statePatch: Record<string, unknown> = {
        agent_state: { missing_fields: missing, last_decision_version: "v7" },
      };
      let taskTitle: string | null = null;
      let taskDescription: string | null = null;
      if (pendingQuoteFollowup) {
        statePatch.human_mode = true;
        statePatch.label = "Reclamo presupuesto pendiente";
        statePatch.notified_ricardo = true;
        taskTitle = "Revisar presupuesto pendiente";
        taskDescription = "El cliente informó que todavía no recibió la propuesta prometida.";
        responseText = decision.reply;
      } else if (explicitHumanHandoff || decision.handoff) {
        statePatch.human_mode = true;
        statePatch.label = explicitHumanHandoff
          ? "Solicita representante"
          : decision.label ?? "Revisión humana";
        statePatch.notified_ricardo = true;
        if (explicitHumanHandoff) {
          taskTitle = "Contactar cliente que pidió un representante";
          taskDescription = `El cliente pidió continuar con una persona. Motivo: ${
            decision.handoffReason ?? "solicitud explícita"
          }`;
        } else {
          ({ title: taskTitle, description: taskDescription } = taskFor(category, false, contact));
          taskDescription = `${taskDescription ?? "Continuar la conversación personalmente."} Motivo: ${
            decision.handoffReason ?? "el asistente indicó revisión humana"
          }`;
        }
        responseText = decision.reply;
      } else if (completeForQuote && !quoteAlreadyQueued) {
        statePatch.stage = "pendiente_presupuesto";
        statePatch.label = "Pendiente enviar presupuesto";
        statePatch.notified_ricardo = true;
        ({ title: taskTitle, description: taskDescription } = taskFor(category, true, contact));
        responseText =
          "Perfecto, con esto ya tenemos lo necesario. Voy a pasar la información al equipo de ingeniería para que preparen una propuesta personalizada. En cuanto esté lista te la compartimos.";
      } else if (academyComplete && !academyAlreadyQueued) {
        statePatch.label = "Academia Solar";
        statePatch.notified_ricardo = true;
        responseText = academyCompletionDecision(contact).reply;
      } else if ((completeForQuote && quoteAlreadyQueued) || (academyComplete && academyAlreadyQueued)) {
        statePatch.notified_ricardo = true;
        responseText = decision.reply;
      } else if (needsFollowup) {
        statePatch.notified_ricardo = true;
        if (decision.label) statePatch.label = decision.label;
        if (chargerOnly) statePatch.stage = "contactado";
        ({ title: taskTitle, description: taskDescription } = taskFor(category, false, contact));
        responseText = chargerOnly
          ? "Para un cargador sin sistema solar, voy a pasarle tu contacto a un instalador especializado."
          : decision.reply;
      } else {
        responseText = decision.reply;
      }
      const finalPatch = mergeContactPatches(patch, statePatch);
      if (await hasUnbatchedInbound(phone, ids)) {
        await markEvents(ids, "superseded_by_new_inbound");
        return;
      }
      contact = await applyContactState({
        phone,
        patch: finalPatch,
        taskTitle,
        taskDescription,
      });
      responseModel = decisionSource === "claude"
        ? await runtimeSecret("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001"
        : decisionSource;
    }

    responseText = sanitizePlainText(
      responseText || "Para poder seguir, ¿podés contarme qué necesitás resolver con energía solar?",
    );
    if (await hasUnbatchedInbound(phone, ids)) {
      await markEvents(ids, "superseded_by_new_inbound");
      return;
    }
    let outboundId: string;
    try {
      outboundId = await sendWhatsAppText(phone, responseText, {
        dedupeKey: replyKey,
        kind: "customer_reply",
        metadata: { inbound_event_ids: ids, response_model: responseModel },
      });
    } catch (error) {
      if (error instanceof CustomerReplySupersededError) {
        await markEvents(ids, "superseded_by_new_inbound");
        return;
      }
      throw error;
    }
    const assistantSourceId = `assistant:${batchId}`;
    const assistantInsert = await db().from("agent_messages").upsert({
      contact_phone: phone,
      role: "assistant",
      content: responseText,
      provider_message_id: assistantSourceId,
      model: responseModel,
    }, { onConflict: "provider_message_id", ignoreDuplicates: true });
    if (assistantInsert.error) throw assistantInsert.error;
    await syncMessageToCrm({
      phone,
      name: contact.name ?? null,
      role: "assistant",
      content: responseText,
      sourceId: outboundId || assistantSourceId,
      model: responseModel,
    });
    await markEvents(ids, "responded");
  } catch (error) {
    if (error instanceof InboundProcessingError) throw error;
    throw new InboundProcessingError(error, allIds);
  }
}

async function enqueueIfNeeded(phone: string): Promise<void> {
  const pending = await db().from("agent_inbound_events").select("received_at")
    .eq("phone", phone).is("processed_at", null).order("received_at", { ascending: false }).limit(1)
    .maybeSingle();
  if (pending.error) throw pending.error;
  if (!pending.data) return;
  await enqueuePhone(phone, inboundDebounceRemainingSeconds(pending.data.received_at));
}

async function finishJob(job: Job, error?: unknown): Promise<void> {
  const phone = normalizePhone(String(job.payload.phone ?? ""));
  if (!error) {
    const completed = await db().from("agent_jobs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      last_error: null,
    }).eq("id", job.id);
    if (completed.error) throw completed.error;
    if (phone) await enqueueIfNeeded(phone);
    return;
  }

  const attempts = Number(job.attempts ?? 0) + 1;
  const terminal = attempts >= 5;
  const message = errorMessage(error);
  const update = await db().from("agent_jobs").update({
    status: terminal ? "failed" : "pending",
    attempts,
    available_at: new Date(Date.now() + Math.min(15, 2 ** attempts) * 60_000).toISOString(),
    locked_at: null,
    last_error: message,
  }).eq("id", job.id);
  if (update.error) throw update.error;
  if (phone) {
    const eventPatch = {
      processing_attempts: attempts,
      processing_error: message,
      disposition: terminal ? "dead_letter" : "retrying",
      disposition_at: new Date().toISOString(),
      ...(terminal ? { processed_at: new Date().toISOString() } : {}),
    };
    const eventIds = error instanceof InboundProcessingError ? error.eventIds : [];
    const eventUpdate = eventIds.length
      ? await db().from("agent_inbound_events").update(eventPatch).in("id", eventIds).is("processed_at", null)
      : await db().from("agent_inbound_events").update(eventPatch).eq("phone", phone).is(
        "processed_at",
        null,
      );
    if (eventUpdate.error) throw eventUpdate.error;
    if (terminal) {
      await applyContactState({
        phone,
        patch: { human_mode: true, label: "Revisión humana" },
        taskTitle: "Responder mensaje con error",
        taskDescription: `El bot agotó los reintentos. Error: ${message}`,
      });
    }
  }
}

export async function processDueJobs(limit = 10): Promise<{ completed: number; failed: number }> {
  await db().from("agent_jobs").update({ status: "pending", locked_at: null })
    .eq("status", "processing").lt("locked_at", new Date(Date.now() - 5 * 60_000).toISOString());
  const claimed = await db().rpc("agent_claim_jobs", { p_limit: limit });
  if (claimed.error) throw claimed.error;

  const groups = new Map<string, Job[]>();
  for (const job of (claimed.data ?? []) as Job[]) {
    const phone = normalizePhone(String(job.payload.phone ?? ""));
    const key = phone || `invalid:${job.id}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const phoneQueues = [...groups.values()];
  let completed = 0;
  let failed = 0;
  let nextQueue = 0;
  const worker = async () => {
    while (nextQueue < phoneQueues.length) {
      const jobs = phoneQueues[nextQueue++];
      for (const job of jobs) {
        try {
          const phone = normalizePhone(String(job.payload.phone ?? ""));
          if (!phone) throw new Error("Job has no phone");
          await processInbound(phone);
          await finishJob(job);
          completed += 1;
        } catch (jobError) {
          console.error("agent job failed", job.id, errorMessage(jobError));
          await finishJob(job, jobError);
          failed += 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, phoneQueues.length) }, () => worker()));
  return { completed, failed };
}

export async function runScheduledTasks(): Promise<Record<string, unknown>> {
  let reconciliation: Record<string, unknown> = { skipped: "provider_not_sendpulse" };
  if ((await setting("whatsapp_provider")) === "sendpulse") {
    try {
      reconciliation = await reconcileSendPulseInbound();
    } catch (error) {
      console.error("sendpulse reconciliation failed", errorMessage(error));
      reconciliation = { error: errorMessage(error) };
    }
  }
  const [queue, outbound] = await Promise.all([processDueJobs(20), retryDueOutboundMessages(20)]);
  let reminders = 0;
  const ricardo = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
  if (ricardo && (await setting("bot_enabled")) === "true") {
    const now = new Date();
    const horizon = new Date(now.getTime() + 16 * 60_000);
    const events = await db().from("agent_agenda_events").select("*")
      .eq("status", "pendiente").eq("reminder_sent", false)
      .gte("date_time", now.toISOString()).lte("date_time", horizon.toISOString()).limit(20);
    if (events.error) throw events.error;
    for (const event of events.data ?? []) {
      const content = sanitizePlainText(
        `Recordatorio: ${event.title} a las ${
          new Date(event.date_time).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })
        }${event.location ? ` en ${event.location}` : ""}.`,
      );
      await sendWhatsAppText(ricardo, content, {
        dedupeKey: `agenda-reminder:${event.id}`,
        kind: "agenda_reminder",
      });
      await db().from("agent_agenda_events").update({ reminder_sent: true }).eq("id", event.id);
      reminders += 1;
    }
  }
  const dailyReport = await maybeSendDailyReport();
  return { ...queue, outbound, reconciliation, reminders, daily_report: dailyReport };
}
