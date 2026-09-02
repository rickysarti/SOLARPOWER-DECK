/**
 * crm-api.js
 * SolarPower CRM — Servidor API local
 * Puerto: 3001
 *
 * Levantarlo con: node crm-api.js
 * (Desde la carpeta solarpower-agent)
 *
 * NO modifica el bot. Solo lee/escribe la misma DB SQLite que usa el bot
 * y sincroniza cambios a Supabase.
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.CRM_PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── SQLite ───────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'solarpower.db');
const db = new Database(DB_PATH);
try {
  db.exec('ALTER TABLE contacts ADD COLUMN email TEXT');
} catch (e) { /* Ya existe */ }

// ─── Supabase (opcional) ──────────────────────────────────────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
}

// ─── Google Calendar (opcional) ───────────────────────────────────────────────
function getCalendar() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost'
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

// ─── Helper: sync contact to Supabase ────────────────────────────────────────
async function syncContactToSupabase(contact) {
  if (!supabase) return;
  try {
    await supabase.from('chatbot_wa_contacts').upsert({
      phone:            contact.phone,
      name:             contact.name            || null,
      email:            contact.email           || null,
      label:            contact.label           || 'Interesado',
      stage:            contact.stage           || 'nuevo',
      bill_received:    !!contact.bill_received,
      roof_type:        contact.roof_type       || null,
      connection_type:  contact.connection_type || null,
      locality:         contact.locality        || null,
      product_interest: contact.product_interest|| null,
      human_mode:       !!contact.human_mode,
      notified_ricardo: !!contact.notified_ricardo,
      notes:            contact.notes           || null,
      first_contact:    contact.first_contact   || new Date().toISOString(),
      last_contact:     contact.last_contact    || new Date().toISOString(),
      updated_at:       new Date().toISOString()
    }, { onConflict: 'phone' });
  } catch (e) {
    console.warn('[SUPABASE] syncContact error:', e.message);
  }
}

// ─── STAGES definition ────────────────────────────────────────────────────────
const STAGES = [
  { id: 'Interesado',                         color: '#3B82F6', icon: '🔵' },
  { id: 'Pendiente enviar presupuesto',        color: '#F59E0B', icon: '🟡' },
  { id: 'Presupuesto enviado',                 color: '#8B5CF6', icon: '🟣' },
  { id: 'Visita programada',                   color: '#10B981', icon: '🟢' },
  { id: 'Pendiente enviar presupuesto final',  color: '#EF4444', icon: '🔴' },
  { id: 'Venta cerrada',                       color: '#059669', icon: '✅' },
  { id: 'Cliente Solarpower',                  color: '#F97316', icon: '⭐' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: DB_PATH, supabase: !!supabase, calendar: !!process.env.GOOGLE_CLIENT_ID });
});

// GET /api/stages
app.get('/api/stages', (req, res) => res.json(STAGES));

// ─── STATS ────────────────────────────────────────────────────────────────────

// GET /api/stats
app.get('/api/stats', (req, res) => {
  try {
    const total     = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
    const today     = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE date(last_contact) = date('now')").get().n;
    const paused    = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE human_mode = 1').get().n;
    const pending   = db.prepare('SELECT COUNT(*) as n FROM pending_actions WHERE resolved = 0').get().n;
    const byLabel   = db.prepare("SELECT label, COUNT(*) as n FROM contacts GROUP BY label ORDER BY n DESC").all();
    const msgToday  = db.prepare("SELECT COUNT(*) as n FROM messages WHERE date(timestamp) = date('now')").get().n;
    const upcoming  = db.prepare("SELECT COUNT(*) as n FROM agenda_events WHERE status='pendiente' AND datetime(date_time) > datetime('now')").get().n;

    res.json({ total, today, paused, pending, byLabel, msgToday, upcoming });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CONTACTS ─────────────────────────────────────────────────────────────────

// GET /api/contacts?search=&label=&paused=
app.get('/api/contacts', (req, res) => {
  try {
    const { search, label, paused, limit = 200 } = req.query;
    let sql = `
      SELECT c.*,
        (SELECT content FROM messages m WHERE m.contact_phone = c.phone ORDER BY m.timestamp DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.contact_phone = c.phone) as msg_count,
        (SELECT COUNT(*) FROM pending_actions pa WHERE pa.contact_phone = c.phone AND pa.resolved = 0) as pending_count
      FROM contacts c WHERE 1=1
    `;
    const params = [];

    if (search) {
      sql += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (label) {
      sql += ' AND c.label = ?';
      params.push(label);
    }
    if (paused === 'true') {
      sql += ' AND c.human_mode = 1';
    }

    sql += ' ORDER BY c.last_contact DESC LIMIT ?';
    params.push(parseInt(limit));

    const contacts = db.prepare(sql).all(...params);
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:phone
app.get('/api/contacts/:phone', (req, res) => {
  try {
    const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(req.params.phone);
    if (!contact) return res.status(404).json({ error: 'Not found' });

    const pending = db.prepare(
      'SELECT * FROM pending_actions WHERE contact_phone = ? ORDER BY created_at DESC'
    ).all(req.params.phone);

    const events = db.prepare(
      "SELECT * FROM agenda_events WHERE contact_phone = ? ORDER BY date_time DESC LIMIT 10"
    ).all(req.params.phone);

    res.json({ ...contact, pending_actions: pending, agenda_events: events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/contacts/:phone
app.patch('/api/contacts/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const allowed = ['name', 'email', 'label', 'stage', 'human_mode', 'notes', 'locality',
                     'roof_type', 'connection_type', 'product_interest', 'bill_received'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.last_contact = new Date().toISOString();
    const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE contacts SET ${setClauses} WHERE phone = ?`).run(...Object.values(fields), phone);

    const updated = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
    await syncContactToSupabase(updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/:phone/messages?limit=50
app.get('/api/contacts/:phone/messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = db.prepare(
      'SELECT * FROM messages WHERE contact_phone = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(req.params.phone, limit).reverse();
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PENDING ACTIONS ──────────────────────────────────────────────────────────

// GET /api/pending-actions?resolved=false
app.get('/api/pending-actions', (req, res) => {
  try {
    const { resolved } = req.query;
    let sql = `
      SELECT pa.*, c.name as contact_name, c.label as contact_label
      FROM pending_actions pa
      LEFT JOIN contacts c ON pa.contact_phone = c.phone
    `;
    const params = [];
    if (resolved !== 'true') {
      sql += ' WHERE pa.resolved = 0';
    }
    sql += ' ORDER BY pa.created_at DESC LIMIT 100';

    res.json(db.prepare(sql).all(...params));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/pending-actions/:id
app.patch('/api/pending-actions/:id', (req, res) => {
  try {
    db.prepare('UPDATE pending_actions SET resolved = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AGENDA ───────────────────────────────────────────────────────────────────

// GET /api/agenda?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/agenda', (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const to   = req.query.to   || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

    const events = db.prepare(`
      SELECT * FROM agenda_events
      WHERE date(date_time) >= date(?) AND date(date_time) <= date(?)
      ORDER BY date_time ASC
    `).all(from, to);
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agenda
app.post('/api/agenda', async (req, res) => {
  try {
    const { title, description, date_time, duration_minutes = 90,
            location, event_type = 'visita', contact_name, contact_phone,
            add_to_gcal = true } = req.body;

    if (!title || !date_time) return res.status(400).json({ error: 'title y date_time son requeridos' });

    // Insertar en SQLite
    const result = db.prepare(`
      INSERT INTO agenda_events (title, description, date_time, duration_minutes, location, event_type, contact_name, contact_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, description || null, date_time, duration_minutes, location || null, event_type, contact_name || null, contact_phone || null);

    const event = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(result.lastInsertRowid);

    // Google Calendar
    let googleEventId = null;
    if (add_to_gcal) {
      try {
        const cal = getCalendar();
        if (cal) {
          const start = new Date(date_time);
          const end   = new Date(start.getTime() + duration_minutes * 60000);
          let desc = description || '';
          if (contact_name) desc = `Contacto: ${contact_name}${contact_phone ? ` — ${contact_phone}` : ''}\n${desc}`;

          const gcalEvent = await cal.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            requestBody: {
              summary:     title,
              description: desc.trim(),
              location:    location || undefined,
              start: { dateTime: start.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
              end:   { dateTime: end.toISOString(),   timeZone: 'America/Argentina/Buenos_Aires' },
            }
          });
          googleEventId = gcalEvent.data.id;
          db.prepare('UPDATE agenda_events SET google_event_id = ? WHERE id = ?').run(googleEventId, event.id);
        }
      } catch (gcalErr) {
        console.warn('[GCAL] Error al crear evento:', gcalErr.message);
      }
    }

    // Supabase sync
    if (supabase) {
      supabase.from('chatbot_agenda_events').upsert({
        sqlite_id: event.id, google_event_id: googleEventId, title, description: description || null,
        date_time, duration_minutes, location: location || null, event_type,
        contact_name: contact_name || null, contact_phone: contact_phone || null,
        status: 'pendiente', reminder_sent: false, updated_at: new Date().toISOString()
      }, { onConflict: 'sqlite_id' }).then(() => {}).catch(e => console.warn('[SB]', e.message));
    }

    res.json({ ...event, google_event_id: googleEventId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/agenda/:id
app.delete('/api/agenda/:id', async (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    db.prepare("UPDATE agenda_events SET status = 'cancelado' WHERE id = ?").run(req.params.id);

    if (event.google_event_id) {
      try {
        const cal = getCalendar();
        if (cal) await cal.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', eventId: event.google_event_id });
      } catch (e) { console.warn('[GCAL] Error borrando:', e.message); }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BOT GLOBAL PAUSE ─────────────────────────────────────────────────────────

// GET /api/bot/status
app.get('/api/bot/status', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'bot_paused'").get();
    res.json({ paused: row?.value === '1' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bot/pause
app.post('/api/bot/pause', (req, res) => {
  try {
    const { paused } = req.body;
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('bot_paused', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(paused ? '1' : '0');
    res.json({ success: true, paused: !!paused });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ENERGY ANALYSIS (proxy al agente de análisis) ────────────────────────────

const ENERGY_URL = process.env.ENERGY_ANALYZER_URL || 'http://localhost:3002';
const http  = require('http');
const https = require('https');

// GET /api/energy/status — chequea si el agente de análisis está corriendo
app.get('/api/energy/status', (req, res) => {
  const url = new URL(`${ENERGY_URL}/health`);
  const mod = url.protocol === 'https:' ? https : http;
  const req2 = mod.get(url.toString(), (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => { try { res.json({ online: true, ...JSON.parse(data) }); } catch { res.json({ online: true }); } });
  });
  req2.on('error', () => res.json({ online: false }));
  req2.setTimeout(3000, () => { req2.destroy(); res.json({ online: false }); });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🌞 SolarPower CRM API corriendo en http://localhost:${PORT}`);
  console.log(`   DB:       ${DB_PATH}`);
  console.log(`   Supabase: ${supabase ? '✅ conectado' : '❌ no configurado'}`);
  console.log(`   GCal:     ${process.env.GOOGLE_CLIENT_ID ? '✅ configurado' : '❌ no configurado'}`);
  console.log(`\n   Abrí solarpower-crm.html en tu browser para usar el CRM\n`);
});
