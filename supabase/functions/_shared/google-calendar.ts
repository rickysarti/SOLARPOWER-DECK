import { runtimeSecret } from "./db.ts";

type CalendarEvent = {
  title: string;
  description?: string | null;
  date_time: string;
  duration_minutes?: number;
  location?: string | null;
  attendee_emails?: string | null;
};

async function accessToken(): Promise<string | null> {
  const clientId = await runtimeSecret("GOOGLE_CLIENT_ID");
  const clientSecret = await runtimeSecret("GOOGLE_CLIENT_SECRET");
  const refreshToken = await runtimeSecret("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error("Google OAuth refresh failed");
  return result.access_token;
}

export async function createGoogleEvent(event: CalendarEvent): Promise<string | null> {
  const token = await accessToken();
  if (!token) return null;
  const calendarId = encodeURIComponent(await runtimeSecret("GOOGLE_CALENDAR_ID") ?? "primary");
  const start = new Date(event.date_time);
  const end = new Date(start.getTime() + (event.duration_minutes ?? 60) * 60_000);
  const attendees = (event.attendee_emails ?? "").split(",").map((email) => email.trim()).filter(Boolean)
    .map((email) => ({ email }));
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: event.title,
        description: event.description ?? undefined,
        location: event.location ?? undefined,
        start: { dateTime: start.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
        end: { dateTime: end.toISOString(), timeZone: "America/Argentina/Buenos_Aires" },
        attendees: attendees.length ? attendees : undefined,
      }),
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Google Calendar ${response.status}: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result.id ?? null;
}
