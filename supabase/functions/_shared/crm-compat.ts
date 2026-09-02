import { db } from "./db.ts";

const CONTACT_COLUMNS = [
  "phone", "name", "email", "label", "stage", "tipo", "bill_received",
  "roof_type", "connection_type", "locality", "product_interest", "notes",
  "notified_ricardo", "human_mode", "first_contact", "last_contact",
];

export async function readCrmContact(phone: string): Promise<Record<string, any> | null> {
  const { data, error } = await db().from("chatbot_wa_contacts").select(CONTACT_COLUMNS.join(","))
    .eq("phone", phone).maybeSingle();
  if (error) throw error;
  return data;
}

export async function syncContactToCrm(contact: Record<string, any>): Promise<void> {
  const row = Object.fromEntries(CONTACT_COLUMNS
    .filter((key) => contact[key] !== undefined)
    .map((key) => [key, contact[key]]));
  row.updated_at = new Date().toISOString();
  row.last_activity_at = contact.last_contact ?? row.updated_at;
  const { error } = await db().from("chatbot_wa_contacts").upsert(row, { onConflict: "phone" });
  if (error) throw error;
}

async function conversationId(phone: string, name: string | null): Promise<string> {
  const { data: existing, error } = await db().from("chatbot_conversations").select("id")
    .eq("contact_phone", phone).eq("channel", "whatsapp").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (existing?.id) return existing.id;
  const { data, error: insertError } = await db().from("chatbot_conversations").insert({
    contact_phone: phone,
    channel: "whatsapp",
    status: "active",
    title: name || phone,
    metadata: { source: "agent-supabase" },
  }).select("id").single();
  if (insertError) throw insertError;
  return data.id;
}

export async function syncMessageToCrm(input: {
  phone: string;
  name: string | null;
  role: "user" | "assistant";
  content: string;
  sourceId: string;
  model?: string | null;
}): Promise<void> {
  const conversation = await conversationId(input.phone, input.name);
  const { data: duplicate, error: lookupError } = await db().from("chatbot_messages").select("id")
    .eq("conversation_id", conversation).contains("metadata", { agent_source_id: input.sourceId }).limit(1).maybeSingle();
  if (lookupError) throw lookupError;
  if (duplicate) return;
  const { error } = await db().from("chatbot_messages").insert({
    conversation_id: conversation,
    role: input.role,
    content: input.content,
    model: input.model ?? null,
    metadata: { source: "agent-supabase", agent_source_id: input.sourceId },
  });
  if (error) throw error;
  await db().from("chatbot_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation);
}

export async function syncActionToCrm(action: Record<string, any>): Promise<void> {
  const { error } = await db().from("chatbot_pending_actions").insert({
    contact_phone: action.contact_phone,
    contact_name: action.contact_name ?? null,
    action_type: action.action_type,
    description: action.description ?? null,
    resolved: action.resolved ?? false,
  });
  if (error) throw error;
}

export async function syncAgendaToCrm(event: Record<string, any>): Promise<void> {
  const row = {
    sqlite_id: event.legacy_id ?? null,
    google_event_id: event.google_event_id ?? null,
    title: event.title,
    description: event.description ?? null,
    date_time: event.date_time,
    duration_minutes: event.duration_minutes ?? 60,
    location: event.location ?? null,
    event_type: event.event_type ?? "reunion",
    contact_name: event.contact_name ?? null,
    contact_phone: event.contact_phone ?? null,
    status: event.status ?? "pendiente",
    reminder_sent: event.reminder_sent ?? false,
    updated_at: new Date().toISOString(),
  };
  if (row.sqlite_id) {
    const { error } = await db().from("chatbot_agenda_events").upsert(row, { onConflict: "sqlite_id" });
    if (error) throw error;
    return;
  }
  const { data: duplicate, error: lookupError } = await db().from("chatbot_agenda_events").select("id")
    .eq("title", row.title).eq("date_time", row.date_time).limit(1).maybeSingle();
  if (lookupError) throw lookupError;
  if (duplicate) {
    await db().from("chatbot_agenda_events").update(row).eq("id", duplicate.id);
  } else {
    const { error } = await db().from("chatbot_agenda_events").insert(row);
    if (error) throw error;
  }
}
