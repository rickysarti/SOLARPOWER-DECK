import { askClaude } from "./anthropic.ts";
import { db } from "./db.ts";
import { createGoogleEvent } from "./google-calendar.ts";
import { syncAgendaToCrm } from "./crm-compat.ts";

type AgendaDecision = {
  reply: string;
  action?: {
    type: "create" | "cancel" | "none";
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
};

function parseDecision(raw: string): AgendaDecision {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { reply: raw, action: { type: "none" } };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { reply: raw, action: { type: "none" } };
  }
}

export async function processAgendaMessage(text: string): Promise<string> {
  const { data: events, error } = await db().from("agent_agenda_events")
    .select("id,title,date_time,duration_minutes,location,status,contact_name")
    .gte("date_time", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .order("date_time")
    .limit(30);
  if (error) throw error;

  const raw = await askClaude(
    `Sos el asistente privado de agenda de SolarPower. Zona horaria: America/Argentina/Buenos_Aires.
Fecha actual: ${new Date().toISOString()}.
Eventos: ${JSON.stringify(events ?? [])}

Responde exclusivamente JSON valido con esta forma:
{"reply":"texto breve para WhatsApp","action":{"type":"create|cancel|none", "id":1, "title":"...", "description":"...", "date_time":"ISO-8601 con offset", "duration_minutes":60, "location":"...", "contact_name":"...", "contact_phone":"...", "attendee_emails":"..."}}
Para crear, exige fecha y hora inequívocas. Para cancelar, usa un id existente. Si falta informacion, pregunta y usa type none.`,
    [{ role: "user", content: text }],
    700,
  );
  const decision = parseDecision(raw);
  const action = decision.action;

  if (action?.type === "create" && action.title && action.date_time) {
    const event = {
      title: action.title,
      description: action.description ?? null,
      date_time: action.date_time,
      duration_minutes: action.duration_minutes ?? 60,
      location: action.location ?? null,
      contact_name: action.contact_name ?? null,
      contact_phone: action.contact_phone ?? null,
      attendee_emails: action.attendee_emails ?? null,
    };
    const googleEventId = await createGoogleEvent(event);
    const { data: created, error: insertError } = await db().from("agent_agenda_events").insert({
      ...event,
      google_event_id: googleEventId,
    }).select("*").single();
    if (insertError) throw insertError;
    await syncAgendaToCrm(created);
  } else if (action?.type === "cancel" && action.id) {
    const { error: updateError } = await db().from("agent_agenda_events")
      .update({ status: "cancelado" })
      .eq("id", action.id);
    if (updateError) throw updateError;
  }

  await db().from("agent_agenda_messages").insert([
    { role: "user", content: text },
    { role: "assistant", content: decision.reply },
  ]);
  return decision.reply;
}
