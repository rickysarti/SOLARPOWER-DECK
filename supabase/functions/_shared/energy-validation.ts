export function validateEnergyAnalysis(analysis: Record<string, any>, options: { requireEvidence?: boolean } = {}): string[] {
  const errors: string[] = [];
  const consumption = analysis?.consumption;
  const months = Array.isArray(consumption?.months) ? consumption.months : [];
  if (months.length !== 12) errors.push("El análisis no contiene exactamente 12 meses");
  const calendar = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const names = new Set<string>();
  let calculatedTotal = 0;
  for (const month of months) {
    const name = String(month?.month ?? "").trim().toLocaleLowerCase("es-AR");
    const kwh = Number(month?.kwh);
    if (!name || names.has(name)) errors.push("Los meses están vacíos o repetidos");
    if (name) names.add(name);
    if (!calendar.includes(name)) errors.push(`Mes desconocido: ${name}`);
    const evidence = month?.evidence;
    if (options.requireEvidence || evidence || month?.unit) {
      if (month.unit !== "kWh/month") errors.push(`Unidad mensual ausente o incorrecta: ${name}`);
      if (!evidence || !["MONTH_TOTAL", "DAILY_AVERAGE", "PERIOD_TOTAL", "ESTIMATE"].includes(evidence.basis)) {
        errors.push(`Falta evidencia de unidad y conversión: ${name}`);
      } else if (evidence.basis === "ESTIMATE") {
        if (!evidence.notes || !String(month.source).startsWith("ESTIMADO")) errors.push(`Estimación sin justificación: ${name}`);
      } else {
        const value = evidence.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !evidence.periodLabel || !evidence.unitLabel) {
          errors.push(`Evidencia original incompleta: ${name}`);
        }
        const dailyLabel = /kwh\s*\/\s*d[ií]a|diari|kwh\s*\/\s*day/i.test(String(evidence.unitLabel));
        if (evidence.basis === "MONTH_TOTAL" && dailyLabel) errors.push(`Promedio diario declarado como total mensual: ${name}`);
        let expected = value;
        if (evidence.basis !== "MONTH_TOTAL") {
          const year = month.year;
          const targetDays = evidence.targetDays;
          const calendarDays = Number.isInteger(year) && year >= 2000 && year <= 2200
            ? new Date(Date.UTC(year, calendar.indexOf(name) + 1, 0)).getUTCDate() : NaN;
          if (targetDays !== calendarDays) errors.push(`Días o año del mes inválidos: ${name}`);
          if (!String(month.source).startsWith("ESTIMADO")) errors.push(`Conversión a mes calendario etiquetada como real: ${name}`);
          if (evidence.basis === "PERIOD_TOTAL") {
            if (!Number.isInteger(evidence.days) || evidence.days <= 0 || evidence.days > 366) errors.push(`Días del período inválidos: ${name}`);
            expected = value / evidence.days * targetDays;
          } else expected = value * targetDays;
        }
        if (!Number.isFinite(expected) || Math.abs(kwh - expected) > Math.max(0.1, Math.abs(expected) * 0.001)) {
          errors.push(`Conversión diario/período a mensual incorrecta: ${name}`);
        }
      }
    }
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
  if (options.requireEvidence) {
    if (!invoiceHistory || !["kWh/day", "kWh/month", "kWh/period", "NONE"].includes(invoiceHistory.chartUnit)) {
      errors.push("Unidad del gráfico no verificada");
    }
    if (invoiceHistory?.chartDetected && (!invoiceHistory.chartAxisLabel || invoiceHistory.chartUnit === "NONE")) errors.push("Falta unidad visible del gráfico");
    if (invoiceHistory?.currentPeriod && (!Number.isInteger(invoiceHistory.currentDays) || invoiceHistory.currentDays <= 0 || invoiceHistory.currentDays > 366)) errors.push("Faltan días válidos del período facturado");
  }
  if (Number(invoiceHistory?.currentDays) > 0 && Number(invoiceHistory?.currentKwh) > 0) {
    const daily = Number(invoiceHistory.currentKwh) / Number(invoiceHistory.currentDays);
    if (invoiceHistory.currentDailyKwh != null && Math.abs(Number(invoiceHistory.currentDailyKwh) - daily) > Math.max(0.02, daily * 0.001)) errors.push("Promedio diario no coincide con factura y días");
    const normalizedMonth = daily * 30;
    if (average > 0 && (normalizedMonth / average > 10 || average / normalizedMonth > 10)) errors.push("Escala mensual incompatible con período facturado: revisar kWh/día y separadores numéricos");
  }
  return [...new Set(errors)];
}
