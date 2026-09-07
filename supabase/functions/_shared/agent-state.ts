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
  const skipped = new Set(
    Array.isArray(state.skipped_fields) ? state.skipped_fields.map((field: unknown) => String(field)) : [],
  );
  return missing.filter((field) => !skipped.has(field));
}

function explicitFullName(incoming: string, expectedField: string | null = null): string | null {
  const tail = incoming.match(/\b(?:me llamo|mi nombre es|soy)\s+([\p{L}'’\- ]{3,100})/iu)?.[1];
  if (tail) {
    const stopWords = /^(?:de|y|quiero|quer[ií]a|necesito|busco|consulto|para|porque|por|del|una?|estoy)$/i;
    const words = tail.match(/[\p{L}][\p{L}'’\-]*/gu) ?? [];
    const name: string[] = [];
    for (const word of words) {
      if (stopWords.test(word)) break;
      name.push(word);
      if (name.length === 4) break;
    }
    if (name.length >= 2) return name.join(" ");
  }

  if (expectedField !== "nombre completo") return null;
  const standalone = incoming.trim().replace(/[.,;:!?]+$/g, "").replace(/\s+/g, " ");
  return /^[\p{L}][\p{L}'’\-]{1,40}(?:\s+[\p{L}][\p{L}'’\-]{1,40}){1,3}$/u.test(standalone)
    ? standalone
    : null;
}

export function explicitAgentFields(
  incoming: string,
  expectedField: string | null = null,
): AgentFieldUpdates {
  const fields: AgentFieldUpdates = {};
  const name = explicitFullName(incoming, expectedField);
  if (name) fields.name = name;

  const email = incoming.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  if (email) fields.email = email.toLowerCase();

  const numberValue = (value: string): number => Number(value.replace(/\./g, "").replace(",", "."));
  const annual = incoming.match(/\b([0-9][0-9.,]*)\s*kwh\s*(?:\/|por\s+)?\s*(?:a[nñ]o|anual(?:es)?)\b/i);
  const monthly = incoming.match(/\b([0-9][0-9.,]*)\s*kwh\s*(?:\/|por\s+)?\s*(?:mes|mensual(?:es)?)\b/i) ??
    (expectedField === "factura, consumo o lista de cargas"
      ? incoming.match(/\b([0-9][0-9.,]*)\s*kwh\b/i)
      : null);
  if (annual) {
    const value = numberValue(annual[1]);
    if (Number.isFinite(value) && value > 0) fields.consumo_anual = value;
  }
  if (monthly) {
    const value = numberValue(monthly[1]);
    if (Number.isFinite(value) && value > 0) fields.consumo_mensual = value;
  }

  const provinceMatchers: Array<[string, RegExp]> = [
    ["Buenos Aires", /\b(?:buenos aires|bs\.?\s*as\.?)\b/i],
    ["Catamarca", /\bcatamarca\b/i],
    ["Chaco", /\bchaco\b/i],
    ["Chubut", /\bchubut\b/i],
    ["Córdoba", /\bc[oó]rdoba\b/i],
    ["Corrientes", /\bcorrientes\b/i],
    ["Entre Ríos", /\bentre r[ií]os\b/i],
    ["Formosa", /\bformosa\b/i],
    ["Jujuy", /\bjujuy\b/i],
    ["La Pampa", /\bla pampa\b/i],
    ["La Rioja", /\bla rioja\b/i],
    ["Mendoza", /\bmendoza\b/i],
    ["Misiones", /\bmisiones\b/i],
    ["Neuquén", /\bneuqu[eé]n\b/i],
    ["Río Negro", /\br[ií]o negro\b/i],
    ["Salta", /\bsalta\b/i],
    ["San Juan", /\bsan juan\b/i],
    ["San Luis", /\bsan luis\b/i],
    ["Santa Cruz", /\bsanta cruz\b/i],
    ["Santa Fe", /\bsanta fe\b/i],
    ["Santiago del Estero", /\bsantiago del estero\b/i],
    ["Tierra del Fuego", /\btierra del fuego\b/i],
    ["Tucumán", /\btucum[aá]n\b/i],
  ];
  const province = provinceMatchers.find(([, pattern]) => pattern.test(incoming))?.[0];
  if (province) fields.province = province;
  if (/\bneuqu[eé]n\s+capital\b/i.test(incoming)) fields.locality = "Neuquén Capital";
  if (/\b(?:caba|capital federal|ciudad aut[oó]noma de buenos aires)\b/i.test(incoming)) {
    fields.locality = "CABA";
  }

  if (/\b(?:bajar|reducir|ahorrar|ahorro)\b.{0,45}\b(?:costos?|factura|luz|electricidad)\b/i.test(incoming)) {
    fields.product_interest = "Reducir costos de electricidad";
  } else if (/\b(?:cortes?|respaldo)\b/i.test(incoming)) {
    fields.product_interest = "Respaldo ante cortes de energía";
  }
  if (
    expectedField === "necesidad o producto" &&
    /\b(?:las|ambas|dos)\s+opciones\b|\bcon\s+bater[ií]a\b.{0,60}\b(?:sin|on[ -]?grid)\b|\b(?:sin|on[ -]?grid)\b.{0,60}\bcon\s+bater[ií]a\b/i
      .test(incoming)
  ) {
    fields.product_interest = "Comparar sistema on-grid y sistema con batería";
  }

  const hasChapa = /\bchapa\b/i.test(incoming);
  const hasTeja = /\btejas?\b/i.test(incoming);
  if (hasChapa && hasTeja) {
    fields.roof_type = "Una casa con techo de chapa y otra con techo de tejas";
  } else if (hasChapa) {
    fields.roof_type = /\bcom[uú]n\b/i.test(incoming) ? "Techo de chapa común" : "Techo de chapa";
  } else if (hasTeja) {
    fields.roof_type = "Techo de tejas";
  } else if (/\b(?:losa|membrana)\b/i.test(incoming)) {
    fields.roof_type = /\blosa\b/i.test(incoming) ? "Techo de losa" : "Techo con membrana";
  } else if (
    /\b(?:soporte|estructura)\b/i.test(incoming) &&
    /\b(?:paneles?|pantallas?|orientaci[oó]n|instalar|colocar)\b/i.test(incoming)
  ) {
    fields.roof_type = "Estructura independiente a definir según orientación";
  }

  if (
    /\b(?:sin\s+(?:conexi[oó]n|acceso)\s+a\s+la\s+red|sin\s+red|off[ -]?grid|fuera\s+de\s+red|no\s+hay\s+red)\b/i
      .test(incoming)
  ) {
    fields.connection_type = "off-grid sin red eléctrica";
  } else if (/\bmonof[aá]sic[ao]\b/i.test(incoming)) {
    fields.connection_type = "monofásica";
  } else if (/\btrif[aá]sic[ao]\b/i.test(incoming)) {
    fields.connection_type = "trifásica";
  } else if (expectedField === "tipo de conexión" && /^\s*mono(?:f[aá]sic[ao])?[.!]?\s*$/i.test(incoming)) {
    fields.connection_type = "monofásica";
  } else if (expectedField === "tipo de conexión" && /^\s*tri(?:f[aá]sic[ao])?[.!]?\s*$/i.test(incoming)) {
    fields.connection_type = "trifásica";
  }

  const loads = incoming.match(
    /\b(?:heladera|freezer|luces?|focos?|bomba|lavarropas?|televisi[oó]n|televisor|starlink|electrificador|ventilador|celulares?|aires? acondicionado)\b/gi,
  ) ?? [];
  if (new Set(loads.map((load) => load.toLowerCase())).size >= 2) {
    fields.consumption_evidence = "lista de equipos proporcionada";
  }
  return fields;
}

function hasFullName(value: unknown): boolean {
  const words = String(value ?? "").match(/\p{L}+(?:['’-]\p{L}+)?/gu) ?? [];
  return words.length >= 2;
}

export function conversationMissingFields(
  category: AgentCategory,
  contact: Record<string, any>,
): string[] {
  if (category === "academia") return [];
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
      !/\b(mono(?:f[aá]sic[ao])?|tri(?:f[aá]sic[ao])?|sin\s+red|off[ -]?grid|fuera\s+de\s+red)\b/i.test(
        evidence,
      )
    ) {
      continue;
    }
    const current = contact[key];
    if (key === "name" && !/\p{L}/u.test(String(current ?? ""))) {
      patch[key] = fields[key];
      nextExtracted[key] = fields[key];
      continue;
    }
    if (
      key === "name" && hasFullName(fields[key]) && !hasFullName(current) &&
      evidence.toLocaleLowerCase("es").replace(/\s+/g, " ").includes(
        String(fields[key]).toLocaleLowerCase("es").replace(/\s+/g, " "),
      )
    ) {
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
