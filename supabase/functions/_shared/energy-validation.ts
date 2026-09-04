export function validateEnergyAnalysis(analysis: Record<string, any>): string[] {
  const errors: string[] = [];
  const consumption = analysis?.consumption;
  const months = Array.isArray(consumption?.months) ? consumption.months : [];
  if (months.length !== 12) errors.push("El análisis no contiene exactamente 12 meses");
  const names = new Set<string>();
  let calculatedTotal = 0;
  for (const month of months) {
    const name = String(month?.month ?? "").trim().toLocaleLowerCase("es-AR");
    const kwh = Number(month?.kwh);
    if (!name || names.has(name)) errors.push("Los meses están vacíos o repetidos");
    if (name) names.add(name);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      errors.push(`Consumo mensual inválido para ${name || "mes sin nombre"}`);
    } else calculatedTotal += kwh;
  }
  const total = Number(consumption?.totalAnual);
  const average = Number(consumption?.promedioMensual);
  if (!Number.isFinite(total) || total <= 0) errors.push("El consumo anual debe ser positivo");
  if (!Number.isFinite(average) || average <= 0) errors.push("El consumo promedio debe ser positivo");
  if (Number.isFinite(total) && total > 0 && calculatedTotal > 0) {
    const tolerance = Math.max(2, calculatedTotal * 0.02);
    if (Math.abs(total - calculatedTotal) > tolerance) {
      errors.push("El total anual no coincide con los meses");
    }
    const expectedAverage = total / 12;
    if (
      Number.isFinite(average) && Math.abs(average - expectedAverage) > Math.max(0.5, expectedAverage * 0.02)
    ) {
      errors.push("El promedio mensual no coincide con el total anual");
    }
  }
  const invoiceHistory = consumption?.invoiceHistory;
  if (invoiceHistory?.currentPeriod && !(Number(invoiceHistory.currentKwh) > 0)) {
    errors.push("El período actual tiene un consumo inválido");
  }
  return [...new Set(errors)];
}
