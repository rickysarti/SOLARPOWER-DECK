import { validateEnergyAnalysis } from "../functions/_shared/energy-validation.ts";
import { assert, assertEquals } from "./assert.ts";

const months = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

Deno.test("acepta un análisis energético coherente", () => {
  const analysis = {
    consumption: {
      months: months.map((month) => ({ month, kwh: 100 })),
      totalAnual: 1200,
      promedioMensual: 100,
    },
  };
  assertEquals(validateEnergyAnalysis(analysis), []);
});

Deno.test("rechaza consumo cero y totales incoherentes", () => {
  const analysis = {
    consumption: {
      months: months.map((month, index) => ({ month, kwh: index ? 100 : 0 })),
      totalAnual: 5000,
      promedioMensual: 0,
    },
  };
  const errors = validateEnergyAnalysis(analysis);
  assert(errors.some((error) => error.includes("inválido")));
  assert(errors.some((error) => error.includes("total anual")));
  assert(errors.some((error) => error.includes("promedio")));
});
