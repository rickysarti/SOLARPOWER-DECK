import { db } from "./db.ts";

// Read-only figures for the owner's private assistant. Nothing here reaches customers.

function argentinaDate(offsetDays = 0): string {
  return new Date(Date.now() - 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function systemsContext() {
  const systems = await db().from("newapp_systems").select("id,name,api_brand,capacity_kw,has_battery")
    .eq("is_active", true).eq("polling_enabled", true).order("name").limit(200);
  if (systems.error) throw systems.error;
  const ids = (systems.data ?? []).map((row) => row.id);
  if (!ids.length) return { sistemas: [], alarmas: [] };
  const [daily, alarms, ...latest] = await Promise.all([
    db().from("newapp_daily_energy").select("system_id,date,total_kwh,import_kwh,export_kwh")
      .in("system_id", ids).gte("date", argentinaDate(-1)).limit(1000),
    db().from("newapp_alarms").select("system_id,severity,message,triggered_at").eq("is_active", true)
      .order("triggered_at", { ascending: false }).limit(20),
    ...ids.map((id) =>
      db().from("newapp_energy_readings").select("system_id,read_at,power_w,soc_pct").eq("system_id", id)
        .order("read_at", { ascending: false }).limit(1).maybeSingle()
    ),
  ]);
  if (daily.error) throw daily.error;
  if (alarms.error) throw alarms.error;
  const kwh = (id: string, date: string) =>
    (daily.data ?? []).find((row) => row.system_id === id && String(row.date).slice(0, 10) === date)?.total_kwh;
  const names = new Map((systems.data ?? []).map((row) => [row.id, row.name]));
  return {
    sistemas: (systems.data ?? []).map((row, index) => {
      const reading = latest[index]?.data as Record<string, any> | null;
      const minutes = reading ? Math.round((Date.now() - new Date(reading.read_at).getTime()) / 60_000) : null;
      const today = kwh(row.id, argentinaDate());
      const yesterday = kwh(row.id, argentinaDate(-1));
      return {
        nombre: row.name,
        marca: row.api_brand,
        kw: row.capacity_kw,
        hoy_kwh: today == null ? null : Number(Number(today).toFixed(1)),
        ayer_kwh: yesterday == null ? null : Number(Number(yesterday).toFixed(1)),
        potencia_w: reading?.power_w ?? null,
        bateria_pct: reading?.soc_pct ?? null,
        ultima_lectura_min: minutes,
      };
    }),
    alarmas: (alarms.data ?? []).map((row) => ({
      sistema: names.get(row.system_id) ?? null,
      severidad: row.severity,
      mensaje: String(row.message ?? "").slice(0, 160),
    })),
  };
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: total, error } = await query;
  if (error) throw error;
  return total ?? 0;
}

const STAGES = [
  "nuevo",
  "contactado",
  "calificado",
  "pendiente_presupuesto",
  "propuesta_enviada",
  "visita_pendiente",
  "oferta_enviada",
  "cerrado_ganado",
];

async function crmContext() {
  const today = `${argentinaDate()}T00:00:00-03:00`;
  const yesterday = `${argentinaDate(-1)}T00:00:00-03:00`;
  const head = { count: "exact" as const, head: true };
  const [newToday, newYesterday, drafts, approved, sentToday, pendingTasks, overdueTasks, recent, ...stages] =
    await Promise.all([
      count(db().from("chatbot_wa_contacts").select("phone", head).gte("first_contact", today)),
      count(
        db().from("chatbot_wa_contacts").select("phone", head).gte("first_contact", yesterday).lt("first_contact", today),
      ),
      count(db().from("presupuestos").select("id", head).eq("estado", "borrador")),
      count(db().from("presupuestos").select("id", head).eq("estado", "aprobado")),
      count(db().from("presupuestos").select("id", head).eq("estado", "enviado").gte("enviado_at", today)),
      count(db().from("crm_tasks").select("id", head).eq("estado", "pendiente")),
      count(
        db().from("crm_tasks").select("id", head).in("estado", ["pendiente", "en_progreso"]).lt("fecha_vencimiento", today),
      ),
      db().from("chatbot_wa_contacts").select("name,phone,locality,stage,human_mode,first_contact")
        .gte("first_contact", yesterday).order("first_contact", { ascending: false }).limit(12),
      ...STAGES.map((stage) => count(db().from("chatbot_wa_contacts").select("phone", head).eq("stage", stage))),
    ]);
  if (recent.error) throw recent.error;
  return {
    leads_nuevos_hoy: newToday,
    leads_nuevos_ayer: newYesterday,
    leads_por_etapa: Object.fromEntries(STAGES.map((stage, index) => [stage, stages[index]])),
    presupuestos: { borrador: drafts, aprobados_sin_enviar: approved, enviados_hoy: sentToday },
    tareas: { pendientes: pendingTasks, vencidas: overdueTasks },
    ultimos_leads: (recent.data ?? []).map((row) => ({
      nombre: row.name,
      telefono: row.phone,
      localidad: row.locality,
      etapa: row.stage,
      lo_atiende: row.human_mode ? "persona" : "bot",
    })),
  };
}

// A failing source is reported as unavailable instead of blocking the agenda.
export async function ownerContext(): Promise<Record<string, unknown>> {
  const [systems, crm] = await Promise.allSettled([systemsContext(), crmContext()]);
  const value = (result: PromiseSettledResult<unknown>, name: string) => {
    if (result.status === "fulfilled") return result.value;
    console.error("owner context", name, result.reason instanceof Error ? result.reason.message : result.reason);
    return "no disponible en este momento";
  };
  return { sistemas_solares: value(systems, "systems"), crm: value(crm, "crm") };
}
