import {
  asksAssistantIdentity,
  chargerScopeFromText,
  isStandaloneLighting,
  parseAgentDecision,
  replyViolations,
  requestsHumanRepresentative,
} from "../functions/_shared/decision.ts";
import { hasForbiddenFormatting, sanitizePlainText } from "../functions/_shared/output.ts";
import { agentSystemPrompt } from "../functions/_shared/prompts.ts";
import {
  academyCompletionDecision,
  deterministicDecision,
  exhaustedRepeatedField,
  explicitCategoryFromText,
  explicitFieldsFromConversation,
  fullConversationForClaude,
  isQuoteStatusFollowup,
  repeatedAssistantQuestionField,
  repeatsPreviousAssistantReply,
  replyRequestsField,
  unavailableFieldFromReply,
  uncertaintyHandoffDecision,
} from "../functions/_shared/processor.ts";
import { splitText } from "../functions/_shared/sendpulse.ts";
import {
  isInboundSendPulseMessage,
  sendPulseMessageContent,
} from "../functions/_shared/sendpulse-reconcile.ts";
import { inboundDebounceRemainingSeconds } from "../functions/_shared/webhook.ts";
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

Deno.test("una solicitud de representante tiene prioridad sobre los datos pendientes", () => {
  assert(requestsHumanRepresentative("Pero necesito hablar con un representante"));
  assert(requestsHumanRepresentative("Tenés un número de teléfono así te llamo"));
  const decision = deterministicDecision(
    "Pero necesito hablar con un representante",
    "residencial",
    false,
  );
  assertEquals(decision?.handoff, true);
  assertEquals(decision?.label, "Solicita representante");
  assert(!decision?.reply.includes("techo"));
});

Deno.test("responde quién es sin reiniciar el cuestionario", () => {
  assert(asksAssistantIdentity("Con quien estoy hablando?"));
  const decision = deterministicDecision("Quién sos?", "residencial", false);
  assert(decision?.reply.startsWith("Soy Tomás"));
  assertEquals(decision?.handoff, false);
  assertEquals((decision?.reply.match(/\?/g) ?? []).length, 0);
});

Deno.test("un pedido genérico de información inicia conversación sin derivar", () => {
  const decision = deterministicDecision("QUIERO INFORMACION", "residencial", true);
  assertEquals(decision?.handoff, false);
  assert(decision?.reply.includes("ahorro en la factura"));
  assert(decision?.reply.includes("cuando se va la luz"));
  assertEquals((decision?.reply.match(/\?/g) ?? []).length, 1);
});

Deno.test("un saludo solo abre siempre con ahorro versus cortes", () => {
  const decision = deterministicDecision("Buenas", "residencial", true);
  assertEquals(decision?.handoff, false);
  assert(decision?.reply.includes("ahorro en la factura"));
  assert(decision?.reply.includes("cuando se va la luz"));
});

Deno.test("el prompt reconoce el Plan SolarPower y una negación del modelo se rechaza", () => {
  const incoming =
    "Quiero una cotización del PLAN SOLARPOWER (alquiler de paneles). Entiendo que pago un anticipo bajo y la cuota se cubre con parte del ahorro.";
  const prompt = agentSystemPrompt({ phone: "5491128975308" }, "residencial");
  assert(prompt.includes("SolarPower sí ofrece el Plan SolarPower"));
  assert(prompt.includes("se paga con parte del ahorro que genera"));
  assert(prompt.includes("entre 12% y 20%"));
  assertEquals(
    replyViolations(
      "SolarPower no ofrece alquiler de paneles ni planes de financiación con anticipo bajo.",
      incoming,
    ),
    ["niega incorrectamente el Plan SolarPower"],
  );
  assertEquals(
    replyViolations(
      "Sí, ese es el Plan SolarPower: la cuota se diseña para ser menor que el ahorro. ¿Podés enviarme una factura reciente?",
      incoming,
    ),
    [],
  );
});

Deno.test("reclasifica explícitamente una consulta de cursos en cada turno", () => {
  assertEquals(explicitCategoryFromText("En realidad quiero información sobre los cursos"), "academia");
  assertEquals(explicitCategoryFromText("Tengo techo de chapa"), null);
});

Deno.test("un reclamo de presupuesto pendiente activa el seguimiento", () => {
  assert(isQuoteStatusFollowup("Buenas tardes. Algún inconveniente? No recibí nada todavía!"));
  assert(isQuoteStatusFollowup("Quedaron en mandarme las dos propuestas"));
  assertEquals(isQuoteStatusFollowup("Tengo techo de teja"), false);
});

Deno.test("reconstruye el contexto de toda la conversación anterior", () => {
  const fields = explicitFieldsFromConversation([
    { role: "user", content: "Ver opciones de bajar costos. Están en Neuquén capital?" },
    { role: "assistant", content: "¿Qué tipo de techo tenés: chapa, tejas, losa o membrana?" },
    { role: "user", content: "Teja" },
    { role: "assistant", content: "¿Tu conexión eléctrica es monofásica o trifásica?" },
    { role: "user", content: "Mono" },
    {
      role: "assistant",
      content: "¿Te gustaría que la propuesta incluya batería o preferís solo el sistema solar sin ella?",
    },
    { role: "user", content: "Preparar las dos opciones, y vemos." },
    { role: "assistant", content: "¿Me decís tu nombre completo?" },
    { role: "user", content: "Juan Carlos Palagani." },
    { role: "assistant", content: "¿Cuál es tu email?" },
    { role: "user", content: "palaganij@hotmail.com" },
  ]);
  assertEquals(fields, {
    province: "Neuquén",
    locality: "Neuquén Capital",
    product_interest: "Sistema híbrido con batería para ahorro y respaldo",
    roof_type: "Techo de tejas",
    connection_type: "monofásica",
    name: "Juan Carlos Palagani",
    email: "palaganij@hotmail.com",
  });
});

Deno.test("Claude recibe todo el historial y siempre incluye el mensaje actual", () => {
  const previous = [
    { role: "user" as const, content: "Es un edificio en construcción" },
    { role: "assistant" as const, content: "¿En qué localidad está?" },
    { role: "user" as const, content: "CABA" },
    { role: "assistant" as const, content: "¿Qué consumos querés alimentar?" },
  ];
  const complete = fullConversationForClaude(
    previous,
    "Equipos 100 artefactos de iluminación de 50 W",
  );
  assertEquals(complete.length, 5);
  assertEquals(complete[0], previous[0]);
  assertEquals(complete.at(-1), {
    role: "user",
    content: "Equipos 100 artefactos de iluminación de 50 W",
  });
  assertEquals(fullConversationForClaude(complete, complete.at(-1)!.content).length, 5);
});

Deno.test("detecta una respuesta exactamente repetida", () => {
  const reply = "¿Qué tipo de techo o superficie tenés disponible para instalar los paneles?";
  assert(repeatsPreviousAssistantReply(reply, [
    { role: "assistant", content: reply.toLocaleUpperCase("es") },
    { role: "user", content: "Uno de chapa y otro de teja" },
  ]));
  assertEquals(
    repeatsPreviousAssistantReply("¿En qué localidad sería?", [
      { role: "assistant", content: reply },
      { role: "user", content: "Uno de chapa y otro de teja" },
    ]),
    false,
  );
});

Deno.test("detecta preguntas reformuladas que vuelven a pedir el mismo dato", () => {
  const history = [
    {
      role: "assistant" as const,
      content: "¿Tenés una factura, un consumo aproximado en kWh o una lista de equipos?",
    },
    { role: "user" as const, content: "Quiero ser totalmente independiente de la red" },
  ];
  const reformulated =
    "Entendido. Para diseñarlo, ¿podés estimar cuántos kWh consumís mensualmente en tu vivienda?";
  assertEquals(
    repeatedAssistantQuestionField(reformulated, history),
    "factura, consumo o lista de cargas",
  );
});

Deno.test("no confunde reducir la factura con pedir una factura de consumo", () => {
  assertEquals(
    replyRequestsField(
      "¿Cuál es tu principal objetivo: tener respaldo, reducir la factura o una combinación de ambos?",
      "factura, consumo o lista de cargas",
    ),
    false,
  );
});

Deno.test("una negativa explícita permite avanzar con los datos disponibles", () => {
  const history = [
    { role: "assistant" as const, content: "¿Sabés si la conexión es monofásica o trifásica?" },
    { role: "user" as const, content: "No sé, no tengo forma de verlo" },
  ];
  assertEquals(unavailableFieldFromReply("No sé, no tengo forma de verlo", history), "tipo de conexión");
});

Deno.test("el debounce vence un minuto después del último mensaje", () => {
  const receivedAt = "2026-09-07T18:40:13.000Z";
  const receivedAtMs = new Date(receivedAt).getTime();
  assertEquals(inboundDebounceRemainingSeconds(receivedAt, receivedAtMs), 60);
  assertEquals(inboundDebounceRemainingSeconds(receivedAt, receivedAtMs + 21_000), 39);
  assertEquals(inboundDebounceRemainingSeconds(receivedAt, receivedAtMs + 60_000), 0);
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

Deno.test("si Claude no puede responder con seguridad deriva a modo humano", () => {
  const decision = uncertaintyHandoffDecision("residencial", "respuesta repetida");
  assertEquals(decision.handoff, true);
  assertEquals(decision.label, "Revisión humana");
  assert(decision.handoffReason?.includes("respuesta repetida"));
  assertEquals((decision.reply.match(/\?/g) ?? []).length, 0);
});

Deno.test("academia completa informa el estado real sin derivar a una persona", () => {
  const decision = academyCompletionDecision({
    phone: "5491157150566",
    name: "Mauro David Rodríguez",
    email: "maurodavidrodriguez@hotmail.com.ar",
    locality: "Córdoba",
  });
  assertEquals(decision.handoff, false);
  assertEquals(decision.label, "Academia Solar");
  assert(decision.reply.includes("está en preparación"));
  assert(decision.reply.includes("terminando de armar los contenidos y la modalidad"));
  assert(decision.reply.includes("avisar por email"));
  assertEquals((decision.reply.match(/\?/g) ?? []).length, 0);
});

Deno.test("academia sin datos personales empieza por el nombre completo", () => {
  const decision = academyCompletionDecision({ phone: "5491100000000" });
  assertEquals(decision.handoff, false);
  assert(decision.reply.includes("está en preparación"));
  assert(decision.reply.includes("nombre completo"));
  assertEquals(decision.missingFields, ["nombre completo", "email", "localidad o provincia"]);
  assertEquals((decision.reply.match(/\?/g) ?? []).length, 1);
});

Deno.test("academia pide un dato por turno y continúa aunque el cliente agradezca", () => {
  const email = academyCompletionDecision({
    phone: "5491100000000",
    name: "Soni Apellido",
  });
  assert(email.reply.includes("email"));
  assertEquals(email.missingFields, ["email", "localidad o provincia"]);
  const locality = academyCompletionDecision({
    phone: "5491100000000",
    name: "Soni Apellido",
    email: "soni@example.com",
  });
  assert(locality.reply.includes("localidad"));
  assertEquals((locality.reply.match(/\?/g) ?? []).length, 1);

  const first = academyCompletionDecision(
    { phone: "5491100000000" },
    "Quiero información sobre el curso de instalador",
  );
  const thanks = academyCompletionDecision(
    { phone: "5491100000000", label: "Academia Solar" },
    "ah excelente gracias",
  );
  assertEquals(thanks.reply.startsWith("De nada"), true);
  assertEquals(thanks.reply === first.reply, false);
});

Deno.test("después de dos pedidos del mismo dato avanza sin entrar en bucle", () => {
  const history = [
    { role: "assistant" as const, content: "¿Tenés una factura, consumo o lista de equipos?" },
    { role: "user" as const, content: "Es un edificio de 12 pisos" },
    { role: "assistant" as const, content: "¿Podés pasarme una lista de equipos o el consumo?" },
    { role: "user" as const, content: "Todavía está en construcción" },
  ];
  assertEquals(
    exhaustedRepeatedField(["factura, consumo o lista de cargas", "techo o superficie"], history),
    "factura, consumo o lista de cargas",
  );
});

Deno.test("la detección de preguntas repetidas es sólo una barrera de seguridad", () => {
  assert(replyRequestsField("¿Qué tipo de techo tenés?", "techo o superficie"));
  assertEquals(replyRequestsField("¿Cuál es tu email?", "nombre completo"), false);
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
    const prompt = agentSystemPrompt({ phone: "5491100000000" }, category);
    assert(prompt.includes("Solar más cargador"));
    assert(prompt.includes("Solo cargador"));
    assert(prompt.includes("todo el país"));
    assert(prompt.includes("no vende ni instala luminarias"));
    assert(prompt.includes("una sola pregunta"));
    assert(prompt.includes("presupuesto pendiente"));
    assert(prompt.includes("prometió enviar algo después"));
    assert(prompt.includes("No te obligan a preguntar nada"));
    assert(prompt.includes("no esperes frases clave"));
    assert(prompt.includes("decidí vos cuál es la respuesta natural"));
    assert(prompt.includes("No derives sólo por ambigüedad"));
    assert(prompt.includes("SolarPower sí ofrece el Plan SolarPower"));
    if (category === "academia") {
      assert(prompt.includes("todavía está en preparación"));
      assert(prompt.includes("nombre completo, email y localidad/provincia"));
      assert(prompt.includes("una sola pregunta por turno"));
      assert(prompt.includes("handoff=false"));
    }
  }
});

Deno.test("interpreta un mensaje entrante recuperado desde el historial de SendPulse", () => {
  const message = {
    id: "sendpulse-message-id",
    direction: 1,
    created_at: "2026-09-04T15:13:00Z",
    data: { type: "text", text: { body: "Tengo techo de chapa común" } },
  };
  assertEquals(isInboundSendPulseMessage(message), true);
  assertEquals(sendPulseMessageContent(message), {
    type: "text",
    content: "Tengo techo de chapa común",
    mediaUrl: null,
    mimeType: null,
  });
});
