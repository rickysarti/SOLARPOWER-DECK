'use strict';

/**
 * outreach/db.js
 * Maneja la tabla outreach_leads usando la conexión SQLite existente.
 */

const { db } = require('../database');

// ─── Crear tabla si no existe ─────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre           TEXT NOT NULL,
    rubro            TEXT,
    zona             TEXT,
    email            TEXT,
    whatsapp         TEXT,
    contacto_nombre  TEXT,
    sitio_web        TEXT,
    fuente           TEXT,
    canal_envio      TEXT,
    estado           TEXT DEFAULT 'pendiente',
    email_asunto     TEXT,
    mensaje_cuerpo   TEXT,
    fecha_encontrado TEXT,
    fecha_enviado    TEXT,
    notas            TEXT
  )
`);

// ─── Tabla de búsquedas realizadas ───────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_searches (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    zona                TEXT NOT NULL,
    rubro               TEXT NOT NULL,
    fecha_busqueda      TEXT NOT NULL,
    empresas_encontradas INTEGER DEFAULT 0
  )
`);

try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_searches_zona_rubro
      ON outreach_searches(zona, rubro)
  `);
} catch (_) { /* ya existe */ }

// ─── Índices únicos parciales: NULLs y vacíos se excluyen del constraint ─────
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_email
      ON outreach_leads(email) WHERE email IS NOT NULL AND email != ''
  `);
} catch (_) { /* ya existe */ }

try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_whatsapp
      ON outreach_leads(whatsapp) WHERE whatsapp IS NOT NULL AND whatsapp != ''
  `);
} catch (_) { /* ya existe */ }

// ─── Prioridades de rubro (para ordenar leads pendientes) ─────────────────────

const RUBRO_PRIORITY = {
  'frigoríficos y plantas de frío industrial': 1,
  'galpones logísticos y centros de distribución': 2,
  'supermercados y mayoristas': 3,
  'industrias alimenticias y de bebidas': 4,
  'plantas industriales y fábricas': 5,
  'metalúrgicas y talleres industriales grandes': 6,
  'viveros y establecimientos de jardinería comercial': 7,
  'colegios y universidades privadas grandes': 8,
  'gimnasios y clubes deportivos grandes': 9,
};

// ─── Funciones exportadas ─────────────────────────────────────────────────────

/**
 * Guarda un nuevo lead. Retorna el ID insertado o null si ya existe.
 * @param {Object} lead
 * @returns {number|null}
 */
function saveLead(lead) {
  const now = new Date().toISOString().split('T')[0];
  try {
    const result = db.prepare(`
      INSERT INTO outreach_leads
        (nombre, rubro, zona, email, whatsapp, contacto_nombre, sitio_web, fuente, fecha_encontrado)
      VALUES
        (@nombre, @rubro, @zona, @email, @whatsapp, @contacto_nombre, @sitio_web, @fuente, @fecha_encontrado)
    `).run({
      nombre:          lead.nombre,
      rubro:           lead.rubro           || null,
      zona:            lead.zona            || null,
      email:           lead.email           || null,
      whatsapp:        lead.whatsapp        || null,
      contacto_nombre: lead.contacto_nombre || null,
      sitio_web:       lead.sitio_web       || null,
      fuente:          lead.fuente          || null,
      fecha_encontrado: lead.fecha_encontrado || now,
    });
    return result.lastInsertRowid;
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) return null; // duplicado
    throw err;
  }
}

/**
 * Actualiza estado y campos opcionales de un lead.
 * @param {number} id
 * @param {string} estado
 * @param {Object} extras - campos adicionales a actualizar
 */
function updateLeadStatus(id, estado, extras = {}) {
  // CRÍTICO: si se intenta resetear a 'pendiente' un lead ya enviado, ignorar.
  if (estado === 'pendiente') {
    const existing = db.prepare('SELECT fecha_enviado FROM outreach_leads WHERE id = ?').get(id);
    if (existing && existing.fecha_enviado) {
      console.warn(`[db] BLOQUEADO: intento de resetear a 'pendiente' lead id=${id} que ya fue enviado el ${existing.fecha_enviado}`);
      return;
    }
  }

  const fields = { estado, ...extras };
  if (estado === 'enviado' && !fields.fecha_enviado) {
    fields.fecha_enviado = new Date().toISOString().replace('T', ' ').split('.')[0];
  }
  const setClauses = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE outreach_leads SET ${setClauses} WHERE id = @id`)
    .run({ ...fields, id });
}

/**
 * Busca un lead por email. Retorna null si no existe.
 * @param {string} email
 * @returns {Object|null}
 */
function getLeadByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM outreach_leads WHERE email = ?').get(email) || null;
}

/**
 * Busca un lead por número de WhatsApp. Retorna null si no existe.
 * @param {string} numero
 * @returns {Object|null}
 */
function getLeadByWhatsapp(numero) {
  if (!numero) return null;
  return db.prepare('SELECT * FROM outreach_leads WHERE whatsapp = ?').get(numero) || null;
}

/**
 * Cuenta los leads enviados hoy.
 * @returns {number}
 */
function countSentToday() {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM outreach_leads
    WHERE estado = 'enviado'
      AND date(fecha_enviado) = date('now')
  `).get();
  return result ? result.count : 0;
}

/**
 * Obtiene leads pendientes ordenados por prioridad de rubro.
 * Incluye leads de días anteriores no enviados.
 * @param {number} limit
 * @returns {Array}
 */
function getPendingLeads(limit = 50) {
  // CRÍTICO: excluir cualquier lead que alguna vez fue enviado (fecha_enviado NOT NULL)
  // Esto garantiza que resets de estado no puedan re-encolar leads ya enviados.
  const rows = db.prepare(`
    SELECT * FROM outreach_leads
    WHERE estado = 'pendiente'
      AND fecha_enviado IS NULL
  `).all();

  rows.sort((a, b) => {
    const pa = RUBRO_PRIORITY[a.rubro] || 99;
    const pb = RUBRO_PRIORITY[b.rubro] || 99;
    return pa - pb;
  });

  return rows.slice(0, limit);
}

// ─── Funciones de búsquedas ───────────────────────────────────────────────────

/**
 * Retorna el registro de búsqueda para una zona+rubro, o null si nunca se buscó.
 */
function getSearch(zona, rubro) {
  return db.prepare(
    'SELECT * FROM outreach_searches WHERE zona = ? AND rubro = ?'
  ).get(zona, rubro) || null;
}

/**
 * Registra (o actualiza) que se realizó una búsqueda para zona+rubro.
 */
function saveSearch(zona, rubro, empresasEncontradas) {
  const fecha = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    INSERT INTO outreach_searches (zona, rubro, fecha_busqueda, empresas_encontradas)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(zona, rubro) DO UPDATE SET
      fecha_busqueda       = excluded.fecha_busqueda,
      empresas_encontradas = excluded.empresas_encontradas
  `).run(zona, rubro, fecha, empresasEncontradas);
}

/**
 * Retorna todas las búsquedas registradas, ordenadas por fecha_busqueda ASC
 * (las más antiguas primero).
 */
function getAllSearches() {
  return db.prepare(
    'SELECT * FROM outreach_searches ORDER BY fecha_busqueda ASC'
  ).all();
}

module.exports = {
  saveLead,
  updateLeadStatus,
  getLeadByEmail,
  getLeadByWhatsapp,
  countSentToday,
  getPendingLeads,
  getSearch,
  saveSearch,
  getAllSearches,
  db,
};
