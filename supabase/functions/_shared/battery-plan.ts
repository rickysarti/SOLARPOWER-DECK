export const BATTERY_PLAN_PRODUCT =
  "Plan Batería: paneles e inversor híbrido en alquiler + batería propia, ahorro y respaldo";

export const BATTERY_PLAN_POLICY = `PLAN BATERÍA
- El Plan Batería combina el alquiler del sistema solar (paneles e inversor híbrido) con la compra de la batería, que queda en propiedad del cliente. Está orientado al ahorro y al respaldo durante cortes. No lo confundas con el Plan SolarPower on-grid sin baterías.
- Si consulta por Plan Batería, incluso en un mensaje prearmado de la web o un anuncio, ya informó el producto y la necesidad. Registrá product_interest con el nombre del plan y su modalidad; no vuelvas a preguntar si busca ahorro o energía durante cortes ni reemplaces el plan por una venta genérica de un híbrido.
- En el primer mensaje reconocé el plan y explicá brevemente paneles en alquiler + batería propia. Respondé primero cualquier duda concreta y pedí como máximo un dato útil todavía faltante. Si pide cotización y no hay consumo, pedí una factura o consumo mensual aproximado. Si ya lo informó, avanzá con otro dato pendiente del proyecto.
- Ejemplo para una consulta inicial sin otros datos: "Hola, soy Tomás de SolarPower. El Plan Batería combina paneles e inversor híbrido en alquiler con una batería propia para ahorrar y tener respaldo ante cortes. ¿Me pasás una factura de luz o tu consumo mensual aproximado?"
- No prometas autonomía, ahorro, precio, anticipo, cuota ni condiciones particulares sin dimensionamiento y cotización. Respetá cambios de interés o negativas explícitas del cliente.`;

export function requestsBatteryPlan(text: string): boolean {
  return /\bplan\s+bater[ií]as?\b/i.test(text) &&
    !/\bno\s+(?:(?:quiero|busco|me interesa)\s+(?:el\s+)?)?plan\s+bater[ií]as?\b/i.test(text);
}

// Only reject the redundant choice. Questions about loads or autonomy remain useful.
export function batteryPlanReplyViolations(reply: string, product: string, incoming: string): string[] {
  if (!requestsBatteryPlan(incoming) && !requestsBatteryPlan(product)) return [];
  const questions = reply.match(/(?:¿[^?]*\?|[^.!?\n]*\?)/g) ?? [];
  const repeatsGoal = questions.some((question) =>
    /ahorr|factura/i.test(question) && /corte|respaldo|se (?:va|corta).*luz/i.test(question) &&
    /\bo\b|busc[aá]s|prefer[ií]s|(?:la )?idea es|te interesa/i.test(question)
  );
  return repeatsGoal
    ? [
      "el cliente ya eligió el Plan Batería para ahorro y respaldo; respondé sobre paneles en alquiler + batería propia y no vuelvas a preguntar el objetivo",
    ]
    : [];
}
