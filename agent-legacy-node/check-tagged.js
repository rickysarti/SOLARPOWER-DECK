/**
 * check-tagged.js
 * Pagina contactos de SendPulse usando page=N.
 * Total real: 528 según meta. Filtra los que tienen tags y los agrega a la DB.
 */
require('dotenv').config();
const axios    = require('axios');
const Database = require('better-sqlite3');

const BOT_ID   = '69a88e22ba4f8ed99408143e';
const API_BASE = 'https://api.sendpulse.com';

async function main() {
  // ── Token ────────────────────────────────────────────────────────────────────
  const tokenResp = await axios.post(`${API_BASE}/oauth/access_token`, {
    grant_type:    'client_credentials',
    client_id:     process.env.SENDPULSE_API_ID,
    client_secret: process.env.SENDPULSE_API_SECRET,
  });
  const token   = tokenResp.data.access_token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  console.log('✅ Token obtenido');

  // ── Paginar con page=N ────────────────────────────────────────────────────────
  let allContacts = [];
  let page        = 1;
  let total       = null;

  while (true) {
    const resp = await axios.get(`${API_BASE}/whatsapp/contacts`, {
      headers,
      params: { bot_id: BOT_ID, limit: 100, page }
    });
    const batch = resp.data?.data || [];
    if (total === null) total = resp.data.meta?.total || '?';
    if (!Array.isArray(batch) || batch.length === 0) break;
    allContacts = allContacts.concat(batch);
    process.stdout.write(`\rObtenidos: ${allContacts.length} / ${total}...`);
    if (batch.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\n✅ Total obtenidos: ${allContacts.length} (meta.total: ${total})\n`);

  // ── Filtrar con tags ──────────────────────────────────────────────────────────
  const tagged = allContacts.filter(c => c.tags && c.tags.length > 0);
  console.log(`Contactos con tags (viejo método pausado): ${tagged.length}`);

  // ── Comparar con DB ───────────────────────────────────────────────────────────
  const db = new Database('./data/solarpower.db');
  const pausedInDB = new Set(
    db.prepare('SELECT phone FROM contacts WHERE human_mode = 1').all().map(r => String(r.phone))
  );
  console.log(`En DB con human_mode=1 actualmente: ${pausedInDB.size}\n`);

  const missing   = [];
  const alreadyOk = [];

  for (const c of tagged) {
    const phone = String(c.channel_data?.phone || '').replace(/^\+/, '').trim();
    const name  = c.channel_data?.name || null;
    if (!phone) continue;
    if (pausedInDB.has(phone)) {
      alreadyOk.push({ phone, name, tags: c.tags });
    } else {
      missing.push({ phone, name, tags: c.tags });
    }
  }

  console.log(`✅ Ya pausados en DB: ${alreadyOk.length}`);
  alreadyOk.forEach(c => console.log(`  ✅ ${c.phone} | ${c.name} | ${JSON.stringify(c.tags)}`));

  console.log(`\n❌ Faltan en DB:      ${missing.length}`);
  missing.forEach(c => console.log(`  ➕ ${c.phone} | ${c.name} | ${JSON.stringify(c.tags)}`));

  if (missing.length > 0) {
    const upsert = db.prepare(`
      INSERT INTO contacts (phone, name, human_mode, first_contact, last_contact, msg_count)
      VALUES (?, ?, 1, datetime('now'), datetime('now'), 0)
      ON CONFLICT(phone) DO UPDATE SET human_mode = 1
    `);
    db.transaction(() => {
      for (const c of missing) upsert.run(c.phone, c.name);
    })();
    console.log(`\n✅ ${missing.length} contactos agregados con human_mode=1`);
  } else {
    console.log('\n✅ No falta ninguno — todos ya están en DB.');
  }

  const finalCount = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE human_mode = 1').get().n;
  console.log(`\n📊 Total pausados en DB ahora: ${finalCount}`);
}

main().catch(e => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
