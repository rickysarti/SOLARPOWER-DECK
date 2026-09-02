/**
 * database.js
 * Manejo de la base de datos SQLite con better-sqlite3.
 * Crea automáticamente las tablas si no existen.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Ruta a la base de datos (configurable por .env)
const DB_PATH = process.env.DB_PATH || './data/solarpower.db';

// Crear el directorio si no existe
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Inicializar la conexión
const db = new Database(DB_PATH);

// Activar WAL mode para mejor performance con lecturas concurrentes
db.pragma('journal_mode = WAL');

// ─── Creación de tablas ───────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    phone             TEXT UNIQUE NOT NULL,
    name              TEXT,
    email             TEXT,
    label             TEXT DEFAULT 'Interesado',
    stage             TEXT DEFAULT 'nuevo',
    bill_received     INTEGER DEFAULT 0,
    roof_type         TEXT,
    connection_type   TEXT,
    locality          TEXT,
    product_interest  TEXT,
    first_contact     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_contact      DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes             TEXT,
    notified_ricardo  INTEGER DEFAULT 0,
    human_mode        INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_phone  TEXT NOT NULL,
    role           TEXT NOT NULL,
    content        TEXT NOT NULL,
    timestamp      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_phone) REFERENCES contacts(phone)
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_phone  TEXT NOT NULL,
    action_type    TEXT NOT NULL,
    description    TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agenda_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    description      TEXT,
    date_time        DATETIME NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    location         TEXT,
    event_type       TEXT DEFAULT 'reunion',
    contact_name     TEXT,
    contact_phone    TEXT,
    status           TEXT DEFAULT 'pendiente',
    reminder_sent    INTEGER DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agenda_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent        INTEGER DEFAULT 0,
    sent_at     DATETIME
  );

  CREATE TABLE IF NOT EXISTS conversation_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_phone  TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    label          TEXT,
    summary        TEXT NOT NULL,
    metadata       TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_phone) REFERENCES contacts(phone)
  );
`);

// Migración: agregar human_mode si no existe
try {
  db.exec('ALTER TABLE contacts ADD COLUMN human_mode INTEGER DEFAULT 0');
  logger.info('Migración: columna human_mode agregada');
} catch (e) { /* Ya existe */ }

// Migración: agregar google_event_id a agenda_events
try {
  db.exec('ALTER TABLE agenda_events ADD COLUMN google_event_id TEXT');
  logger.info('Migración: columna google_event_id agregada a agenda_events');
} catch (e) { /* Ya existe */ }

// Migración: agregar tipo de contacto (residencial/comercial/academia/cv/otro)
try {
  db.exec('ALTER TABLE contacts ADD COLUMN tipo TEXT');
  logger.info('Migración: columna tipo agregada a contacts');
} catch (e) { /* Ya existe */ }

// Migración: contador de intentos de clasificación "otro"
try {
  db.exec('ALTER TABLE contacts ADD COLUMN otro_count INTEGER DEFAULT 0');
  logger.info('Migración: columna otro_count agregada a contacts');
} catch (e) { /* Ya existe */ }

try {
  db.exec('ALTER TABLE contacts ADD COLUMN email TEXT');
  logger.info('Migracion: columna email agregada a contacts');
} catch (e) { /* Ya existe */ }

logger.info(`Base de datos inicializada en: ${DB_PATH}`);

// ─── Funciones exportadas ─────────────────────────────────────────────────────

/**
 * Obtiene un contacto por teléfono. Si no existe, lo crea.
 * @param {string} phone - Número de teléfono internacional sin '+'
 * @param {string|null} name - Nombre del contacto (opcional)
 * @returns {Object} Contacto de la base de datos
 */
function getOrCreateContact(phone, name = null) {
  try {
    // Intentar obtener el contacto existente
    let contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);

    if (!contact) {
      // Crear nuevo contacto
      db.prepare(`
        INSERT INTO contacts (phone, name)
        VALUES (?, ?)
      `).run(phone, name);

      contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
      logger.info(`Nuevo contacto creado: ${phone} (${name || 'sin nombre'})`);
    } else if (name && !contact.name) {
      // Actualizar nombre si no tenía
      db.prepare('UPDATE contacts SET name = ? WHERE phone = ?').run(name, phone);
      contact.name = name;
    }

    return contact;
  } catch (error) {
    logger.error(`Error en getOrCreateContact: ${error.message}`);
    throw error;
  }
}

/**
 * Actualiza campos de un contacto.
 * @param {string} phone - Número de teléfono
 * @param {Object} fields - Campos a actualizar (ej: { label: 'nuevo', stage: 'activo' })
 */
function updateContact(phone, fields) {
  try {
    if (!fields || Object.keys(fields).length === 0) return;

    // Siempre actualizar last_contact
    fields.last_contact = new Date().toISOString();

    const setClauses = Object.keys(fields).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(fields), phone];

    db.prepare(`UPDATE contacts SET ${setClauses} WHERE phone = ?`).run(...values);
    logger.debug(`Contacto actualizado: ${phone} → ${JSON.stringify(fields)}`);
  } catch (error) {
    logger.error(`Error en updateContact: ${error.message}`);
    throw error;
  }
}

/**
 * Guarda un mensaje en la base de datos.
 * @param {string} phone - Número de teléfono del contacto
 * @param {string} role - 'user' o 'assistant'
 * @param {string} content - Contenido del mensaje
 */
function saveMessage(phone, role, content) {
  try {
    db.prepare(`
      INSERT INTO messages (contact_phone, role, content)
      VALUES (?, ?, ?)
    `).run(phone, role, content);
  } catch (error) {
    logger.error(`Error en saveMessage: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene el historial de mensajes de un contacto, formateado para Claude.
 * @param {string} phone - Número de teléfono
 * @param {number} limit - Cantidad máxima de mensajes a retornar
 * @returns {Array} Array de { role, content } para la API de Claude
 */
function getHistory(phone, limit = 20) {
  try {
    const rows = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE contact_phone = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(phone, limit);

    // Invertir para tener orden cronológico (más antiguo primero)
    return rows.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));
  } catch (error) {
    logger.error(`Error en getHistory: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene un contacto por teléfono.
 * @param {string} phone - Número de teléfono
 * @returns {Object|null} Contacto o null si no existe
 */
function getContact(phone) {
  try {
    return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone) || null;
  } catch (error) {
    logger.error(`Error en getContact: ${error.message}`);
    throw error;
  }
}

/**
 * Activa o desactiva el modo humano para un contacto.
 * Cuando está activo, el bot no responde a ese número.
 * @param {string} phone - Número de teléfono
 * @param {boolean} enabled - true para activar, false para desactivar
 * @returns {boolean} false si el contacto no existe
 */
function setHumanMode(phone, enabled) {
  try {
    const contact = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(phone);
    if (!contact) return false;
    db.prepare('UPDATE contacts SET human_mode = ? WHERE phone = ?').run(enabled ? 1 : 0, phone);
    logger.info(`Modo humano ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} para ${phone}`);
    return true;
  } catch (error) {
    logger.error(`Error en setHumanMode: ${error.message}`);
    throw error;
  }
}

/**
 * Indica si un contacto tiene el modo humano activo.
 * @param {string} phone - Número de teléfono
 * @returns {boolean}
 */
function isHumanMode(phone) {
  try {
    const row = db.prepare('SELECT human_mode FROM contacts WHERE phone = ?').get(phone);
    return row ? row.human_mode === 1 : false;
  } catch (error) {
    logger.error(`Error en isHumanMode: ${error.message}`);
    return false;
  }
}

/**
 * Agrega una acción pendiente para Ricardo.
 * @param {string} phone - Número de teléfono del contacto
 * @param {string} type - Tipo: 'send_budget', 'call', 'visit', 'support'
 * @param {string} description - Descripción de la acción
 */
function addPendingAction(phone, type, description) {
  try {
    db.prepare(`
      INSERT INTO pending_actions (contact_phone, action_type, description)
      VALUES (?, ?, ?)
    `).run(phone, type, description);
    logger.info(`Acción pendiente agregada: ${type} para ${phone}`);
  } catch (error) {
    logger.error(`Error en addPendingAction: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene todas las acciones pendientes sin resolver.
 * @returns {Array} Lista de acciones pendientes
 */
function getPendingActions() {
  try {
    return db.prepare(`
      SELECT pa.*, c.name as contact_name
      FROM pending_actions pa
      LEFT JOIN contacts c ON pa.contact_phone = c.phone
      WHERE pa.resolved = 0
      ORDER BY pa.created_at DESC
    `).all();
  } catch (error) {
    logger.error(`Error en getPendingActions: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene acciones pendientes sin resolver creadas en los últimos N minutos.
 * Útil para el cron de seguimiento — evita que acciones queden sin atención.
 * @param {number} minutes - Ventana de tiempo en minutos
 * @returns {Array} Lista de acciones recientes no resueltas
 */
function getRecentPendingActions(minutes = 15) {
  try {
    return db.prepare(`
      SELECT pa.*, c.name as contact_name
      FROM pending_actions pa
      LEFT JOIN contacts c ON pa.contact_phone = c.phone
      WHERE pa.resolved = 0
        AND pa.created_at >= datetime('now', '-' || ? || ' minutes')
      ORDER BY pa.created_at ASC
    `).all(minutes);
  } catch (error) {
    logger.error(`Error en getRecentPendingActions: ${error.message}`);
    return [];
  }
}

/**
 * Marca una acción pendiente como resuelta.
 * @param {number} id - ID de la acción
 */
function resolveAction(id) {
  try {
    db.prepare('UPDATE pending_actions SET resolved = 1 WHERE id = ?').run(id);
    logger.info(`Acción ${id} marcada como resuelta`);
  } catch (error) {
    logger.error(`Error en resolveAction: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene todos los contactos (para el dashboard).
 * @returns {Array} Lista de todos los contactos
 */
function getAllContacts() {
  try {
    return db.prepare(`
      SELECT * FROM contacts
      ORDER BY last_contact DESC
    `).all();
  } catch (error) {
    logger.error(`Error en getAllContacts: ${error.message}`);
    throw error;
  }
}

/**
 * Cuenta mensajes procesados hoy.
 * @returns {number} Cantidad de mensajes de hoy
 */
function getMessageCountToday() {
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM messages
      WHERE date(timestamp) = date('now')
    `).get();
    return result.count;
  } catch (error) {
    logger.error(`Error en getMessageCountToday: ${error.message}`);
    return 0;
  }
}

/**
 * Resetea la base de datos (solo para desarrollo).
 * CUIDADO: elimina todos los datos.
 */
function resetDB() {
  db.exec(`
    DROP TABLE IF EXISTS conversation_logs;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS pending_actions;
    DROP TABLE IF EXISTS contacts;
  `);
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT,
      label TEXT DEFAULT 'Interesado',
      stage TEXT DEFAULT 'nuevo',
      bill_received INTEGER DEFAULT 0,
      roof_type TEXT,
      connection_type TEXT,
      locality TEXT,
      product_interest TEXT,
      first_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      notified_ricardo INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_phone) REFERENCES contacts(phone)
    );
    CREATE TABLE pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_phone TEXT NOT NULL,
      action_type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved INTEGER DEFAULT 0
    );
    CREATE TABLE conversation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_phone TEXT NOT NULL,
      event_type TEXT NOT NULL,
      label TEXT,
      summary TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_phone) REFERENCES contacts(phone)
    );
  `);
  logger.warn('Base de datos reseteada');
}

/**
 * Guarda una entrada del log general de conversaciones.
 * @param {string} phone
 * @param {string} eventType
 * @param {string|null} label
 * @param {string} summary
 * @param {Object|null} metadata
 */
function addConversationLog(phone, eventType, label, summary, metadata = null) {
  try {
    db.prepare(`
      INSERT INTO conversation_logs (contact_phone, event_type, label, summary, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      phone,
      eventType,
      label || null,
      summary,
      metadata ? JSON.stringify(metadata) : null
    );
    logger.info(`Log general agregado para ${phone}: ${eventType}${label ? ` (${label})` : ''}`);
  } catch (error) {
    logger.error(`Error en addConversationLog: ${error.message}`);
  }
}

/**
 * Evita duplicar cierres del mismo tipo en una ventana corta.
 * @param {string} phone
 * @param {string} eventType
 * @param {string|null} label
 * @param {number} hours
 * @returns {boolean}
 */
function hasRecentConversationLog(phone, eventType, label = null, hours = 6) {
  try {
    const row = db.prepare(`
      SELECT id FROM conversation_logs
      WHERE contact_phone = ?
        AND event_type = ?
        AND COALESCE(label, '') = COALESCE(?, '')
        AND created_at >= datetime('now', '-' || ? || ' hours')
      LIMIT 1
    `).get(phone, eventType, label || null, hours);
    return !!row;
  } catch (error) {
    logger.error(`Error en hasRecentConversationLog: ${error.message}`);
    return false;
  }
}

// ─── Funciones de Agenda ──────────────────────────────────────────────────────

/**
 * Agrega un evento a la agenda de Ricardo.
 * @param {Object} data - Datos del evento
 * @returns {Object} Evento creado con su ID
 */
function addAgendaEvent(data) {
  try {
    const result = db.prepare(`
      INSERT INTO agenda_events
        (title, description, date_time, duration_minutes, location, event_type, contact_name, contact_phone)
      VALUES
        (@title, @description, @date_time, @duration_minutes, @location, @event_type, @contact_name, @contact_phone)
    `).run({
      title: data.title,
      description: data.description || null,
      date_time: data.date_time,
      duration_minutes: data.duration_minutes || 60,
      location: data.location || null,
      event_type: data.event_type || 'reunion',
      contact_name: data.contact_name || null,
      contact_phone: data.contact_phone || null
    });

    const event = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(result.lastInsertRowid);
    logger.info(`Evento de agenda creado: "${data.title}" → ${data.date_time}`);
    return event;
  } catch (error) {
    logger.error(`Error en addAgendaEvent: ${error.message}`);
    throw error;
  }
}

/**
 * Lista eventos de la agenda en un rango de fechas.
 * @param {string} dateFrom - Fecha de inicio (YYYY-MM-DD)
 * @param {string} dateTo - Fecha de fin (YYYY-MM-DD, opcional)
 * @returns {Array} Lista de eventos
 */
function getAgendaEvents(dateFrom, dateTo = null) {
  try {
    const to = dateTo || dateFrom;
    return db.prepare(`
      SELECT * FROM agenda_events
      WHERE date(date_time) >= date(?)
        AND date(date_time) <= date(?)
        AND status != 'cancelado'
      ORDER BY date_time ASC
    `).all(dateFrom, to);
  } catch (error) {
    logger.error(`Error en getAgendaEvents: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene un evento por ID.
 * @param {number} id
 * @returns {Object|null}
 */
function getAgendaEventById(id) {
  try {
    return db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(id) || null;
  } catch (error) {
    logger.error(`Error en getAgendaEventById: ${error.message}`);
    throw error;
  }
}

/**
 * Actualiza un evento de la agenda.
 * @param {number} id - ID del evento
 * @param {Object} fields - Campos a actualizar
 */
function updateAgendaEvent(id, fields) {
  try {
    if (!fields || Object.keys(fields).length === 0) return;
    const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(fields), id];
    db.prepare(`UPDATE agenda_events SET ${setClauses} WHERE id = ?`).run(...values);
    logger.info(`Evento ${id} de agenda actualizado`);
  } catch (error) {
    logger.error(`Error en updateAgendaEvent: ${error.message}`);
    throw error;
  }
}

/**
 * Cancela un evento de la agenda.
 * @param {number} id
 */
function cancelAgendaEvent(id) {
  try {
    db.prepare("UPDATE agenda_events SET status = 'cancelado' WHERE id = ?").run(id);
    logger.info(`Evento ${id} cancelado`);
  } catch (error) {
    logger.error(`Error en cancelAgendaEvent: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene eventos próximos (para recordatorios via cron).
 * @param {number} minutesAhead - Cuántos minutos adelante buscar
 * @returns {Array} Eventos que están por ocurrir
 */
function getUpcomingEvents(minutesAhead = 65) {
  try {
    return db.prepare(`
      SELECT * FROM agenda_events
      WHERE status = 'pendiente'
        AND reminder_sent = 0
        AND datetime(date_time) BETWEEN datetime('now', 'localtime')
            AND datetime('now', 'localtime', '+${minutesAhead} minutes')
      ORDER BY date_time ASC
    `).all();
  } catch (error) {
    logger.error(`Error en getUpcomingEvents: ${error.message}`);
    return [];
  }
}

/**
 * Obtiene eventos vencidos que nunca recibieron recordatorio.
 * Útil cuando el bot estuvo apagado o el cron se perdió el horario.
 * @param {number} hoursBack - Cuántas horas hacia atrás buscar (default 24h)
 * @returns {Array} Eventos pasados no avisados
 */
function getOverdueEvents(hoursBack = 24) {
  try {
    return db.prepare(`
      SELECT * FROM agenda_events
      WHERE status = 'pendiente'
        AND reminder_sent = 0
        AND datetime(date_time) < datetime('now', 'localtime')
        AND datetime(date_time) > datetime('now', 'localtime', '-${hoursBack} hours')
      ORDER BY date_time ASC
    `).all();
  } catch (error) {
    logger.error(`Error en getOverdueEvents: ${error.message}`);
    return [];
  }
}

/**
 * Marca un evento como "recordatorio ya enviado".
 * @param {number} id
 */
function markReminderSent(id) {
  try {
    db.prepare('UPDATE agenda_events SET reminder_sent = 1 WHERE id = ?').run(id);
  } catch (error) {
    logger.error(`Error en markReminderSent: ${error.message}`);
  }
}

/**
 * Guarda un mensaje del historial de la agenda (conversación de Ricardo con el bot).
 * @param {string} role - 'user' o 'assistant'
 * @param {string} content - Contenido del mensaje
 */
function saveAgendaMessage(role, content) {
  try {
    db.prepare('INSERT INTO agenda_messages (role, content) VALUES (?, ?)').run(role, content);
  } catch (error) {
    logger.error(`Error en saveAgendaMessage: ${error.message}`);
  }
}

/**
 * Obtiene el historial de conversación de la agenda.
 * @param {number} limit - Cantidad máxima de mensajes
 * @returns {Array} Array formateado para Claude
 */
function getAgendaHistory(limit = 15) {
  try {
    const rows = db.prepare(`
      SELECT role, content FROM agenda_messages
      ORDER BY timestamp DESC LIMIT ?
    `).all(limit);
    return rows.reverse().map(r => ({ role: r.role, content: r.content }));
  } catch (error) {
    logger.error(`Error en getAgendaHistory: ${error.message}`);
    return [];
  }
}

// ─── Pausa global del bot ─────────────────────────────────────────────────────

/**
 * Devuelve true si el bot está pausado globalmente.
 */
function isBotPaused() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'bot_paused'").get();
    return row?.value === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Activa o desactiva la pausa global del bot.
 * @param {boolean} paused
 */
function setBotPaused(paused) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('bot_paused', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(paused ? '1' : '0');
}

/**
 * Busca contactos por nombre o teléfono (búsqueda parcial).
 * @param {string} query - Texto a buscar
 * @param {number} limit - Máximo de resultados
 * @returns {Array}
 */
function searchContacts(query, limit = 10) {
  try {
    const q = `%${query}%`;
    return db.prepare(`
      SELECT phone, name, email, label, product_interest, bill_received, locality,
             roof_type, connection_type, last_contact, first_contact
      FROM contacts
      WHERE name LIKE ? OR phone LIKE ?
      ORDER BY last_contact DESC
      LIMIT ?
    `).all(q, q, limit);
  } catch (error) {
    logger.error(`Error en searchContacts: ${error.message}`);
    return [];
  }
}

/**
 * Retorna un resumen de leads agrupados por etiqueta.
 * @returns {Object} { byLabel, total, today }
 */
function getLeadsSummary() {
  try {
    const byLabel = db.prepare(`
      SELECT label, COUNT(*) as count
      FROM contacts
      GROUP BY label
      ORDER BY count DESC
    `).all();

    const total = db.prepare('SELECT COUNT(*) as count FROM contacts').get().count;

    const today = db.prepare(`
      SELECT COUNT(*) as count FROM contacts
      WHERE date(last_contact) = date('now')
    `).get().count;

    const thisWeek = db.prepare(`
      SELECT COUNT(*) as count FROM contacts
      WHERE date(first_contact) >= date('now', '-7 days')
    `).get().count;

    return { byLabel, total, today, thisWeek };
  } catch (error) {
    logger.error(`Error en getLeadsSummary: ${error.message}`);
    return { byLabel: [], total: 0, today: 0, thisWeek: 0 };
  }
}

/**
 * Retorna las últimas conversaciones con clientes, con los mensajes recientes de cada una.
 * Útil para que el bot de agenda pueda resumir qué se habló con los clientes.
 * @param {number} contactLimit - Cuántos contactos incluir
 * @param {number} msgsPerContact - Cuántos mensajes por contacto
 * @returns {Array}
 */
function getRecentConversations(contactLimit = 8, msgsPerContact = 4) {
  try {
    const recentContacts = db.prepare(`
      SELECT contact_phone,
             MAX(timestamp) as last_msg
      FROM messages
      GROUP BY contact_phone
      ORDER BY last_msg DESC
      LIMIT ?
    `).all(contactLimit);

    return recentContacts.map(row => {
      const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(row.contact_phone);
      const msgs = db.prepare(`
        SELECT role, content, timestamp FROM messages
        WHERE contact_phone = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(row.contact_phone, msgsPerContact).reverse();
      return {
        phone: row.contact_phone,
        name: contact?.name || null,
        email: contact?.email || null,
        label: contact?.label || null,
        product_interest: contact?.product_interest || null,
        last_contact: row.last_msg,
        messages: msgs.map(m => ({ role: m.role, text: m.content.substring(0, 250) }))
      };
    });
  } catch (error) {
    logger.error(`Error en getRecentConversations: ${error.message}`);
    return [];
  }
}

/**
 * Retorna los contactos que escribieron hoy.
 * @returns {Array}
 */
function getContactsActiveToday() {
  try {
    return db.prepare(`
      SELECT phone, name, email, label, product_interest, last_contact
      FROM contacts
      WHERE date(last_contact) = date('now')
      ORDER BY last_contact DESC
    `).all();
  } catch (error) {
    logger.error(`Error en getContactsActiveToday: ${error.message}`);
    return [];
  }
}

// ─── Cola de notificaciones pendientes ───────────────────────────────────────

/**
 * Guarda una notificación que no se pudo enviar (ventana 24h expirada).
 * Se enviará la próxima vez que Ricardo escriba al bot.
 * @param {string} phone - Número destino (Ricardo)
 * @param {string} message - Mensaje completo a enviar
 */
function addPendingNotification(phone, message) {
  try {
    db.prepare(`
      INSERT INTO pending_notifications (phone, message)
      VALUES (?, ?)
    `).run(phone, message);
    logger.info(`Notificación encolada para ${phone}`);
  } catch (error) {
    logger.error(`Error en addPendingNotification: ${error.message}`);
  }
}

/**
 * Obtiene las notificaciones pendientes para un número.
 * @param {string} phone
 * @returns {Array}
 */
function getPendingNotifications(phone) {
  try {
    return db.prepare(`
      SELECT * FROM pending_notifications
      WHERE phone = ? AND sent = 0
      ORDER BY created_at ASC
    `).all(phone);
  } catch (error) {
    logger.error(`Error en getPendingNotifications: ${error.message}`);
    return [];
  }
}

/**
 * Marca una notificación pendiente como enviada.
 * @param {number} id
 */
function markNotificationSent(id) {
  try {
    db.prepare(`
      UPDATE pending_notifications
      SET sent = 1, sent_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  } catch (error) {
    logger.error(`Error en markNotificationSent: ${error.message}`);
  }
}

module.exports = {
  getOrCreateContact,
  updateContact,
  saveMessage,
  getHistory,
  getContact,
  setHumanMode,
  isHumanMode,
  isBotPaused,
  setBotPaused,
  addPendingAction,
  getPendingActions,
  getRecentPendingActions,
  resolveAction,
  getAllContacts,
  getMessageCountToday,
  resetDB,
  addConversationLog,
  hasRecentConversationLog,
  // Agenda
  addAgendaEvent,
  getAgendaEvents,
  getAgendaEventById,
  updateAgendaEvent,
  cancelAgendaEvent,
  getUpcomingEvents,
  getOverdueEvents,
  markReminderSent,
  saveAgendaMessage,
  getAgendaHistory,
  searchContacts,
  getLeadsSummary,
  getContactsActiveToday,
  getRecentConversations,
  // Cola de notificaciones
  addPendingNotification,
  getPendingNotifications,
  markNotificationSent,
  db
};
