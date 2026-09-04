import { AGENT_CATEGORIES, type AgentCategory, type AgentFieldUpdates } from "./decision.ts";

const EXTRACTABLE_FIELDS = [
  "name",
  "email",
  "locality",
  "province",
  "roof_type",
  "connection_type",
  "product_interest",
  "notes",
  "bill_received",
  "consumo_mensual",
  "consumo_anual",
] as const;

function stateOf(contact: Record<string, any>): Record<string, any> {
  return contact.agent_state && typeof contact.agent_state === "object" && !Array.isArray(contact.agent_state)
    ? contact.agent_state
    : {};
}

export function contactCategory(contact: Record<string, any>): AgentCategory {
  const category = String(contact.tipo ?? "").toLowerCase() as AgentCategory;
  return AGENT_CATEGORIES.includes(category) ? category : "residencial";
}

export function quoteMissingFields(contact: Record<string, any>): string[] {
  const state = stateOf(contact);
  const missing: string[] = [];
  if (!contact.product_interest && !state.product_interest && !state.need) {
    missing.push("necesidad o producto");
  }
  if (
    !contact.bill_received && !(Number(contact.consumo_mensual) > 0) &&
    !(Number(contact.consumo_anual) > 0) && !state.consumption_evidence
  ) {
    missing.push("factura, consumo o lista de cargas");
  }
  if (!contact.roof_type && !state.surface) missing.push("techo o superficie");
  if (!contact.connection_type && !state.connection) missing.push("tipo de conexión");
  if (!contact.locality && !contact.province) missing.push("localidad o provincia");
  return missing;
}

function hasFullName(value: unknown): boolean {
  const words = String(value ?? "").match(/\p{L}+(?:['’-]\p{L}+)?/gu) ?? [];
  return words.length >= 2;
}

export function conversationMissingFields(
  category: AgentCategory,
  contact: Record<string, any>,
): string[] {
  if (category === "academia") {
    const missing: string[] = [];
    if (!hasFullName(contact.name)) missing.push("nombre completo");
    if (!contact.email) missing.push("email");
    if (!contact.locality && !contact.province) missing.push("localidad o provincia");
    return missing;
  }
  return quoteMissingFields(contact);
}

export function isQuoteEligible(category: AgentCategory, contact: Record<string, any>): boolean {
  if (category === "residencial" || category === "comercial") return true;
  return category === "cargador_electrico" && stateOf(contact).charger_scope === "solar_y_cargador";
}

export function safeAgentPatch(
  contact: Record<string, any>,
  fields: AgentFieldUpdates,
  category: AgentCategory,
  evidence = "",
): Record<string, unknown> {
  const state = stateOf(contact);
  const previousExtracted = state.extracted && typeof state.extracted === "object" ? state.extracted : {};
  const nextExtracted: Record<string, unknown> = { ...previousExtracted };
  const patch: Record<string, unknown> = { tipo: category };

  for (const key of EXTRACTABLE_FIELDS) {
    if (fields[key] === undefined) continue;
    if (
      key === "connection_type" && evidence &&
      !/\b(monof[aá]sic[ao]|trif[aá]sic[ao]|sin\s+red|off[ -]?grid|fuera\s+de\s+red)\b/i.test(evidence)
    ) {
      continue;
    }
    const current = contact[key];
    if (key === "name" && !/\p{L}/u.test(String(current ?? ""))) {
      patch[key] = fields[key];
      nextExtracted[key] = fields[key];
      continue;
    }
    if (current === null || current === undefined || current === "" || current === previousExtracted[key]) {
      patch[key] = fields[key];
      nextExtracted[key] = fields[key];
    }
  }
  const statePatch: Record<string, unknown> = { extracted: nextExtracted };
  if (fields.consumption_evidence) statePatch.consumption_evidence = fields.consumption_evidence;
  if (fields.charger_scope) statePatch.charger_scope = fields.charger_scope;
  if (fields.product_interest) statePatch.product_interest = fields.product_interest;
  patch.agent_state = statePatch;
  return patch;
}

export function taskFor(category: AgentCategory, completeForQuote: boolean, contact: Record<string, any>): {
  title: string | null;
  description: string | null;
} {
  const name = contact.name ? ` de ${contact.name}` : "";
  if (completeForQuote) {
    return { title: "Enviar presupuesto", description: `Preparar y enviar la propuesta solicitada${name}.` };
  }
  switch (category) {
    case "cargador_electrico":
      return {
        title: "Derivar cargador eléctrico",
        description: `Pasar el contacto de un instalador especializado${name}.`,
      };
    case "academia":
      return {
        title: "Seguimiento Academia Solar",
        description: `Revisar el interés en la Academia Solar${name}.`,
      };
    case "cv":
      return { title: "Revisar postulación", description: `Revisar la información laboral recibida${name}.` };
    case "soporte":
      return { title: "Atender soporte", description: `Revisar el caso técnico o de posventa${name}.` };
    default:
      return {
        title: "Responder derivación del bot",
        description: `Revisar la conversación derivada${name}.`,
      };
  }
}
