import { assert, assertEquals } from "./assert.ts";
import {
  conversationResponseViolations,
  coveredInboundIds,
  mergeDeliveredHistory,
} from "../functions/_shared/conversation-safety.ts";
import { modelDecision } from "../functions/_shared/processor.ts";
import { AGENT_DECISION_SCHEMA } from "../functions/_shared/decision.ts";
import { operatorRepliesFromHistory } from "../functions/_shared/sendpulse-reconcile.ts";

const first =
  "Perfecto, Jero. Quedó registrado tu interés en la Academia Solar. Te vamos a contactar por email apenas tengamos novedades sobre modalidad y fecha de lanzamiento. Gracias por confiar en SolarPower.";
const second =
  "Perfecto, Jerónimo. Tu interés quedó registrado con tu email jero@example.com. Te vamos a contactar apenas tengamos novedades sobre la Academia. ¡Gracias por confiar en SolarPower!";
const history = [{ role: "assistant" as const, content: first }, {
  role: "user" as const,
  content: "Muchas gracias!",
}];

Deno.test("Academia: rechaza los dos cierres equivalentes del caso real", () => {
  const violations = conversationResponseViolations(second, history, "Muchas gracias!");
  assert(violations.some((v) => v.includes("comienzo")));
  assert(violations.some((v) => v.includes("contenido")));
  assert(violations.some((v) => v.includes("sólo agradeció")));
  assert(
    conversationResponseViolations(
      second.replace("Perfecto, Jerónimo.", "Genial."),
      history,
      "Muchas gracias!",
    ).some((v) => v.includes("contenido")),
  );
});

Deno.test("tono: detecta muletilla consecutiva con punto o coma", () => {
  for (const previous of ["Perfecto. Ya tengo el email.", "Perfecto, ya tengo el email."]) {
    assert(
      conversationResponseViolations("Perfecto. ¿De qué provincia sos?", [{
        role: "assistant",
        content: previous,
      }], "Jero").some((v) => v.includes("comienzo")),
    );
  }
  assertEquals(conversationResponseViolations("¿De qué provincia sos?", history, "Jero"), []);
});

Deno.test("cierre: agradecimiento breve no reinicia la inscripción", () => {
  assertEquals(conversationResponseViolations("De nada, Jerónimo.", history, "Muchas gracias!"), []);
});

Deno.test("continuidad: permite confirmar un email corregido y repetir a pedido", () => {
  const changed =
    "Tu interés quedó registrado con tu email nuevo@example.com. Te vamos a contactar cuando haya novedades.";
  assertEquals(
    conversationResponseViolations(changed, history, "Mi email correcto es nuevo@example.com"),
    [],
  );
  assertEquals(conversationResponseViolations(changed, history, "Me confirmás cómo quedó el registro?"), []);
});

Deno.test("historial: la hora de entrega precede a la respuesta aunque CRM sincronice después", () => {
  const merged = mergeDeliveredHistory([
    { role: "user", content: "Jeronimo Araoz", created_at: "2026-09-21T20:05:10Z" },
    { role: "assistant", content: "¿Cuál es tu nombre completo?", created_at: "2026-09-21T20:14:08Z" },
  ], [{
    content: "¿Cuál es tu nombre completo?",
    created_at: "2026-09-21T20:01:09Z",
    sent_at: "2026-09-21T20:04:04Z",
  }]);
  assertEquals(merged.map((m) => m.role), ["assistant", "user"]);
});

Deno.test("historial: no oculta repeticiones reales y une fragmentos de un mismo envío", () => {
  const merged = mergeDeliveredHistory([], [
    {
      content: "A",
      created_at: "2026-09-21T20:00:00Z",
      metadata: { logical_key: "one", logical_content: first },
    },
    {
      content: "B",
      created_at: "2026-09-21T20:00:01Z",
      metadata: { logical_key: "one", logical_content: first },
    },
    {
      content: first,
      created_at: "2026-09-21T20:05:00Z",
      metadata: { logical_key: "two", logical_content: first },
    },
  ]);
  assertEquals(merged.length, 2);
});

Deno.test("lote: tras registro enviado, el turno siguiente contiene solamente el agradecimiento", () => {
  const covered = coveredInboundIds([{
    id: 1,
    status: "sent",
    chunk_count: 1,
    metadata: { logical_key: "registration", inbound_event_ids: ["question", "email", "name"] },
  }]);
  const incoming = [
    { id: "question", content: "Es virtual?" },
    { id: "email", content: "jero@example.com" },
    { id: "name", content: "Jeronimo Araoz" },
    { id: "thanks", content: "Muchas gracias!" },
  ];
  assertEquals(incoming.filter((e) => !covered.has(e.id)).map((e) => e.content), ["Muchas gracias!"]);
});

Deno.test("Claude: un cierre repetido se regenera con evidencia de las últimas respuestas", async () => {
  let calls = 0;
  const decision = await modelDecision(
    { phone: "preview", name: "Jeronimo Araoz", email: "jero@example.com", locality: "Tucumán" },
    "academia",
    history,
    "Muchas gracias!",
    async (system, messages) => {
      calls++;
      assert(system.includes("ultimas_respuestas_ya_enviadas"));
      assert(system.includes("Muchas gracias!"));
      assertEquals(messages, history);
      if (calls === 2) {
        assert(system.includes("Borrador rechazado"));
        assert(system.includes(second));
      }
      return JSON.stringify({
        reply: calls === 1 ? second : "De nada, Jerónimo.",
        classification: "academia",
        fields: {},
        missingFields: [],
        completeForQuote: false,
        handoff: false,
      });
    },
  );
  assertEquals(calls, 2);
  assertEquals(decision.reply, "De nada, Jerónimo.");
});

Deno.test("Claude: la decisión pide salida con esquema JSON para no fallar por JSON inválido", async () => {
  let schema: Record<string, unknown> | undefined;
  await modelDecision(
    { phone: "preview", name: "Ana", locality: "Morón" },
    "residencial",
    [{ role: "user", content: "Hola, quiero paneles" }],
    "Hola, quiero paneles",
    async (_system, _messages, _maxTokens, _image, outputSchema) => {
      schema = outputSchema;
      return JSON.stringify({
        reply: "Hola Ana, ¿tenés a mano una factura de luz?",
        classification: "residencial",
        fields: {},
        missingFields: [],
        completeForQuote: false,
        handoff: false,
        handoffReason: null,
        label: null,
      });
    },
  );
  assertEquals(schema, AGENT_DECISION_SCHEMA);
});

Deno.test("SendPulse: las respuestas manuales del inbox entran al historial, las del bot no se duplican", () => {
  const replies = operatorRepliesFromHistory(
    [
      { direction: 1, created_at: "2026-10-15T10:00:00Z", data: { text: { body: "Hola, quiero paneles" } } },
      { direction: 2, created_at: "2026-10-15T10:01:00Z", data: { text: { body: "Hola, ¿de qué localidad sos?" } } },
      { direction: 2, created_at: "2026-10-15T11:00:00Z", data: { text: { body: "Te llamo mañana a las 10." } } },
    ],
    [{
      content: "Hola, ¿de qué localidad sos?",
      created_at: "2026-10-15T10:01:00Z",
      metadata: { logical_content: "Hola, ¿de qué localidad sos?" },
    }],
  );
  assertEquals(replies, [{ content: "Te llamo mañana a las 10.", created_at: "2026-10-15T11:00:00.000Z" }]);
});
