import {
  conversationMissingFields,
  explicitAgentFields,
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

Deno.test("extrae dos techos aunque el cliente no repita la palabra techo", () => {
  assertEquals(explicitAgentFields("Uno de chapa y otro de teja"), {
    roof_type: "Una casa con techo de chapa y otra con techo de tejas",
  });
  assertEquals(
    explicitAgentFields("Por la orientación del techo conviene hacer soporte para las pantallas"),
    { roof_type: "Estructura independiente a definir según orientación" },
  );
});

Deno.test("extrae nombre completo, off-grid y lista de cargas sin depender del modelo", () => {
  assertEquals(
    explicitAgentFields(
      "Soy Raul Maizterrena y quería dos kits sin conexión a la red para heladera, luces y bomba",
    ),
    {
      name: "Raul Maizterrena",
      connection_type: "off-grid sin red eléctrica",
      consumption_evidence: "lista de equipos proporcionada",
    },
  );
});

Deno.test("acepta un nombre completo escrito como respuesta directa", () => {
  assertEquals(explicitAgentFields("Tobias Fernando Bordón", "nombre completo"), {
    name: "Tobias Fernando Bordón",
  });
  assertEquals(explicitAgentFields("Buenos Aires", "localidad o provincia"), {
    province: "Buenos Aires",
  });
  const patch = safeAgentPatch(
    { name: "Tobias", agent_state: {} },
    { name: "Tobias Fernando Bordón" },
    "academia",
    "Tobias Fernando Bordón",
  );
  assertEquals(patch.name, "Tobias Fernando Bordón");
});

Deno.test("recupera datos explícitos antiguos aunque hayan quedado fuera del estado del agente", () => {
  assertEquals(explicitAgentFields("Están en Neuquén capital?"), {
    province: "Neuquén",
    locality: "Neuquén Capital",
  });
  assertEquals(explicitAgentFields("Mono", "tipo de conexión"), {
    connection_type: "monofásica",
  });
  assertEquals(explicitAgentFields("palaganij@hotmail.com"), {
    email: "palaganij@hotmail.com",
  });
  assertEquals(explicitAgentFields("475 kWh", "factura, consumo o lista de cargas"), {
    consumo_mensual: 475,
  });
});
