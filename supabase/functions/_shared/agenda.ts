import { askClaude } from "./anthropic.ts";
import { db } from "./db.ts";
import { createGoogleEvent, deleteGoogleEvent, updateGoogleEvent } from "./google-calendar.ts";
import { syncAgendaToCrm } from "./crm-compat.ts";
import { ownerContext } from "./owner-context.ts";

type AgendaAction = {
  type: "create" | "update" | "cancel" | "none";
  id?: number;
  title?: string;
  description?: string;
  date_time?: string;
  duration_minutes?: number;
  location?: string;
  contact_name?: string;
  contact_phone?: string;
  attendee_emails?: string;
};

type AgendaDecision = { reply: string; actions: AgendaAction[] };

const AGENDA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "actions"],
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["create", "update", "cancel", "none"] },
          id: { type: "integer" },
          title: { type: "string" },
          description: { type: "string" },
          date_time: { type: "string" },
          duration_minutes: { type: "integer" },
          location: { type: "string" },
          contact_name: { type: "string" },
          contact_phone: { type: "string" },
          attendee_emails: { type: "string" },
        },
      },
    },
  },
};

const EDITABLE = [
  "title",
  "description",
  "date_time",
  "duration_minutes",
  "location",
  "contact_name",
  "contact_phone",
  "attendee_emails",
] as const;

// Only dates with an explicit offset are unambiguous.
function validDate(value: string | undefined): boolean {
  return Boolean(
    value && /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(new Date(value).getTime()),
  );
}

async function applyAction(action: AgendaAction): Promise<string | null> {
  if (action.type === "create") {
    if (!action.title || !validDate(action.date_time)) return "Me falta el título o la fecha y hora exactas para agendarlo.";
    const event = {
      title: action.title,
      description: action.description ?? null,
      date_time: action.date_time!,
      duration_minutes: action.duration_minutes ?? 60,
      location: action.location ?? null,
      contact_name: action.contact_name ?? null,
      contact_phone: action.contact_phone ?? null,
      attendee_emails: action.attendee_emails ?? null,
    };
    // A queue retry of the same message must not duplicate the event.
    const existing = await db().from("agent_agenda_events").select("id").eq("title", event.title)
      .eq("date_time", event.date_time).eq("status", "pendiente").limit(1).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return null;
    const googleEventId = await createGoogleEvent(event);
    const { data: created, error } = await db().from("agent_agenda_events")
      .insert({ ...event, google_event_id: googleEventId }).select("*").single();
    if (error) throw error;
    await syncAgendaToCrm(created);
    return null;
  }
  if (action.type !== "update" && action.type !== "cancel") return null;

  const current = await db().from("agent_agenda_events").select("*").eq("id", action.id ?? -1).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return "No encontré ese evento en la agenda.";
  if (action.type === "update" && action.date_time !== undefined && !validDate(action.date_time)) {
    return "Me falta la fecha y hora exactas para moverlo.";
  }
  const patch: Record<string, unknown> = action.type === "cancel"
    ? { status: "cancelado" }
    : Object.fromEntries(
      EDITABLE.filter((key) => action[key] !== undefined && action[key] !== "").map((key) => [key, action[key]]),
    );
  if (!Object.keys(patch).length) return null;
  // A rescheduled event needs its reminder again.
  if (patch.date_time) patch.reminder_sent = false;
  const googleId = current.data.google_event_id as string | null;
  if (googleId) {
    if (action.type === "cancel") await deleteGoogleEvent(googleId);
    else await updateGoogleEvent(googleId, { ...current.data, ...patch } as any);
  }
  const updated = await db().from("agent_agenda_events")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", current.data.id).select("*").single();
  if (updated.error) throw updated.error;
  // The CRM copy is matched by title and date, so retire the previous copy before a move.
  if (patch.date_time || patch.title) {
    const retired = await db().from("chatbot_agenda_events").update({ status: "cancelado" })
      .eq("title", current.data.title).eq("date_time", current.data.date_time);
    if (retired.error) throw retired.error;
  }
  await syncAgendaToCrm(updated.data);
  return null;
}

export async function processAgendaMessage(text: string): Promise<string> {
  const [eventsResult, historyResult, figures] = await Promise.all([
    db().from("agent_agenda_events")
      .select("id,title,date_time,duration_minutes,location,status,contact_name")
      .neq("status", "cancelado")
      .gte("date_time", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .order("date_time").limit(60),
    db().from("agent_agenda_messages").select("role,content,created_at")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .order("id", { ascending: false }).limit(16),
    ownerContext(),
  ]);
  if (eventsResult.error) throw eventsResult.error;
  if (historyResult.error) throw historyResult.error;

  const history = (historyResult.data ?? []).reverse()
    .map((row) => ({ role: row.role as "user" | "assistant", content: String(row.content ?? "") }))
    .filter((row) => row.content.trim());
  while (history.length && history[0].role !== "user") history.shift();

  const local = (value: string | Date) =>
    new Date(value).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      dateStyle: "full",
      timeStyle: "short",
    });
  const events = (eventsResult.data ?? []).map((event) => ({ ...event, hora_argentina: local(event.date_time) }));

  const raw = await askClaude(
    `Sos el asistente privado de gestión de Ricky, de SolarPower: agenda, estado de los sistemas solares y CRM. Le hablás por WhatsApp, en español rioplatense, breve y sin emojis ni Markdown.
Zona horaria: America/Argentina/Buenos_Aires (offset -03:00). Ahora es ${local(new Date())} (${new Date().toISOString()}).
Eventos vigentes: ${JSON.stringify(events)}
Datos actuales de sistemas y CRM (sólo lectura): ${JSON.stringify(figures)}

Reglas:
- Usá la conversación previa: si ya dijo el título o la hora antes, no lo vuelvas a preguntar.
- "create" para agendar o recordar algo: title y date_time en ISO-8601 con offset -03:00. Un recordatorio es un evento de 15 minutos.
- "update" para mover o corregir un evento existente y "cancel" para cancelarlo: usá su id. Nunca inventes ids.
- Podés devolver varias acciones si pide varias cosas. Si sólo consulta la agenda, respondé con los eventos y sin acciones.
- Si falta la fecha, la hora o el título, preguntá una sola cosa y no devuelvas acciones.
- No pongas attendee_emails salvo que Ricky te dé el email y pida invitar a esa persona.
- En reply confirmá título, día y hora de lo que hacés.
- Reportes: usá únicamente los datos de arriba, nunca inventes ni estimes números; null significa sin dato. Para un reporte de sistemas: producción total de hoy y de ayer, cuántos sistemas reportan (lectura de menos de 60 minutos), los que no reportan por nombre, y las alarmas activas. Para un reporte de CRM: leads nuevos, presupuestos y tareas vencidas. Si pregunta por un sistema puntual, respondé sólo ese.
- Desde acá no podés cambiar el CRM, enviar presupuestos ni escribirle a clientes: si lo pide, decilo claro. Los comandos que sí existen son: pausar o liberar un número, pausar bot, activar bot y estado del bot.
- reply: como máximo 900 caracteres, en líneas cortas.`,
    [...history, { role: "user", content: text }],
    1200,
    undefined,
    AGENDA_SCHEMA,
  );
  const decision = JSON.parse(raw) as AgendaDecision;

  const problems: string[] = [];
  for (const action of decision.actions ?? []) {
    const problem = await applyAction(action);
    if (problem) problems.push(problem);
  }
  const reply = problems.length ? [...new Set(problems)].join(" ") : decision.reply;

  const stored = await db().from("agent_agenda_messages").insert([
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ]);
  if (stored.error) throw stored.error;
  return reply;
}
