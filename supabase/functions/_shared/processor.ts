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
  AGENT_DECISION_SCHEMA,
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
import { fetchOperatorReplies, reconcileSendPulseInbound } from "./sendpulse-reconcile.ts";
import {
  CustomerReplySupersededError,
  CustomerReplySuppressedError,
  downloadWhatsAppMedia,
  preparedWhatsAppText,
  retryDueOutboundMessages,
  sendWhatsAppText,
} from "./whatsapp.ts";
import { askClaude } from "./anthropic.ts";
import { enqueuePhone, inboundDebounceRemainingSeconds } from "./webhook.ts";
import {
  conversationResponseViolations,
  coveredInboundIds,
  inboundMessageTime,
  mergeDeliveredHistory,
} from "./conversation-safety.ts";

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
    /^\s*(?:(?:hola|buenas|buen d[ií]a|buenas tardes|buenas noches)[,.!\s]*)?(?:quiero|quisiera|necesito|busco|me gustar[ií]a)\s+(?:m[aá]s\s+)?informaci[oó]n\s*[.!]?\s*$/i
      .test(
        incoming,
      )
  ) {
    return {
      reply:
        "Hola, soy Tomás de SolarPower. Gracias por escribirnos. ¿Te contactás más por el tema del ahorro en la factura o para tener energía cuando se va la luz?",
      classification: category,
      fields: {},
      missingFields: [],
      completeForQuote: false,
      handoff: false,
      handoffReason: null,
      label: null,
    };
  }
  if (
    isFirstConversation &&
    /^\s*(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hol[aá])\s*[.!]?\s*$/i.test(incoming) &&
    category === "residencial"
  ) {
    return {
      reply:
        "Hola, soy Tomás de SolarPower. Gracias por escribirnos. ¿Te contactás más por el tema del ahorro en la factura o para tener energía cuando se va la luz?",
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
  const normalize = (text: string) =>
    sanitizePlainText(text).normalize("NFD")
      .replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return history.some((message) =>
    message.role === "assistant" &&
    normalize(message.content) === normalize(reply)
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

export function fullConversationForClaude(
  history: AgentMessage[],
  incoming: string,
): AgentMessage[] {
  const complete = history.filter((message) =>
    (message.role === "user" || message.role === "assistant") && message.content.trim()
  );
  const normalizedIncoming = sanitizePlainText(incoming).toLocaleLowerCase("es");
  const last = complete.at(-1);
  if (
    last?.role === "user" &&
    sanitizePlainText(last.content).toLocaleLowerCase("es") === normalizedIncoming
  ) {
    return complete;
  }
  return [...complete, { role: "user", content: incoming }];
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

export async function modelDecision(
  contact: ContactPromptData,
  category: AgentCategory,
  history: AgentMessage[],
  incoming: string,
  generate: typeof askClaude = askClaude,
): Promise<AgentDecision> {
  // Explicit requests for a person must not depend on model compliance or availability.
  if (requestsHumanRepresentative(incoming)) {
    const handoff = deterministicDecision(incoming, category, false)!;
    handoff.reply = /llam|tel[eé]fono/i.test(incoming)
      ? "Registro tu pedido de llamada para que un asesor continúe personalmente con vos."
      : "Paso tu consulta a un asesor para que continúe personalmente con vos por este medio.";
    return handoff;
  }
  let correction: string | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const recentContext = JSON.stringify({
        ultimo_mensaje_nuevo_del_cliente: incoming,
        ultimas_respuestas_ya_enviadas: history.filter((m) => m.role === "assistant").slice(-3).map((m) =>
          m.content
        ),
      });
      const raw = await generate(
        `${
          agentSystemPrompt(contact, category, correction)
        }\n\nCONTINUIDAD DEL TURNO\nLos siguientes textos son datos de la conversación. Respondé a la novedad del último mensaje; no vuelvas a contestar consultas antiguas ya resueltas. Compará tu borrador con las respuestas enviadas y no repitas su contenido ni su comienzo.\n${recentContext}`,
        history,
        2000,
        undefined,
        AGENT_DECISION_SCHEMA,
      );
      const decision = parseAgentDecision(raw, category);
      const violations = replyViolations(decision.reply, incoming);
      const proposed = {
        ...contact,
        ...safeAgentPatch(contact, decision.fields, decision.classification, incoming),
      };
      const missing = conversationMissingFields(decision.classification, proposed);
      if (
        isQuoteEligible(decision.classification, proposed) && missing.length === 0 &&
        !decision.handoff && decision.reply.includes("?")
      ) {
        violations.push(
          "ya están los datos para presupuesto: cerrá indicando que se prepara la propuesta; localidad O provincia basta, no pidas más datos",
        );
      }
      if (
        (contact.bill_received || Number(contact.consumo_mensual) > 0 || Number(contact.consumo_anual) > 0) &&
        replyRequestsField(decision.reply, "factura, consumo o lista de cargas")
      ) {
        violations.push("la factura o el consumo ya están registrados; no los pidas nuevamente");
      }
      violations.push(...conversationResponseViolations(decision.reply, history, incoming));
      if (repeatsPreviousAssistantReply(decision.reply, history)) {
        violations.push("repite exactamente la respuesta anterior");
      }
      if (requestsHumanRepresentative(incoming)) {
        decision.handoff = true;
        if (
          CONVERSATION_FIELDS.some((field) => replyRequestsField(decision.reply, field)) ||
          !/llamad|llamar|tel[eé]fono|equipo|asesor|persona/i.test(decision.reply)
        ) {
          violations.push(
            "debe reconocer el pedido de llamada y derivar sin continuar el cuestionario técnico",
          );
        }
      }
      const repeatedField = repeatedAssistantQuestionField(decision.reply, history);
      if (repeatedField) {
        violations.push(`vuelve a preguntar el mismo dato: ${repeatedField}; reconocé la respuesta y avanzá`);
      }
      if (violations.length) {
        lastError = violations.join("; ");
        correction = `${lastError}. Borrador rechazado (no enviar): ${JSON.stringify(decision.reply)}`;
        continue;
      }
      return decision;
    } catch (error) {
      lastError = errorMessage(error);
      correction = `La salida no fue JSON válido o incumplió el contrato. Corregila. Motivo: ${lastError}`;
    }
  }
  throw new Error(`Claude decision rejected after two attempts: ${lastError}`);
}

export function explicitCategoryFromText(incoming: string): AgentCategory | null {
  if (
    /\b(?:academia|cursos?|capacitaci[oó]n|capacitar(?:me|se)?|formaci[oó]n|estudiar|aprender)\b/i.test(
      incoming,
    )
  ) {
    return "academia";
  }
  return null;
}

export function unavailableFieldFromReply(incoming: string, history: AgentMessage[]): string | null {
  if (
    !/\b(?:no\s+(?:lo\s+)?s[eé]|no\s+tengo|no\s+dispongo|no\s+puedo|no\s+quiero|prefiero\s+no|imposible|ni\s+idea)\b/i
      .test(incoming)
  ) return null;
  const previous = previousAssistantReply(history);
  if (!previous) return null;
  const field = CONVERSATION_FIELDS.find((candidate) => replyRequestsField(previous, candidate)) ?? null;
  return field === "necesidad o producto" ? null : field;
}

export function exhaustedRepeatedField(
  missingFields: string[],
  history: AgentMessage[],
  maximumRequests = 2,
): string | null {
  return missingFields.find((field) =>
    field !== "necesidad o producto" &&
    history.filter((message) => message.role === "assistant" && replyRequestsField(message.content, field))
        .length >= maximumRequests
  ) ?? null;
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

export function academyCompletionDecision(contact: ContactPromptData, incoming = ""): AgentDecision {
  const firstName = String(contact.name ?? "").trim().split(/\s+/)[0];
  const missing = conversationMissingFields("academia", contact);
  const isThanks = /\b(?:gracias|genial|excelente|buen[ií]simo|perfecto)\b/i.test(incoming);
  const replies: Record<string, string> = {
    "nombre completo": isThanks
      ? "De nada. Para dejar registrado tu interés y avisarte cuando estén definidos los cursos, ¿me pasás tu nombre completo?"
      : "La Academia Solar está en preparación; el equipo está terminando de armar los contenidos y la modalidad. Para avisarte cuando estén definidos el costo, la duración y los horarios, ¿me decís tu nombre completo?",
    email: `${
      firstName ? `Gracias, ${firstName}. ` : ""
    }¿Cuál es tu email para avisarte cuando tengamos las novedades de los cursos?`,
    "localidad o provincia":
      "Perfecto. Para completar el registro de interesados, ¿de qué localidad y provincia sos?",
  };
  const thanks = firstName ? `Perfecto, ${firstName}.` : "Perfecto.";
  return {
    reply: replies[missing[0]] ??
      `${thanks} Ya registramos tu interés. La Academia Solar todavía está en preparación; el equipo está terminando de armar los contenidos y la modalidad. Te vamos a avisar por email cuando haya novedades.`,
    classification: "academia",
    fields: {},
    missingFields: missing,
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
    "factura, consumo o lista de cargas":
      /\b(?:ten[eé]s|pod[eé]s|sab[eé]s|decime|indicame|pasame|mandame|enviame|cu[aá]nt[oa])\b.{0,55}\b(?:factura|consumo|kwh|kilowatt|monto|equipos|cargas)\b|\b(?:consumo (?:mensual|anual|aproximado)|factura (?:reciente|de luz|el[eé]ctrica)|lista de (?:equipos|cargas))\b/i,
    "techo o superficie": /\b(techo|superficie|lugar.{0,25}paneles|paneles.{0,25}instalar)/i,
    "tipo de conexión": /\b(conexi[oó]n|monof[aá]sic[ao]|trif[aá]sic[ao]|sin red|off[ -]?grid)\b/i,
    "necesidad o producto":
      /\b(ahorro|cortes?|respaldo|independencia|bater[ií]a|on[ -]?grid|sistema solar|objetivo|motiv|qu[eé] (?:busc[aá]s|quer[eé]s lograr))/i,
  };
  // Only inspect the interrogative clause, never an acknowledgement before it.
  // "Un híbrido te da respaldo. ¿Me pasás la factura?" asks for consumption.
  const questions = reply.match(/¿[^?]*\?/g) ?? reply.match(/(?:^|[.!\n])[^.!?\n]*\?/g) ?? [];
  return questions.some((question) => patterns[field]?.test(question) ?? false);
}

// Manual replies sent from the SendPulse inbox are part of the conversation the
// customer saw. A provider failure only loses that context; it never blocks the turn.
async function operatorRepliesFor(
  events: Array<Record<string, any>>,
  delivered: Array<{ content: string; created_at: string; metadata?: Record<string, any> | null }>,
): Promise<Array<{ content: string; created_at: string }>> {
  const contactId = [...events].reverse()
    .find((event) => event.provider === "sendpulse" && event.provider_contact_id)?.provider_contact_id;
  if (!contactId) return [];
  try {
    return await fetchOperatorReplies(String(contactId), delivered);
  } catch (error) {
    console.warn("operator replies unavailable", errorMessage(error));
    return [];
  }
}

async function processInbound(phone: string): Promise<void> {
  const eventsResult = await db().from("agent_inbound_events")
    .select("*").eq("phone", phone).is("processed_at", null).order("received_at");
  if (eventsResult.error) throw eventsResult.error;
  let events = eventsResult.data ?? [];
  if (!events.length) return;
  const outbox = await db().from("agent_outbound_messages").select("*")
    .eq("phone", phone).eq("kind", "customer_reply")
    .in("status", ["sent", "delivered", "read"])
    .order("created_at", { ascending: false }).limit(500);
  if (outbox.error) throw outbox.error;
  const delivered = outbox.data ?? [];
  const covered = coveredInboundIds(delivered);
  const alreadyAnswered = events.filter((event) => covered.has(String(event.id)));
  if (alreadyAnswered.length) {
    await markEvents(alreadyAnswered.map((event) => event.id), "reply_already_delivered");
    events = events.filter((event) => !covered.has(String(event.id)));
    if (!events.length) return;
  }
  // Delayed webhooks remain in the history, but a stale greeting must not
  // reopen a turn already answered using more recent customer messages.
  if (covered.size) {
    const answered = await db().from("agent_inbound_events").select("received_at,raw_payload")
      .in("id", [...covered]);
    if (answered.error) throw answered.error;
    const latestAnswered = Math.max(...(answered.data ?? []).map(inboundMessageTime));
    const stale = events.filter((event) =>
      inboundMessageTime(event) < latestAnswered &&
      /^(?:hola(?:\s+tom[aá]s)?|buen\s+d[ií]a|buenas)[\s.!]*$/i.test(String(event.content ?? "").trim())
    );
    for (const event of stale) {
      await syncMessageToCrm({
        phone,
        name: event.contact_name ?? null,
        role: "user",
        content: String(event.content),
        sourceId: `late:${event.id}`,
      });
    }
    if (stale.length) {
      const staleIds = new Set(stale.map((event) => event.id));
      await markEvents([...staleIds], "late_greeting_history_only");
      events = events.filter((event) => !staleIds.has(event.id));
      if (!events.length) return;
    }
  }
  events.sort((a, b) => inboundMessageTime(a) - inboundMessageTime(b));
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
    const agendaPhone = normalizePhone(await runtimeSecret("AGENT_AGENDA_PHONE") ?? "");
    const ricardoPhone = normalizePhone(await runtimeSecret("AGENT_RICARDO_PHONE") ?? "");
    const isOwner = Boolean((agendaPhone && phone === agendaPhone) || (ricardoPhone && phone === ricardoPhone));
    // The owner manages the agenda from here: human mode never applies to that phone.
    if (contact.human_mode && isOwner) {
      contact = { ...contact, ...await applyContactState({ phone, patch: { human_mode: false } }) };
    }
    if (contact.human_mode) {
      await markEvents(ids, "human_mode");
      return;
    }

    const guillermoPhone = normalizePhone(await runtimeSecret("AGENT_GUILLERMO_PHONE") ?? "");
    let responseText = "";
    let responseModel = "deterministic-v2";
    const prepared = await preparedWhatsAppText(replyKey);
    if (prepared) {
      responseText = prepared.content;
      responseModel = prepared.model ?? "prepared-outbox-v2";
    } else if (isOwner) {
      responseText = sanitizePlainText(await processAgendaMessage(incoming));
      responseModel = "agenda-v2";
    } else if (guillermoPhone && phone === guillermoPhone) {
      await markEvents(ids, "internal_ignored");
      return;
    } else {
      let category = contactCategory(contact);
      const chargerScope = chargerScopeFromText(incoming);
      if (chargerScope) category = "cargador_electrico";
      const explicitCategory = explicitCategoryFromText(incoming);
      if (explicitCategory) {
        category = explicitCategory;
      } else if (!contact.tipo || contact.tipo === "otro") {
        category = chargerScope ? "cargador_electrico" : await classifyContact(incoming);
      }

      const storedContact = contact;
      const historyReplies = [...delivered, ...await operatorRepliesFor(events, delivered)];
      const crmHistory = await readCrmConversationHistory(phone, 500);
      let history = mergeDeliveredHistory(crmHistory, historyReplies);
      if (!crmHistory.length) {
        const historyResult = await db().from("agent_messages")
          .select("role,content,created_at").eq("contact_phone", phone).order("created_at", {
            ascending: false,
          }).limit(
            500,
          );
        if (historyResult.error) throw historyResult.error;
        history = mergeDeliveredHistory(
          (historyResult.data ?? []).reverse().filter((row) => row.role !== "system") as Array<
            AgentMessage & { created_at: string }
          >,
          historyReplies,
        );
      }
      history = fullConversationForClaude(history, incoming);
      const historicalFields = explicitFieldsFromConversation(history);
      const historyEvidence = history.filter((message) => message.role === "user")
        .map((message) => message.content).join("\n");
      const missingBeforeExplicitExtraction = conversationMissingFields(category, storedContact);
      const unavailableField = unavailableFieldFromReply(incoming, history);
      const repeatedField = exhaustedRepeatedField(missingBeforeExplicitExtraction, history);
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
      if (unavailableField || repeatedField) {
        const currentState = storedContact.agent_state && typeof storedContact.agent_state === "object"
          ? storedContact.agent_state as Record<string, unknown>
          : {};
        const skippedFields = new Set(
          Array.isArray(currentState.skipped_fields)
            ? currentState.skipped_fields.map((field: unknown) => String(field))
            : [],
        );
        if (unavailableField) skippedFields.add(unavailableField);
        if (repeatedField) skippedFields.add(repeatedField);
        explicitPatch.agent_state = {
          ...(explicitPatch.agent_state as Record<string, unknown>),
          skipped_fields: [...skippedFields],
        };
      }
      contact = contactWithPatch(storedContact, explicitPatch) as typeof contact;

      const explicitHumanHandoff = requestsHumanRepresentative(incoming);
      const quoteAlreadyQueued = contact.stage === "pendiente_presupuesto" ||
        contact.label === "Pendiente enviar presupuesto";
      const pendingQuoteFollowup = quoteAlreadyQueued && isQuoteStatusFollowup(incoming);
      const academyAlreadyQueued = contact.label === "Academia Solar" && contact.notified_ricardo === true;
      const decision: AgentDecision = await modelDecision(contact, category, history, incoming);
      if (pendingQuoteFollowup) {
        decision.handoff = true;
        decision.handoffReason = "El cliente reclamó una propuesta pendiente";
        decision.label = "Reclamo presupuesto pendiente";
      } else if (explicitHumanHandoff) {
        decision.handoff = true;
        decision.handoffReason = decision.handoffReason ?? "El cliente pidió continuar con una persona";
        decision.label = "Solicita representante";
      }
      category = decision.classification;
      const storedChargerScope = contact.agent_state?.charger_scope;
      const effectiveChargerScope = chargerScope ??
        (["solar_y_cargador", "solo_cargador", "desconocido"].includes(String(storedChargerScope))
          ? storedChargerScope as AgentDecision["fields"]["charger_scope"]
          : null);
      if (effectiveChargerScope === "solar_y_cargador") {
        category = "cargador_electrico";
        if (!explicitHumanHandoff) decision.handoff = false;
        if (/derivaci[oó]n/i.test(String(decision.label ?? ""))) decision.label = null;
      } else if (chargerScope && category !== "cargador_electrico") {
        category = "cargador_electrico";
      }
      const patch = mergeContactPatches(
        explicitPatch,
        safeAgentPatch(
          storedContact,
          {
            ...historicalFields,
            ...decision.fields,
            ...explicitAgentFields(incoming, missingBeforeExplicitExtraction[0] ?? null),
            ...(effectiveChargerScope ? { charger_scope: effectiveChargerScope } : {}),
          },
          category,
          historyEvidence || incoming,
        ),
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
        agent_state: { missing_fields: missing, last_decision_version: "v13-single-processor" },
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
        statePatch.human_mode = true;
        statePatch.stage = "pendiente_presupuesto";
        statePatch.label = "Pendiente enviar presupuesto";
        statePatch.notified_ricardo = true;
        ({ title: taskTitle, description: taskDescription } = taskFor(category, true, contact));
        responseText = decision.reply;
      } else if (academyComplete && !academyAlreadyQueued) {
        statePatch.label = "Academia Solar";
        statePatch.notified_ricardo = true;
        responseText = decision.reply;
      } else if ((completeForQuote && quoteAlreadyQueued) || (academyComplete && academyAlreadyQueued)) {
        statePatch.notified_ricardo = true;
        responseText = decision.reply;
      } else if (needsFollowup) {
        statePatch.notified_ricardo = true;
        if (decision.label) statePatch.label = decision.label;
        if (chargerOnly) statePatch.stage = "contactado";
        ({ title: taskTitle, description: taskDescription } = taskFor(category, false, contact));
        responseText = decision.reply;
      } else {
        responseText = decision.reply;
      }
      const finalPatch = mergeContactPatches(patch, statePatch);
      if (await hasUnbatchedInbound(phone, ids)) {
        await markEvents(ids, "superseded_by_new_inbound");
        return;
      }
      // Do not mute the contact until the closing message is confirmed sent.
      // The outbox trigger finalizes this exact handoff, including retry delivery.
      const pendingHandoff = finalPatch.human_mode === true ? replyKey : null;
      delete finalPatch.human_mode;
      finalPatch.agent_state = {
        ...(finalPatch.agent_state as Record<string, unknown>),
        pending_handoff: pendingHandoff,
      };
      contact = await applyContactState({
        phone,
        patch: finalPatch,
        taskTitle,
        taskDescription,
      });
      const configuredModel = await runtimeSecret("ANTHROPIC_MODEL");
      responseModel = !configuredModel || configuredModel === "claude-haiku-4-5-20251001"
        ? "claude-haiku-5-5"
        : configuredModel;
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
        metadata: {
          inbound_event_ids: ids,
          response_model: responseModel,
          handoff_key: contact.agent_state?.pending_handoff ?? null,
          engine_version: "v13-single-processor",
        },
      });
    } catch (error) {
      if (error instanceof CustomerReplySuppressedError) {
        await markEvents(ids, "reply_suppressed", error.message);
        return;
      }
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
      // A technical failure must not silence the contact: the bot keeps answering the
      // next message with the full history, and a person reviews the one that failed.
      await applyContactState({
        phone,
        patch: {},
        taskTitle: "Responder mensaje con error",
        taskDescription: `El bot agotó los reintentos en este mensaje y sigue activo para los próximos. Error: ${message}`,
      });
    }
  }
}

export async function processDueJobs(limit = 10): Promise<{ completed: number; failed: number }> {
  await db().from("agent_jobs").update({ status: "pending", locked_at: null })
    .eq("status", "processing").lt("locked_at", new Date(Date.now() - 10 * 60_000).toISOString());
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
