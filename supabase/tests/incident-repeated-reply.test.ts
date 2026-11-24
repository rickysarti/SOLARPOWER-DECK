import { assert, assertEquals } from "./assert.ts";
import { modelDecision, repeatsPreviousAssistantReply } from "../functions/_shared/processor.ts";
import { requestsHumanRepresentative } from "../functions/_shared/decision.ts";
import {
  conversationMissingFields,
  explicitAgentFields,
  safeAgentPatch,
} from "../functions/_shared/agent-state.ts";
import {
  coveredInboundIds,
  inboundMessageTime,
  mergeDeliveredHistory,
} from "../functions/_shared/conversation-safety.ts";

const repeated =
  "Para dimensionar una opción adecuada, ¿tenés una factura reciente, un consumo aproximado en kWh o una lista de los equipos principales?";
const equipment = "tengo 3 equipos de Aire frio calor de 2500 y 1 termotanque de 80 lts";
const contact = {
  phone: "5491100000000",
  product_interest: "paneles solares",
  locality: "Vaca Muerta",
  province: "Neuquén",
};
function result(reply: string, handoff = false) {
  return JSON.stringify({
    reply,
    classification: "comercial",
    fields: {},
    missingFields: [],
    completeForQuote: false,
    handoff,
    handoffReason: handoff ? "Pidió una llamada" : null,
    label: null,
  });
}

Deno.test("incidente: reconoce llamados directos sin exigir la palabra representante", () => {
  for (
    const text of [
      "te puedo llamar?",
      "si ustedes están en este tema, llamame",
      "llámame",
      "me pueden llamar?",
      "quiero hablar por teléfono",
    ]
  ) {
    assert(requestsHumanRepresentative(text), text);
  }
  assertEquals(requestsHumanRepresentative("no me llamen, prefiero seguir por acá"), false);
  assertEquals(requestsHumanRepresentative("no quiero una llamada"), false);
  assertEquals(requestsHumanRepresentative("me llamo Luis Britez"), false);
});

Deno.test("incidente: registra aire frío/calor y termotanque sin inventar kWh", () => {
  const fields = explicitAgentFields(equipment);
  assert(fields.consumption_evidence);
  assertEquals(fields.consumo_mensual, undefined);
  const patch = safeAgentPatch(contact, fields, "comercial", equipment);
  assert(
    !conversationMissingFields("comercial", { ...contact, ...patch }).includes(
      "factura, consumo o lista de cargas",
    ),
  );
});

Deno.test("incidente: un pedido de llamada deriva aun si el modelo falla", async () => {
  let calls = 0;
  const decision = await modelDecision(
    contact,
    "comercial",
    [{ role: "user", content: "te puedo llamar?" }],
    "te puedo llamar?",
    async (_system) => {
      calls++;
      return calls === 1
        ? result(repeated)
        : result("Voy a pasar tu pedido de llamada al equipo para que continúe personalmente con vos.", true);
    },
  );
  assertEquals(calls, 0);
  assertEquals(decision.handoff, true);
  assert(!decision.reply.includes("factura"));
});

Deno.test("incidente: dos fallos de Claude nunca generan la respuesta fija de respaldo", async () => {
  let calls = 0;
  let rejected = false;
  try {
    await modelDecision(
      contact,
      "comercial",
      [{ role: "assistant", content: repeated }, { role: "user", content: equipment }],
      equipment,
      async () => {
        calls++;
        return result(repeated);
      },
    );
  } catch (error) {
    rejected = String(error).includes("Claude decision rejected");
  }
  assertEquals(calls, 2);
  assert(rejected);
});

Deno.test("incidente: conserva una derivación válida generada por Claude", async () => {
  const decision = await modelDecision(
    contact,
    "comercial",
    [{ role: "user", content: "llamame" }],
    "llamame",
    async () =>
      result("Registro tu pedido de llamada para que el equipo continúe con el proyecto del hotel.", true),
  );
  assertEquals(decision.handoff, true);
  assert(decision.reply.includes("llamada"));
});

Deno.test("incidente: detecta duplicados anteriores aunque cambien mayúsculas, tildes o puntuación", () => {
  assert(repeatsPreviousAssistantReply(repeated.toUpperCase().replaceAll("?", "!"), [
    { role: "assistant", content: repeated },
    { role: "user", content: equipment },
    { role: "assistant", content: "Gracias por los datos." },
  ]));
});

Deno.test("incidente: incorpora respuestas enviadas por reintentos aunque falten en CRM", () => {
  const history = mergeDeliveredHistory([{
    role: "user",
    content: "te puedo llamar?",
    created_at: "2026-09-21T14:14:00Z",
  }], [
    { content: repeated, sent_at: "2026-09-21T14:18:04Z", created_at: "2026-09-21T14:15:44Z" },
  ]);
  assertEquals(history.length, 2);
  assert(repeatsPreviousAssistantReply(repeated, history));
});

Deno.test("incidente: un envío completo retira su entrada aunque la cola siga pendiente", () => {
  const rows = [{
    id: 1,
    status: "sent",
    chunk_count: 1,
    metadata: { logical_key: "reply:a", inbound_event_ids: ["a"] },
  }];
  assertEquals([...coveredInboundIds(rows)], ["a"]);
  assertEquals([...coveredInboundIds([{ ...rows[0], chunk_count: 2 }])], []);
});

Deno.test("incidente: usa la hora original de un saludo que llegó 21 minutos tarde", () => {
  const event = {
    received_at: "2026-09-21T14:35:41Z",
    raw_payload: { info: { message: { channel_data: { message: { timestamp: 1790000061 } } } } },
  };
  assertEquals(new Date(inboundMessageTime(event)).toISOString(), "2026-09-21T14:14:21.000Z");
  assert(inboundMessageTime(event) < new Date("2026-09-21T14:20:22Z").getTime());
});
