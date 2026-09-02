/**
 * sync-paused.js
 * Sincroniza human_mode entre Supabase y SQLite en ambas direcciones.
 * - Supabase → SQLite: agrega los que faltan en SQLite
 * - SQLite → Supabase: sube los que faltan en Supabase
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const db       = new Database('./data/solarpower.db');

async function main() {
  // ── Leer ambas fuentes ────────────────────────────────────────────────────────
  const { data: supaPaused, error } = await supabase
    .from('chatbot_wa_contacts')
    .select('phone, name, human_mode')
    .eq('human_mode', true);

  if (error) { console.error('Error Supabase:', error.message); process.exit(1); }

  const localPaused = db.prepare('SELECT phone, name FROM contacts WHERE human_mode = 1').all();

  const supaSet  = new Set(supaPaused.map(r => String(r.phone)));
  const localSet = new Set(localPaused.map(r => String(r.phone)));

  console.log(`Supabase human_mode=true: ${supaPaused.length}`);
  console.log(`SQLite  human_mode=1:     ${localPaused.length}\n`);

  // ── 1. Supabase → SQLite ──────────────────────────────────────────────────────
  const onlyInSupa = supaPaused.filter(c => !localSet.has(String(c.phone)));
  console.log(`Supabase → SQLite (faltan en SQLite): ${onlyInSupa.length}`);

  if (onlyInSupa.length > 0) {
    const upsert = db.prepare(`
      INSERT INTO contacts (phone, name, human_mode, first_contact, last_contact)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET human_mode = 1
    `);
    db.transaction(() => {
      for (const c of onlyInSupa) {
        upsert.run(String(c.phone), c.name);
        console.log(`  ✅ SQLite ← ${c.phone} | ${c.name}`);
      }
    })();
  }

  // ── 2. SQLite → Supabase ──────────────────────────────────────────────────────
  const onlyLocal = localPaused.filter(c => !supaSet.has(String(c.phone)));
  console.log(`\nSQLite → Supabase (faltan en Supabase): ${onlyLocal.length}`);

  if (onlyLocal.length > 0) {
    for (const c of onlyLocal) {
      // Verificar si el contacto existe en Supabase (puede estar con human_mode=false)
      const { data: existing } = await supabase
        .from('chatbot_wa_contacts')
        .select('phone')
        .eq('phone', String(c.phone))
        .single();

      if (existing) {
        // Existe pero human_mode=false → actualizar
        const { error: updErr } = await supabase
          .from('chatbot_wa_contacts')
          .update({ human_mode: true })
          .eq('phone', String(c.phone));
        if (updErr) {
          console.log(`  ⚠️  Error actualizando ${c.phone}: ${updErr.message}`);
        } else {
          console.log(`  ✅ Supabase UPDATE ← ${c.phone} | ${c.name}`);
        }
      } else {
        // No existe → insertar
        const { error: insErr } = await supabase
          .from('chatbot_wa_contacts')
          .insert({
            phone:         String(c.phone),
            name:          c.name,
            human_mode:    true,
            first_contact: new Date().toISOString(),
            last_contact:  new Date().toISOString(),
          });
        if (insErr) {
          console.log(`  ⚠️  Error insertando ${c.phone}: ${insErr.message}`);
        } else {
          console.log(`  ✅ Supabase INSERT ← ${c.phone} | ${c.name}`);
        }
      }
    }
  }

  // ── Resultado final ───────────────────────────────────────────────────────────
  const finalLocal = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE human_mode = 1').get().n;
  const { count: finalSupa } = await supabase
    .from('chatbot_wa_contacts')
    .select('phone', { count: 'exact', head: true })
    .eq('human_mode', true);

  console.log('\n=== RESULTADO FINAL ===');
  console.log(`SQLite  human_mode=1:     ${finalLocal}`);
  console.log(`Supabase human_mode=true: ${finalSupa}`);
  console.log('✅ Sincronización completa');
}

main().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
