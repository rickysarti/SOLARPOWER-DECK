import { assert, assertEquals } from "./assert.ts";
import { explicitAgentFields } from "../functions/_shared/agent-state.ts";
import { conversationResponseViolations } from "../functions/_shared/conversation-safety.ts";

Deno.test("ambas incluye para ambas y conserva el pedido de respaldo", () => {
  assert(explicitAgentFields("Para ambas", "necesidad o producto").product_interest?.includes("híbrido"));
  assert(
    explicitAgentFields("Quiero paneles con baterías para ahorrar en la factura").product_interest?.includes(
      "híbrido",
    ),
  );
});
Deno.test("superficies informadas no se pierden", () => {
  assertEquals(explicitAgentFields("Tierra firme").roof_type, "Suelo: tierra firme");
  assertEquals(explicitAgentFields("Tengo el techo de material").roof_type, "Techo de material");
});
Deno.test("no repite presentación ni promete alquiler sin anticipo", () => {
  const history = [{ role: "assistant" as const, content: "Hola, soy Tomás de SolarPower." }];
  assert(
    conversationResponseViolations("Hola, soy Tomás. Gracias por escribirnos.", history, "Ambas").length,
  );
  assert(
    conversationResponseViolations(
      "El Plan SolarPower es sin invertir de entrada.",
      history,
      "Quiero el plan",
    ).length,
  );
  assertEquals(
    conversationResponseViolations(
      "Un híbrido con baterías permite ahorrar y respaldar consumos esenciales.",
      history,
      "Ambas",
    ).length,
    0,
  );
});

Deno.test("una confirmación antes de la pregunta no cuenta como volver a pedir ese dato", async () => {
  const { replyRequestsField } = await import("../functions/_shared/processor.ts");
  assertEquals(
    replyRequestsField(
      "Un híbrido sirve para ahorro y respaldo. ¿Me pasás la factura?",
      "necesidad o producto",
    ),
    false,
  );
  assertEquals(
    replyRequestsField("Conexión monofásica anotada. ¿Qué techo tenés?", "tipo de conexión"),
    false,
  );
  assertEquals(replyRequestsField("¿Tu conexión es monofásica?", "tipo de conexión"), true);
});
