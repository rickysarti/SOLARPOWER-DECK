import {
  conversationMissingFields,
  isQuoteEligible,
  quoteMissingFields,
  safeAgentPatch,
} from "../functions/_shared/agent-state.ts";
import { assert, assertEquals } from "./assert.ts";

const completeLead = {
  stage: null,
  product_interest: "Sistema solar",
  locality: "Córdoba",
  province: "Córdoba",
  consumo_mensual: 420,
  roof_type: "Techo de chapa, 60 m2",
  connection_type: "Trifásica",
  bill_received: false,
  agent_state: {},
};

Deno.test("un contacto antiguo con stage nulo puede completar presupuesto", () => {
  assertEquals(quoteMissingFields(completeLead), []);
  assert(isQuoteEligible("residencial", completeLead));
  assert(isQuoteEligible("comercial", completeLead));
});

Deno.test("solar más cargador completa y cargador solo no", () => {
  assert(isQuoteEligible("cargador_electrico", {
    ...completeLead,
    agent_state: { charger_scope: "solar_y_cargador" },
  }));
  assertEquals(
    isQuoteEligible("cargador_electrico", {
      ...completeLead,
      agent_state: { charger_scope: "solo_cargador" },
    }),
    false,
  );
});

Deno.test("el agente no pisa un cambio manual del CRM", () => {
  const contact = {
    ...completeLead,
    email: null,
    product_interest: "Valor fijado manualmente",
    agent_state: { extracted: { product_interest: "Valor anterior del agente" } },
  };
  const patch = safeAgentPatch(
    contact,
    { product_interest: "Nuevo valor del modelo", email: "lead@example.com" },
    "residencial",
  );
  assertEquals(patch.product_interest, undefined);
  assertEquals(patch.email, "lead@example.com");
});

Deno.test("academia pide nombre completo, email y localidad, no datos solares", () => {
  assertEquals(
    conversationMissingFields("academia", { name: "Tobias", email: null, locality: null }),
    ["nombre completo", "email", "localidad o provincia"],
  );
  assertEquals(
    conversationMissingFields("academia", {
      name: "Tobias Gómez",
      email: "tobias@example.com",
      locality: "La Plata",
    }),
    [],
  );
});

Deno.test("un nombre explícito reemplaza un perfil de WhatsApp sin letras", () => {
  const patch = safeAgentPatch(
    { name: "🪽🤍", agent_state: {} },
    { name: "Andrea" },
    "residencial",
  );
  assertEquals(patch.name, "Andrea");
});

Deno.test("no guarda una conexión inventada por el modelo", () => {
  const patch = safeAgentPatch(
    { connection_type: null, agent_state: {} },
    { connection_type: "monofásica" },
    "residencial",
    "Quiero un sistema on-grid de 5 kW en La Plata",
  );
  assertEquals(patch.connection_type, undefined);
});
