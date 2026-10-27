import { assert, assertEquals } from "./assert.ts";
import { explicitAgentFields, quoteMissingFields } from "../functions/_shared/agent-state.ts";
import {
  BATTERY_PLAN_PRODUCT,
  batteryPlanReplyViolations,
  requestsBatteryPlan,
} from "../functions/_shared/battery-plan.ts";

const incoming = "Hola SolarPower! Quiero cotizar el Plan Batería (paneles en alquiler + batería propia)!";
const badReply =
  "Hola, soy Tomás de SolarPower. Para cotizar el Plan Batería, ¿la idea es ahorrar en la factura o también tener energía cuando se corta la luz?";
const goodReply =
  "Hola, soy Tomás de SolarPower. El Plan Batería combina paneles e inversor híbrido en alquiler con una batería propia para ahorrar y tener respaldo ante cortes. ¿Me pasás una factura de luz o tu consumo mensual aproximado?";

Deno.test("Plan Batería: reconoce el mensaje real y no deja pendiente el objetivo", () => {
  for (const text of [incoming, "Quiero información del plan bateria", "Me interesa el PLAN BATERÍA"]) {
    const fields = explicitAgentFields(text);
    assertEquals(fields.product_interest, BATTERY_PLAN_PRODUCT);
    assert(!quoteMissingFields(fields).includes("necesidad o producto"));
  }
});

Deno.test("Plan Batería: no confunde alquiler on-grid, batería existente ni negativas", () => {
  for (const text of ["Quiero el Plan SolarPower", "Ya tengo batería", "No quiero el Plan Batería"]) {
    assertEquals(requestsBatteryPlan(text), false);
    assert(explicitAgentFields(text).product_interest !== BATTERY_PLAN_PRODUCT);
  }
});

Deno.test("Plan Batería: bloquea la pregunta redundante, conserva consumo y cargas", () => {
  assertEquals(batteryPlanReplyViolations(badReply, "", incoming).length, 1);
  assertEquals(batteryPlanReplyViolations(badReply, BATTERY_PLAN_PRODUCT, "Hola").length, 1);
  assertEquals(batteryPlanReplyViolations(goodReply, "", incoming), []);
  assertEquals(
    batteryPlanReplyViolations("¿Qué equipos querés mantener encendidos durante los cortes?", "", incoming),
    [],
  );
  assertEquals(batteryPlanReplyViolations(badReply, "", "Hola, quiero información"), []);
});
