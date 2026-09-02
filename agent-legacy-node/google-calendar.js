/**
 * google-calendar.js
 * Módulo para sincronizar eventos con Google Calendar.
 * Usa OAuth2 con refresh_token (autorización única via scripts/google-auth.js).
 */

const { google } = require('googleapis');
const logger = require('./logger');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const TIMEZONE = 'America/Argentina/Buenos_Aires';

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getOAuth2Client() });
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET &&
            process.env.GOOGLE_REFRESH_TOKEN);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convierte un string de emails separados por coma en el formato de attendees de Google.
 */
function buildAttendees(attendeeEmails) {
  if (!attendeeEmails) return [];
  const emails = Array.isArray(attendeeEmails)
    ? attendeeEmails
    : String(attendeeEmails).split(',').map(e => e.trim()).filter(Boolean);
  return emails.map(email => ({ email }));
}

/**
 * Construye un resource de Google Calendar event desde los datos del evento local.
 */
function buildGoogleEvent(data) {
  const start = new Date(data.date_time);
  const end = new Date(start.getTime() + (data.duration_minutes || 60) * 60000);

  // Armar descripción enriquecida
  let desc = data.description || '';
  if (data.contact_name) {
    const contactLine = `Contacto: ${data.contact_name}${data.contact_phone ? ` — ${data.contact_phone}` : ''}`;
    desc = desc ? `${contactLine}\n${desc}` : contactLine;
  }

  const event = {
    summary: data.title,
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE }
  };

  if (desc)           event.description = desc;
  if (data.location)  event.location = data.location;

  const attendees = buildAttendees(data.attendee_emails);
  if (attendees.length > 0) event.attendees = attendees;

  return event;
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Crea un evento en Google Calendar y retorna el google_event_id.
 * Retorna null si no está configurado o si falla (sin tirar error).
 *
 * @param {Object} data - Datos del evento (title, date_time, duration_minutes, description, location, contact_name, contact_phone, attendee_emails)
 * @returns {string|null} google_event_id o null
 */
async function createCalendarEvent(data) {
  if (!isConfigured()) {
    logger.warn('[GCAL] Google Calendar no configurado (falta GOOGLE_REFRESH_TOKEN), saltando sync');
    return null;
  }
  try {
    const calendar = getCalendar();
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: buildGoogleEvent(data),
      sendUpdates: data.attendee_emails ? 'all' : 'none'
    });
    logger.info(`[GCAL] Evento creado: ${response.data.id} — "${data.title}"`);
    return response.data.id;
  } catch (error) {
    logger.error(`[GCAL] Error al crear evento "${data.title}": ${error.message}`);
    return null;
  }
}

/**
 * Actualiza un evento existente en Google Calendar.
 *
 * @param {string} googleEventId - ID del evento en Google Calendar
 * @param {Object} fullEventData - Datos completos del evento actualizado (de SQLite)
 */
async function updateCalendarEvent(googleEventId, fullEventData) {
  if (!isConfigured() || !googleEventId) return;
  try {
    const calendar = getCalendar();
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: googleEventId,
      resource: buildGoogleEvent(fullEventData),
      sendUpdates: 'all'
    });
    logger.info(`[GCAL] Evento actualizado: ${googleEventId}`);
  } catch (error) {
    logger.error(`[GCAL] Error al actualizar evento ${googleEventId}: ${error.message}`);
  }
}

/**
 * Elimina (cancela) un evento en Google Calendar.
 *
 * @param {string} googleEventId - ID del evento en Google Calendar
 */
async function deleteCalendarEvent(googleEventId) {
  if (!isConfigured() || !googleEventId) return;
  try {
    const calendar = getCalendar();
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: googleEventId,
      sendUpdates: 'all'
    });
    logger.info(`[GCAL] Evento eliminado: ${googleEventId}`);
  } catch (error) {
    // Si ya no existe en Google Calendar, no es un error fatal
    if (error.code === 410 || error.code === 404) {
      logger.warn(`[GCAL] Evento ${googleEventId} ya no existe en Google Calendar`);
    } else {
      logger.error(`[GCAL] Error al eliminar evento ${googleEventId}: ${error.message}`);
    }
  }
}

module.exports = { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent };
