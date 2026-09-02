import { db, json } from "../_shared/db.ts";
import { createGoogleEvent } from "../_shared/google-calendar.ts";
import { normalizePhone } from "../_shared/meta.ts";
import { syncAgendaToCrm, syncContactToCrm } from "../_shared/crm-compat.ts";

const CONTACT_FIELDS = new Set([
  "name", "email", "label", "stage", "tipo", "bill_received", "roof_type",
  "connection_type", "locality", "product_interest", "notes", "human_mode",
]);
const AGENDA_FIELDS = new Set([
  "title", "description", "date_time", "duration_minutes", "location", "event_type",
  "contact_name", "contact_phone", "attendee_emails", "status", "reminder_sent",
]);

function cors(req: Request): Record<string, string> {
  return {
    "access-control-allow-origin": req.headers.get("origin") ?? "*",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "vary": "origin",
  };
}

function response(req: Request, data: unknown, status = 200): Response {
  const base = json(data, status);
  const headers = new Headers(base.headers);
  for (const [key, value] of Object.entries(cors(req))) headers.set(key, value);
  return new Response(base.body, { status, headers });
}

async function requireAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data: authData, error: authError } = await db().auth.getUser(token);
  if (authError || !authData.user) return false;
  const { data: profile } = await db().from("profiles").select("user_type")
    .eq("id", authData.user.id).maybeSingle();
  return String(profile?.user_type ?? "").toUpperCase() === "ADMIN";
}

function pick(body: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => allowed.has(key)));
}

function routeParts(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.indexOf("agent-admin-api");
  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : [];
}

async function contacts(req: Request, url: URL, parts: string[]): Promise<Response> {
  if (parts.length === 1 && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    let query = db().from("agent_contacts").select("*").order("last_contact", { ascending: false }).limit(limit);
    const search = url.searchParams.get("search");
    const stage = url.searchParams.get("stage");
    if (search) query = query.or(`name.ilike.%${search.replace(/[,%()]/g, "") }%,phone.ilike.%${search.replace(/[,%()]/g, "")}%`);
    if (stage) query = query.eq("stage", stage);
    const { data, error } = await query;
    if (error) throw error;
    return response(req, { contacts: data });
  }

  const phone = normalizePhone(parts[1] ?? "");
  if (!phone) return response(req, { error: "invalid_phone" }, 400);
  if (req.method === "GET") {
    const [{ data: contact, error }, { data: messages }, { data: actions }] = await Promise.all([
      db().from("agent_contacts").select("*").eq("phone", phone).maybeSingle(),
      db().from("agent_messages").select("*").eq("contact_phone", phone).order("created_at").limit(500),
      db().from("agent_pending_actions").select("*").eq("contact_phone", phone).order("created_at", { ascending: false }),
    ]);
    if (error) throw error;
    return response(req, { contact, messages, actions });
  }
  if (req.method === "PATCH") {
    const updates = pick(await req.json(), CONTACT_FIELDS);
    const { data, error } = await db().from("agent_contacts").update(updates).eq("phone", phone).select("*").single();
    if (error) throw error;
    await syncContactToCrm(data);
    return response(req, { contact: data });
  }
  return response(req, { error: "method_not_allowed" }, 405);
}

async function agenda(req: Request, url: URL, parts: string[]): Promise<Response> {
  if (parts.length === 1 && req.method === "GET") {
    const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const { data, error } = await db().from("agent_agenda_events").select("*")
      .gte("date_time", from).order("date_time").limit(500);
    if (error) throw error;
    return response(req, { events: data });
  }
  if (parts.length === 1 && req.method === "POST") {
    const event = pick(await req.json(), AGENDA_FIELDS);
    if (!event.title || !event.date_time) return response(req, { error: "title_and_date_time_required" }, 400);
    const googleEventId = await createGoogleEvent(event as any);
    const { data, error } = await db().from("agent_agenda_events").insert({ ...event, google_event_id: googleEventId }).select("*").single();
    if (error) throw error;
    await syncAgendaToCrm(data);
    return response(req, { event: data }, 201);
  }
  if (parts[1] && req.method === "PATCH") {
    const updates = pick(await req.json(), AGENDA_FIELDS);
    const { data, error } = await db().from("agent_agenda_events").update(updates).eq("id", parts[1]).select("*").single();
    if (error) throw error;
    await syncAgendaToCrm(data);
    return response(req, { event: data });
  }
  return response(req, { error: "method_not_allowed" }, 405);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response(req, null, 204);
  if (!(await requireAdmin(req))) return response(req, { error: "admin_required" }, 403);

  const url = new URL(req.url);
  const parts = routeParts(url);
  try {
    if (parts[0] === "contacts") return await contacts(req, url, parts);
    if (parts[0] === "agenda") return await agenda(req, url, parts);
    if (parts[0] === "actions" && req.method === "GET") {
      const { data, error } = await db().from("agent_pending_actions").select("*")
        .eq("resolved", false).order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return response(req, { actions: data });
    }
    if (parts[0] === "actions" && parts[1] && req.method === "PATCH") {
      const resolved = Boolean((await req.json()).resolved);
      const { data, error } = await db().from("agent_pending_actions").update({
        resolved,
        resolved_at: resolved ? new Date().toISOString() : null,
      }).eq("id", parts[1]).select("*").single();
      if (error) throw error;
      return response(req, { action: data });
    }
    if (parts[0] === "stats" && req.method === "GET") {
      const [{ count: contactsCount }, { count: openActions }, { count: messagesToday }] = await Promise.all([
        db().from("agent_contacts").select("*", { count: "exact", head: true }),
        db().from("agent_pending_actions").select("*", { count: "exact", head: true }).eq("resolved", false),
        db().from("agent_messages").select("*", { count: "exact", head: true })
          .gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      ]);
      return response(req, { contacts: contactsCount ?? 0, open_actions: openActions ?? 0, messages_today: messagesToday ?? 0 });
    }
    if (parts[0] === "settings" && req.method === "GET") {
      const { data, error } = await db().from("agent_settings").select("key,value,is_secret").eq("is_secret", false).order("key");
      if (error) throw error;
      return response(req, { settings: data });
    }
    if (parts[0] === "settings" && parts[1] === "bot_enabled" && req.method === "PATCH") {
      const enabled = Boolean((await req.json()).enabled);
      const { error } = await db().from("agent_settings").update({ value: String(enabled) }).eq("key", "bot_enabled");
      if (error) throw error;
      return response(req, { bot_enabled: enabled });
    }
    return response(req, { error: "not_found" }, 404);
  } catch (error) {
    console.error("agent-admin-api", error);
    return response(req, { error: "request_failed" }, 500);
  }
});
