/**
 * sendpulse-cleanup.js
 *
 * Borra de SendPulse los contactos de WhatsApp que ya fueron clasificados como
 * ACADEMIA/CURSOS o CV/RRHH (proveedores, busqueda de empleo), para bajar la
 * cantidad de suscriptores facturables. La conversacion completa de estos
 * contactos ya esta guardada en Supabase (chatbot_wa_contacts / chatbot_conversations
 * / chatbot_messages) — esto SOLO borra el registro en SendPulse, no el historial.
 *
 * NO SE EJECUTA SOLO. Por defecto corre en modo DRY-RUN: busca cada contacto
 * en SendPulse y muestra qué pasaría, pero no borra nada. Para borrar de
 * verdad hay que pasar --ejecutar explicitamente.
 *
 * Uso:
 *   node scripts/sendpulse-cleanup.js                  -> dry run (no borra nada)
 *   node scripts/sendpulse-cleanup.js --ejecutar        -> borra de verdad
 *   node scripts/sendpulse-cleanup.js --ejecutar --solo-uno=5491121584695   -> prueba con 1 numero antes de correr todo
 *
 * IMPORTANTE: antes de correr con --ejecutar sobre la lista completa, probá
 * primero con --solo-uno en un numero de prueba y revisá en el panel de
 * SendPulse que efectivamente desaparecio el contacto.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_BASE = 'https://api.sendpulse.com';
const CSV_PATH = process.env.CLEANUP_CSV || 'D:\\CLAUDIO\\SendPulseCleanup\\contactos-a-borrar.csv';
const REPORT_PATH = path.join('D:\\CLAUDIO\\SendPulseCleanup', `reporte-${Date.now()}.txt`);

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const DIAGNOSE = args.includes('--diagnose');
const soloUnoArg = args.find(a => a.startsWith('--solo-uno='));

// FIX (2026-06-30): si --solo-uno= viene vacio (el usuario apreto Enter sin
// escribir nada en el .bat), antes esto se trataba como "sin filtro" y corria
// sobre los 258 contactos en modo --ejecutar. Ahora aborta en vez de seguir.
let SOLO_UNO = null;
if (soloUnoArg) {
  SOLO_UNO = soloUnoArg.split('=')[1] ? soloUnoArg.split('=')[1].trim() : '';
  if (!SOLO_UNO) {
    console.error('ERROR: --solo-uno vino vacio. No escribiste ningun numero. Abortando para no correr sobre toda la lista por accidente.');
    process.exit(1);
  }
}

// Seguridad extra: --ejecutar sin --solo-uno (es decir, el borrado masivo)
// requiere ademas la variable de entorno CONFIRMO_BORRADO_MASIVO=SI.
if (EJECUTAR && !SOLO_UNO && process.env.CONFIRMO_BORRADO_MASIVO !== 'SI') {
  console.error('ERROR: estas por correr --ejecutar sobre TODA la lista sin la confirmacion CONFIRMO_BORRADO_MASIVO=SI. Abortando.');
  process.exit(1);
}

let accessToken = null;
let tokenExpiresAt = null;
let botId = process.env.SENDPULSE_BOT_ID || null;

async function refreshToken() {
  const response = await axios.post(`${API_BASE}/oauth/access_token`, {
    grant_type: 'client_credentials',
    client_id: process.env.SENDPULSE_API_ID,
    client_secret: process.env.SENDPULSE_API_SECRET
  });
  accessToken = response.data.access_token;
  const expiresIn = (response.data.expires_in || 3600) - 60;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
}

async function getHeaders() {
  if (!accessToken || Date.now() >= tokenExpiresAt) await refreshToken();
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

async function getBotId() {
  if (botId) return botId;
  const headers = await getHeaders();
  const r = await axios.get(`${API_BASE}/whatsapp/bots`, { headers });
  const bots = r.data.data || r.data || [];
  if (!bots.length) throw new Error('No hay bots configurados en SendPulse');
  botId = bots[0].id;
  return botId;
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    // CSV simple, sin comillas (los datos ya vienen sin comas internas relevantes)
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

/**
 * Busca el contacto en SendPulse por telefono usando el endpoint confirmado:
 * GET /whatsapp/contacts/getByPhone?bot_id=...&phone=...
 * (confirmado via foro de la comunidad SendPulse — la version con bot_id y
 * phone como segmentos de URL daba 404 en todos los casos, sin excepcion).
 */
async function findContactByPhone(phone, bid) {
  const headers = await getHeaders();
  const r = await axios.get(`${API_BASE}/whatsapp/contacts/getByPhone`, {
    headers,
    params: { bot_id: bid, phone }
  });
  const data = r.data?.data || r.data;
  return data;
}

async function deleteContact(contactId) {
  const headers = await getHeaders();
  // FIX (2026-06-30, intento 2): /whatsapp/contacts/{id} dio 404 en los 258
  // casos (nada se borro, fallo antes de tocar nada). Nueva hipotesis: igual
  // que getContactTags() en sendpulse.js usa /chatbots/contacts/{id} (generico,
  // no especifico de whatsapp) para LEER el contacto, el borrado probablemente
  // este en esa misma familia de endpoint.
  return axios.delete(`${API_BASE}/chatbots/contacts/${contactId}`, { headers });
}

/**
 * Modo solo-lectura: prueba varias formas posibles de llamar a getByPhone
 * contra UN solo numero conocido, sin borrar nada, y muestra la respuesta
 * cruda de cada una. Sirve para confirmar el formato correcto del endpoint
 * antes de confiar en el resto del script.
 */
async function diagnose(phone, bid) {
  const headers = await getHeaders();
  const candidates = [
    { label: 'GET querystring (bot_id+phone)', fn: () => axios.get(`${API_BASE}/whatsapp/contacts/getByPhone`, { headers, params: { bot_id: bid, phone } }) },
    { label: 'GET path segments /getByPhone/{bot_id}/{phone}', fn: () => axios.get(`${API_BASE}/whatsapp/contacts/getByPhone/${bid}/${phone}`, { headers }) },
    { label: 'POST body {bot_id, phone}', fn: () => axios.post(`${API_BASE}/whatsapp/contacts/getByPhone`, { bot_id: bid, phone }, { headers }) },
  ];

  let contactId = null;
  for (const c of candidates) {
    try {
      const r = await c.fn();
      console.log(`\n[OK] ${c.label}\nstatus=${r.status}\nbody=${JSON.stringify(r.data)}`);
      if (r.data?.data?.id) contactId = r.data.data.id;
    } catch (err) {
      console.log(`\n[FALLO] ${c.label}\nstatus=${err.response?.status}\nbody=${JSON.stringify(err.response?.data || {})}\nmsg=${err.message}`);
    }
    await wait(500);
  }

  if (!contactId) {
    console.log('\nNo se obtuvo contact_id, no se puede seguir probando los endpoints de detalle/borrado.');
    return;
  }

  console.log(`\n--- Probando endpoints de DETALLE (solo lectura, GET) para contact_id=${contactId} ---`);
  const detailCandidates = [
    { label: 'GET /chatbots/contacts/{id}  (el que ya usa getContactTags en sendpulse.js)', fn: () => axios.get(`${API_BASE}/chatbots/contacts/${contactId}`, { headers }) },
    { label: 'GET /whatsapp/contacts/{id}', fn: () => axios.get(`${API_BASE}/whatsapp/contacts/${contactId}`, { headers }) },
  ];
  for (const c of detailCandidates) {
    try {
      const r = await c.fn();
      console.log(`\n[OK] ${c.label}\nstatus=${r.status}\nbody=${JSON.stringify(r.data).slice(0, 500)}`);
    } catch (err) {
      console.log(`\n[FALLO] ${c.label}\nstatus=${err.response?.status}\nbody=${JSON.stringify(err.response?.data || {})}\nmsg=${err.message}`);
    }
    await wait(500);
  }
  console.log('\nNOTA: esto NO prueba el borrado (DELETE) en si, solo confirma cual familia de endpoint (/chatbots/contacts/ vs /whatsapp/contacts/) reconoce este contact_id. El que de [OK] aca es el mas probable candidato para el DELETE real.');
}

async function main() {
  if (DIAGNOSE) {
    const bid = await getBotId();
    const phone = SOLO_UNO || 'SIN_NUMERO';
    if (!SOLO_UNO) {
      console.error('ERROR: --diagnose requiere --solo-uno=<numero de prueba>');
      process.exit(1);
    }
    console.log(`Diagnosticando endpoints contra phone=${phone} bot_id=${bid}`);
    await diagnose(phone, bid);
    return;
  }

  const report = [];
  const log = (line) => { console.log(line); report.push(line); };

  log(`=== SendPulse cleanup — ${new Date().toISOString()} ===`);
  log(`Modo: ${EJECUTAR ? 'EJECUTAR (borra de verdad)' : 'DRY-RUN (no borra nada)'}`);
  if (SOLO_UNO) log(`Filtrado a un solo numero de prueba: ${SOLO_UNO}`);

  if (!fs.existsSync(CSV_PATH)) {
    log(`No se encontro el CSV en ${CSV_PATH}`);
    process.exit(1);
  }

  let rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  if (SOLO_UNO) rows = rows.filter(r => r.phone === SOLO_UNO);

  log(`Contactos a procesar: ${rows.length}`);

  const bid = await getBotId();
  log(`bot_id: ${bid}`);

  let found = 0, notFound = 0, deleted = 0, errors = 0;

  for (const row of rows) {
    const phone = row.phone;
    try {
      const contact = await findContactByPhone(phone, bid);
      if (!contact || !contact.id) {
        log(`[NO ENCONTRADO] ${phone} (${row.name}) — no aparece en SendPulse, puede que ya no este o el numero no coincide exacto`);
        notFound++;
        continue;
      }
      found++;
      log(`[ENCONTRADO] ${phone} (${row.name}) -> contact_id=${contact.id}`);

      if (EJECUTAR) {
        await deleteContact(contact.id);
        log(`  [BORRADO] ${phone}`);
        deleted++;
      }
    } catch (err) {
      const status = err.response?.status;
      const body = JSON.stringify(err.response?.data || {});
      log(`[ERROR] ${phone} (${row.name}) — status=${status || 'sin status'} body=${body} msg=${err.message}`);
      errors++;
    }
    // No saturar la API
    await wait(400);
  }

  log('');
  log('=== RESUMEN ===');
  log(`Encontrados en SendPulse: ${found}`);
  log(`No encontrados: ${notFound}`);
  log(`Errores: ${errors}`);
  log(`Borrados: ${deleted} ${EJECUTAR ? '' : '(dry-run, no se borro nada de verdad)'}`);

  fs.writeFileSync(REPORT_PATH, report.join('\n'), 'utf8');
  log(`\nReporte guardado en: ${REPORT_PATH}`);
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
