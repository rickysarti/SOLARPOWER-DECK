/**
 * migrate-to-supabase.js
 *
 * Migración de datos faltantes desde SQLite → Supabase.
 *
 * Qué hace:
 *   1. Agrega la columna `tipo` a chatbot_wa_contacts si no existe
 *   2. Upsert de todos los contactos de SQLite → Supabase
 *   3. Sincroniza mensajes de los últimos 30 días que no estén en Supabase
 *
 * Uso:
 *   node migrate-to-supabase.js
 *   node migrate-to-supabase.js --dias 30    (default: 30)
 *   node migrate-to-supabase.js --solo-contactos
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DB_PATH      = path.join(__dirname, 'data', 'solarpower.db');

const args          = process.argv.slice(2);
const DIAS          = parseInt(args.find(a => a.startsWith('--dias'))?.split('=')[1] || '30', 10);
const SOLO_CONTACTOS = args.includes('--solo-contactos');
const BATCH_SIZE    = 50; // mensajes por batch para no saturar la API

// ─── Init ─────────────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados en .env');
  process.exit(1);
}

const sb  = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const db  = new Database(DB_PATH, { readonly: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(label, n) {
  console.log(`  ✅  ${label}: ${n} registros`);
}

function warn(label, err) {
  console.warn(`  ⚠️   ${label}: ${err}`);
}

async function addColumnIfMissing() {
  console.log('\n📐  PASO 1 — Agregar columna tipo a Supabase si falta...');

  // Intentar un upsert de prueba con tipo = null para ver si ya existe
  const { error } = await sb
    .from('chatbot_wa_contacts')
    .upsert({ phone: '__migration_test__', tipo: null }, { onConflict: 'phone' });

  if (!error || !error.message.includes('tipo')) {
    // Columna ya existe → limpiar fila de prueba
    await sb.from('chatbot_wa_contacts').delete().eq('phone', '__migration_test__');
    console.log('  ✅  Columna tipo ya existe.');
    return;
  }

  // Columna no existe → crearla via rpc (Supabase no expone ALTER TABLE directo)
  console.log('  🔧  Columna tipo no encontrada — creándola con ALTER TABLE...');
  const { error: rpcErr } = await sb.rpc('exec_sql', {
    sql: 'ALTER TABLE chatbot_wa_contacts ADD COLUMN tipo TEXT;'
  });

  if (rpcErr) {
    // rpc exec_sql puede no estar habilitado; mostrar instrucción manual
    console.error(
      '\n  ❌  No se pudo crear la columna automáticamente.\n' +
      '  Corré esto manualmente en el SQL Editor de Supabase:\n\n' +
      '      ALTER TABLE chatbot_wa_contacts ADD COLUMN tipo TEXT;\n\n' +
      '  Luego volvé a correr este script.\n'
    );
    process.exit(1);
  }

  console.log('  ✅  Columna tipo creada.');
}

// ─── PASO 2: Upsert de contactos ──────────────────────────────────────────────

async function migrateContacts() {
  console.log('\n👥  PASO 2 — Migrando contactos...');

  const contacts = db.prepare('SELECT * FROM contacts').all();
  console.log(`  📦  ${contacts.length} contactos en SQLite`);

  let ok_count = 0;
  let err_count = 0;

  // Procesamos en batches de 50
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);

    const rows = batch.map(c => ({
      phone:            c.phone,
      name:             c.name             || null,
      tipo:             c.tipo             || null,
      label:            c.label            || 'Interesado',
      stage:            c.stage            || 'nuevo',
      bill_received:    !!c.bill_received,
      roof_type:        c.roof_type        || null,
      connection_type:  c.connection_type  || null,
      locality:         c.locality         || null,
      product_interest: c.product_interest || null,
      human_mode:       !!c.human_mode,
      notified_ricardo: !!c.notified_ricardo,
      notes:            c.notes            || null,
      first_contact:    c.first_contact    || new Date().toISOString(),
      last_contact:     c.last_contact     || new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }));

    const { error } = await sb
      .from('chatbot_wa_contacts')
      .upsert(rows, { onConflict: 'phone' });

    if (error) {
      warn(`batch contactos [${i}-${i + batch.length}]`, error.message);
      err_count += batch.length;
    } else {
      ok_count += batch.length;
      process.stdout.write(`\r  ⏳  ${ok_count}/${contacts.length}...`);
    }
  }

  console.log(`\r  ✅  Contactos migrados: ${ok_count} ok, ${err_count} errores`);
}

// ─── PASO 3: Mensajes de los últimos N días ───────────────────────────────────

async function migrateMessages() {
  const desde = new Date();
  desde.setDate(desde.getDate() - DIAS);
  const desdeISO = desde.toISOString();

  console.log(`\n💬  PASO 3 — Migrando mensajes de los últimos ${DIAS} días (desde ${desdeISO.split('T')[0]})...`);

  // Obtener teléfonos únicos con mensajes en ese período
  const phones = db
    .prepare(`SELECT DISTINCT contact_phone FROM messages WHERE timestamp >= ? ORDER BY contact_phone`)
    .all(desdeISO)
    .map(r => r.contact_phone);

  console.log(`  📦  ${phones.length} contactos con mensajes en ese período`);

  let total_ok  = 0;
  let total_err = 0;

  for (const phone of phones) {
    // Obtener o crear conversación en Supabase
    let convId;
    try {
      convId = await getOrCreateConvId(phone);
    } catch (e) {
      warn(`conv ${phone}`, e.message);
      continue;
    }

    // Traer mensajes locales del período
    const msgs = db
      .prepare(`SELECT * FROM messages WHERE contact_phone = ? AND timestamp >= ? ORDER BY timestamp ASC`)
      .all(phone, desdeISO);

    // Traer IDs de mensajes ya en Supabase para este conv (evitar duplicados)
    const { data: existing } = await sb
      .from('chatbot_messages')
      .select('metadata->>sqlite_id')
      .eq('conversation_id', convId);

    const existingIds = new Set((existing || []).map(r => r['?column?'] || r['metadata->>sqlite_id']).filter(Boolean));

    // Filtrar sólo los que no están
    const toInsert = msgs.filter(m => !existingIds.has(String(m.id)));

    if (toInsert.length === 0) continue;

    // Insertar en batches
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const rows = batch.map(m => ({
        conversation_id: convId,
        role:            m.role || (m.sender === 'bot' ? 'assistant' : 'user'),
        content:         m.content || m.message || '',
        model:           m.role === 'assistant' ? 'claude-haiku-4-5-20251001' : null,
        created_at:      m.timestamp || new Date().toISOString(),
        metadata:        { sqlite_id: String(m.id) },
      }));

      const { error } = await sb.from('chatbot_messages').insert(rows);
      if (error) {
        warn(`msgs ${phone} batch ${i}`, error.message);
        total_err += batch.length;
      } else {
        total_ok += batch.length;
      }
    }

    process.stdout.write(`\r  ⏳  ${phones.indexOf(phone) + 1}/${phones.length} contactos, ${total_ok} mensajes ok...`);
  }

  console.log(`\r  ✅  Mensajes migrados: ${total_ok} ok, ${total_err} errores          `);
}

// Cache de convIds (igual que en supabase-sync.js)
const convCache = new Map();

async function getOrCreateConvId(phone) {
  if (convCache.has(phone)) return convCache.get(phone);

  // Buscar nombre del contacto en SQLite
  const contact = db.prepare('SELECT name FROM contacts WHERE phone = ?').get(phone);
  const name    = contact?.name || null;

  // Buscar conv existente
  const { data: existing } = await sb
    .from('chatbot_conversations')
    .select('id')
    .eq('channel', 'whatsapp')
    .eq('status', 'active')
    .eq('metadata->>phone', phone)
    .maybeSingle();

  if (existing?.id) {
    convCache.set(phone, existing.id);
    return existing.id;
  }

  // Crear conversación
  const { data, error } = await sb
    .from('chatbot_conversations')
    .insert({
      channel:  'whatsapp',
      status:   'active',
      title:    name ? `${name} (${phone})` : phone,
      context:  { lang: 'es', timezone: 'America/Argentina/Buenos_Aires' },
      metadata: { phone, name },
    })
    .select('id')
    .single();

  if (error) throw new Error(`crear conversación para ${phone}: ${error.message}`);

  convCache.set(phone, data.id);
  return data.id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  migrate-to-supabase.js — SolarPower CRM');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  DB local : ${DB_PATH}`);
  console.log(`  Supabase : ${SUPABASE_URL}`);
  console.log(`  Período  : últimos ${DIAS} días`);
  if (SOLO_CONTACTOS) console.log('  Modo     : solo contactos (sin mensajes)');
  console.log('═══════════════════════════════════════════════════');

  const start = Date.now();

  await addColumnIfMissing();
  await migrateContacts();
  if (!SOLO_CONTACTOS) await migrateMessages();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n🎉  Migración completada en ${elapsed}s`);
  console.log('   El bot ya puede sincronizar normalmente sin reiniciar.\n');

  db.close();
}

main().catch(err => {
  console.error('\n❌  Error fatal:', err.message);
  process.exit(1);
});
