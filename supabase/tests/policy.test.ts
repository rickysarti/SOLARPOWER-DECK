import {
  chargerScopeFromText,
  isStandaloneLighting,
  parseAgentDecision,
  replyViolations,
} from "../functions/_shared/decision.ts";
import { hasForbiddenFormatting, sanitizePlainText } from "../functions/_shared/output.ts";
import { agentSystemPrompt } from "../functions/_shared/prompts.ts";
import {
  fallbackContinuation,
  nextRequiredField,
  replyRequestsField,
} from "../functions/_shared/processor.ts";
import { splitText } from "../functions/_shared/sendpulse.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("sanitiza emojis, asteriscos y markdown", () => {
  const clean = sanitizePlainText("**Hola** ☀️\n- ¿Cómo estás?");
  assertEquals(clean, "Hola\n¿Cómo estás?");
  assertEquals(hasForbiddenFormatting(clean), false);
});

Deno.test("detecta luminarias fuera de alcance y cargadores", () => {
  assert(isStandaloneLighting("Necesito cotizar luminarias para un galpón"));
  assertEquals(isStandaloneLighting("Quiero paneles para alimentar luminarias"), false);
  assertEquals(chargerScopeFromText("Quiero solamente un cargador eléctrico"), "solo_cargador");
  assertEquals(chargerScopeFromText("Quiero paneles solares y un wallbox"), "solar_y_cargador");
});

Deno.test("valida AgentDecision y rechaza respuestas impropias", () => {
  const parsed = parseAgentDecision(
    JSON.stringify({
      reply: "Perfecto. ¿En qué localidad estás?",
      classification: "comercial",
      fields: { locality: "Rosario", consumo_mensual: 500 },
      missingFields: ["techo"],
      completeForQuote: false,
      handoff: false,
      handoffReason: null,
      label: null,
    }),
    "residencial",
  );
  assertEquals(parsed.classification, "comercial");
  assertEquals(parsed.fields.consumo_mensual, 500);
  assert(replyViolations("Sí, instalamos luminarias", "Busco luminarias").length > 0);
  assert(replyViolations("Hola. ¿Dónde vivís? ¿Cuánto consumís?", "Hola").length > 0);
  assert(replyViolations("x".repeat(481), "Hola").includes("supera 480 caracteres"));
  assert(
    replyViolations("Sí, trabajamos con baterías y financiación.", "¿Ofrecen cuotas?")
      .includes("confirma cuotas o financiación sin una propuesta"),
  );
});

Deno.test("una respuesta comercial normal se envía completa en un solo mensaje", () => {
  const response =
    "Hola Andrea, gracias por los detalles. Tengo claro que necesitás un sistema off-grid robusto para la bomba y el resto de los consumos. Para seguir con la propuesta y definir bien la estructura, ¿qué tipo de techo o superficie tenés disponible para instalar los paneles?";
  assertEquals(splitText(response).length, 1);
  assertEquals(splitText(response)[0], response);
});

Deno.test("si el modelo falla se continúa preguntando un solo dato", () => {
  const academy = fallbackContinuation(
    { phone: "5491100000000", name: "Tobias" },
    "academia",
    ["nombre completo", "email", "localidad o provincia"],
    "Busco capacitarme en general",
  );
  assert(academy.reply.includes("nombre completo"));
  assertEquals(academy.handoff, false);
  assertEquals((academy.reply.match(/\?/g) ?? []).length, 1);

  const residential = fallbackContinuation(
    { phone: "5491100000001" },
    "residencial",
    ["factura, consumo o lista de cargas", "techo o superficie"],
    "6600 kWh/año",
  );
  assertEquals(residential.fields.consumo_anual, 6600);
  assert(residential.reply.includes("techo"));
  assertEquals(residential.handoff, false);
});

Deno.test("la respuesta debe pedir el primer dato que sigue faltando", () => {
  const missing = ["factura, consumo o lista de cargas", "techo o superficie", "tipo de conexión"];
  assertEquals(nextRequiredField(missing, { consumo_anual: 6600 }), "techo o superficie");
  assert(replyRequestsField("¿Qué tipo de techo tenés?", "techo o superficie"));
  assertEquals(replyRequestsField("¿Cuál es tu email?", "nombre completo"), false);
});

Deno.test("una consulta de batería en cuotas recibe una aclaración segura y sigue calificando", () => {
  const decision = fallbackContinuation(
    { phone: "5491100000002", product_interest: "Batería solar" },
    "residencial",
    ["factura, consumo o lista de cargas", "techo o superficie"],
    "Necesito una batería solar, ¿la ofrecen en cuotas?",
  );
  assert(decision.reply.includes("dependen de cada propuesta"));
  assert(decision.reply.includes("sistema solar instalado"));
  assertEquals(decision.handoff, false);
});

Deno.test("el formato impropio del modelo se sanea sin cortar la conversación", () => {
  const parsed = parseAgentDecision(
    JSON.stringify({
      reply: "**Perfecto** ☀️ ¿Qué tipo de techo tenés?",
      classification: "residencial",
      fields: {},
      missingFields: ["techo o superficie"],
      completeForQuote: false,
      handoff: false,
    }),
    "residencial",
  );
  assertEquals(parsed.reply, "Perfecto ¿Qué tipo de techo tenés?");
});

Deno.test("todos los prompts incluyen la política compartida de cargadores y servicios", () => {
  for (
    const category of [
      "residencial",
      "comercial",
      "academia",
      "cv",
      "cargador_electrico",
      "soporte",
      "otro",
    ] as const
  ) {
    const prompt = agentSystemPrompt({ phone: "5491100000000" }, category, []);
    assert(prompt.includes("Solar más cargador"));
    assert(prompt.includes("Solo cargador"));
    assert(prompt.includes("todo el país"));
    assert(prompt.includes("no vende ni instala luminarias"));
    assert(prompt.includes("una sola pregunta"));
  }
});
