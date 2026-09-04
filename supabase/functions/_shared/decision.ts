import { hasForbiddenFormatting, sanitizePlainText } from "./output.ts";

export const AGENT_CATEGORIES = [
  "residencial",
  "comercial",
  "academia",
  "cv",
  "cargador_electrico",
  "soporte",
  "otro",
] as const;

export type AgentCategory = typeof AGENT_CATEGORIES[number];

export type AgentFieldUpdates = {
  name?: string;
  email?: string;
  locality?: string;
  province?: string;
  roof_type?: string;
  connection_type?: string;
  product_interest?: string;
  notes?: string;
  bill_received?: boolean;
  consumo_mensual?: number;
  consumo_anual?: number;
  consumption_evidence?: string;
  charger_scope?: "solar_y_cargador" | "solo_cargador" | "desconocido";
};

export type AgentDecision = {
  reply: string;
  classification: AgentCategory;
  fields: AgentFieldUpdates;
  missingFields: string[];
  completeForQuote: boolean;
  handoff: boolean;
  handoffReason: string | null;
  label: string | null;
};

function parseObject(raw: string): Record<string, unknown> {
  const candidates = [
    raw.trim(),
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    raw.match(/\{[\s\S]*\}/)?.[0],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next representation.
    }
  }
  throw new Error("Agent returned invalid JSON");
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizePlainText(value);
  return clean || undefined;
}

export function parseAgentDecision(raw: string, fallbackCategory: AgentCategory): AgentDecision {
  const parsed = parseObject(raw);
  const classification = AGENT_CATEGORIES.includes(parsed.classification as AgentCategory)
    ? parsed.classification as AgentCategory
    : fallbackCategory;
  const rawFields = parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)
    ? parsed.fields as Record<string, unknown>
    : {};
  const fields: AgentFieldUpdates = {};
  for (
    const key of [
      "name",
      "email",
      "locality",
      "province",
      "roof_type",
      "connection_type",
      "product_interest",
      "notes",
      "consumption_evidence",
    ] as const
  ) {
    const value = cleanString(rawFields[key]);
    if (value) fields[key] = value;
  }
  if (typeof rawFields.bill_received === "boolean") fields.bill_received = rawFields.bill_received;
  for (const key of ["consumo_mensual", "consumo_anual"] as const) {
    const value = Number(rawFields[key]);
    if (Number.isFinite(value) && value > 0) fields[key] = value;
  }
  if (["solar_y_cargador", "solo_cargador", "desconocido"].includes(String(rawFields.charger_scope))) {
    fields.charger_scope = rawFields.charger_scope as AgentFieldUpdates["charger_scope"];
  }

  const rawReply = typeof parsed.reply === "string" ? parsed.reply : "";
  const reply = sanitizePlainText(rawReply);
  if (!reply) throw new Error("Agent decision has no reply");
  return {
    reply,
    classification,
    fields,
    missingFields: Array.isArray(parsed.missingFields)
      ? parsed.missingFields.map(cleanString).filter((value): value is string => Boolean(value)).slice(0, 10)
      : [],
    completeForQuote: parsed.completeForQuote === true,
    handoff: parsed.handoff === true,
    handoffReason: cleanString(parsed.handoffReason) ?? null,
    label: cleanString(parsed.label) ?? null,
  };
}

export function replyViolations(reply: string, incoming: string): string[] {
  const violations: string[] = [];
  if (hasForbiddenFormatting(reply)) violations.push("contiene emoji o Markdown");
  if (/\bricardo\b/i.test(reply)) violations.push("menciona a Ricardo frente al cliente");
  if ((reply.match(/\?/g) ?? []).length > 1) violations.push("hace más de una pregunta");
  if (reply.length > 480) violations.push("supera 480 caracteres");
  if (/\bcu[eé]ntame\b/i.test(reply)) violations.push("usa español no argentino");
  if (
    /(?:\$|u\$s|usd|d[oó]lares?)\s*[0-9]|\b(?:sale|cuesta|precio (?:es|final))\s*(?:de\s*)?[0-9]/i.test(reply)
  ) {
    violations.push("inventa o confirma un precio");
  }
  if (
    /\b(?:tenemos|hay) stock\b|\bdisponibilidad (?:confirmada|inmediata)\b|\bentrega inmediata\b/i.test(reply)
  ) {
    violations.push("inventa disponibilidad");
  }
  if (
    /\b(?:s[ií][,.]?\s*)?(?:trabajamos|ofrecemos|tenemos|damos)\b.{0,45}\b(?:cuotas|financiaci[oó]n)\b/i
      .test(reply)
  ) {
    violations.push("confirma cuotas o financiación sin una propuesta");
  }
  if (
    /\b(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b.{0,35}\b[0-9]{1,2}\s*(?:h|hs|horas)\b/i
      .test(reply)
  ) {
    violations.push("inventa horarios de atención");
  }
  const onlyLighting = /\bluminari/i.test(incoming) &&
    !/\b(solar|panel(?:es)?|fotovolta(?:ico|ica|icos|icas)?|energ[ií]a solar)\b/i.test(incoming);
  if (onlyLighting && !/no (?:vendemos|instalamos|trabajamos)|no es un servicio/i.test(reply)) {
    violations.push("ofrece o no rechaza claramente luminarias fuera del alcance");
  }
  return violations;
}

export function isStandaloneLighting(incoming: string): boolean {
  return /\bluminari/i.test(incoming) &&
    !/\b(solar|panel(?:es)?|fotovolta(?:ico|ica|icos|icas)?|energ[ií]a solar)\b/i.test(incoming);
}

export function requestsHumanRepresentative(incoming: string): boolean {
  return /\b(?:hablar|comunicarme|contactarme|llamar|llamo|llame|atienda|atenderme)\b.{0,45}\b(?:representante|asesor|persona|humano|vendedor)\b/i
    .test(incoming) ||
    /\b(?:representante|asesor|persona|humano|vendedor)\b.{0,45}\b(?:hablar|comunicar|contact|llam|atienda|atender)\w*/i
      .test(incoming) ||
    /\b(?:ten[eé]s|hay|me pas[aá]s?|pasame)\b.{0,35}\b(?:n[uú]mero|tel[eé]fono)\b.{0,25}\b(?:llam|contact)/i
      .test(incoming);
}

export function chargerScopeFromText(incoming: string): AgentFieldUpdates["charger_scope"] | null {
  if (!/\b(cargador|carga).{0,20}\b(el[eé]ctric|veh[ií]culo|auto)|\bwallbox\b/i.test(incoming)) return null;
  if (
    /\b(solo|solamente|[uú]nicamente)\b.{0,30}\b(cargador|wallbox)\b|\b(cargador|wallbox)\b.{0,30}\b(solo|solamente|[uú]nicamente)\b/i
      .test(incoming) &&
    !/\b(panel(?:es)?|solar|fotovolta(?:ico|ica|icos|icas)?)\b/i.test(incoming)
  ) return "solo_cargador";
  if (/\b(panel(?:es)?|solar|fotovolta(?:ico|ica|icos|icas)?)\b/i.test(incoming)) return "solar_y_cargador";
  return "desconocido";
}
