'use strict';

/**
 * outreach/outreach.js
 * Entry point principal del sistema de cold outreach.
 *
 * Uso:
 *   node outreach/outreach.js            → ejecuta envíos reales
 *   node outreach/outreach.js --dry-run  → simula sin enviar
 */

// ─── 0. Setup inicial ─────────────────────────────────────────────────────────
// Mover CWD al raíz del proyecto (solarpower-agent/) para que
// DB_PATH y demás rutas relativas funcionen sin importar desde dónde se corre.

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

// ─── 1. Imports (después de dotenv) ──────────────────────────────────────────

const {
  saveLead,
  updateLeadStatus,
  getLeadByEmail,
  getLeadByWhatsapp,
  countSentToday,
  getPendingLeads,
} = require('./db');

const { runSearch }        = require('./searcher');
const { sendToLead }       = require('./sender');
const { getEmailContent, getWhatsappContent } = require('./templates');
const { generateReport }   = require('./reporter');

// ─── Configuración ────────────────────────────────────────────────────────────

const DAILY_LIMIT  = parseInt(process.env.DAILY_EMAIL_LIMIT     || '20',    10);
const SEND_DELAY   = parseInt(process.env.DELAY_BETWEEN_SENDS_MS || '35000', 10);
const DRY_RUN      = process.argv.includes('--dry-run');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[outreach] ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) log('=== MODO DRY-RUN — no se enviará nada ===');
  log(`Iniciando sesión de outreach — ${new Date().toLocaleString('es-AR')}`);

  // ── 1. Verificar env vars críticas ────────────────────────────────────────
  if (!process.env.PERPLEXITY_API_KEY) {
    console.error('[outreach] ERROR: Falta PERPLEXITY_API_KEY en .env. Saliendo.');
    process.exit(1);
  }

  // ── 2. Verificar cuánto espacio queda en el límite diario ─────────────────
  const yaEnviados = countSentToday();
  if (yaEnviados >= DAILY_LIMIT) {
    log(`Límite diario alcanzado (${yaEnviados}/${DAILY_LIMIT}). No se envía nada hoy.`);
    await generateReport({
      busquedas: 0, encontradas: 0, conEmail: 0, soloWA: 0, sinContacto: 0,
      enviadosEmail: 0, enviadosWA: 0, errores: 0,
      pendientes: getPendingLeads(9999).length,
      enviados: [], pendientesList: getPendingLeads(50),
    }, DRY_RUN);
    return;
  }

  const limiteDisponible = DAILY_LIMIT - yaEnviados;
  log(`Enviados hoy: ${yaEnviados}/${DAILY_LIMIT} | Espacio disponible: ${limiteDisponible}`);

  // ── 3. Buscar con Perplexity (solo si hay menos de 50 leads pendientes) ────
  const pendientesActuales = getPendingLeads(9999);
  let empresas = [];

  if (pendientesActuales.length >= 50) {
    log(`${pendientesActuales.length} leads pendientes en DB — omitiendo búsqueda de Perplexity.`);
  } else {
    log('Iniciando búsqueda en Perplexity...');
    empresas = await runSearch();
  }
  log(`Empresas encontradas: ${empresas.length}`);

  // ── 4. Guardar nuevas empresas en DB ──────────────────────────────────────
  let nuevas = 0;
  let conEmail = 0;
  let soloWA = 0;
  let sinContacto = 0;

  for (const emp of empresas) {
    // Verificar duplicados
    if (emp.email    && getLeadByEmail(emp.email))       continue;
    if (emp.whatsapp && getLeadByWhatsapp(emp.whatsapp)) continue;

    const id = saveLead(emp);
    if (id) {
      nuevas++;
      if (emp.email)          conEmail++;
      else if (emp.whatsapp)  soloWA++;
    }
  }

  log(`Leads nuevos guardados: ${nuevas} (${conEmail} email, ${soloWA} solo WA)`);

  // ── 5. Traer leads pendientes (incluye los de días anteriores) ────────────
  const pendientes = getPendingLeads(limiteDisponible);
  log(`Leads pendientes a procesar: ${pendientes.length}`);

  // ── 6. Enviar ─────────────────────────────────────────────────────────────
  const enviados       = [];
  const errores        = [];
  let enviadosEmail    = 0;
  let enviadosWA       = 0;

  for (const lead of pendientes) {
    // GUARDIA CRÍTICA: nunca re-enviar un lead que ya fue enviado alguna vez
    if (lead.fecha_enviado) {
      log(`SKIP: ${lead.nombre} — ya enviado el ${lead.fecha_enviado} (omitido)`);
      continue;
    }

    // Re-verificar límite en cada iteración (puede cambiar si hay otro proceso)
    const sentNow = countSentToday();
    if (sentNow >= DAILY_LIMIT) {
      log('Límite diario alcanzado durante el loop. Deteniendo envíos.');
      break;
    }

    // Generar contenido según el canal
    let asunto  = null;
    let mensaje = null;
    let canal   = null;

    if (lead.email) {
      canal           = 'email';
      const content   = getEmailContent(lead);
      asunto          = content.asunto;
      mensaje         = content.cuerpo;
    } else if (lead.whatsapp) {
      canal           = 'whatsapp';
      mensaje         = getWhatsappContent(lead);
    } else {
      log(`SKIP: ${lead.nombre} — sin datos de contacto`);
      updateLeadStatus(lead.id, 'descartado', { notas: 'sin email ni whatsapp' });
      continue;
    }

    // Guardar contenido en DB antes de enviar
    updateLeadStatus(lead.id, 'pendiente', {
      canal_envio:    canal,
      email_asunto:   asunto,
      mensaje_cuerpo: mensaje,
    });

    // Preparar el objeto lead completo para el sender
    const leadConContenido = {
      ...lead,
      canal_envio:    canal,
      email_asunto:   asunto,
      mensaje_cuerpo: mensaje,
    };

    // Enviar
    let result;
    try {
      result = await sendToLead(leadConContenido, DRY_RUN);
    } catch (err) {
      result = { canal, ok: false, error: err.message };
    }

    if (result.error === 'DAILY_LIMIT_REACHED') {
      log('Límite diario alcanzado. Deteniendo envíos.');
      break;
    }

    if (result.ok) {
      updateLeadStatus(lead.id, 'enviado', { canal_envio: canal });
      enviados.push({ ...lead, canal_envio: canal });
      if (canal === 'email') enviadosEmail++;
      else                   enviadosWA++;
      log(`✓ ${canal.toUpperCase()} → ${lead.nombre} <${lead.email || lead.whatsapp}>`);
    } else {
      updateLeadStatus(lead.id, 'rebotado', { notas: result.error });
      errores.push({ lead, error: result.error });
      log(`✗ ERROR (${lead.nombre}): ${result.error}`);
    }

    // Esperar entre envíos (saltear en dry-run)
    if (!DRY_RUN) await sleep(SEND_DELAY);
  }

  // ── 7. Reporte final ──────────────────────────────────────────────────────
  const pendientesRestantes = getPendingLeads(9999);

  log('Generando reporte...');
  await generateReport({
    busquedas:    (process.env._SEARCH_COUNT ? parseInt(process.env._SEARCH_COUNT) : 0),
    encontradas:  empresas.length,
    conEmail,
    soloWA,
    sinContacto,
    enviadosEmail,
    enviadosWA,
    errores:      errores.length,
    pendientes:   pendientesRestantes.length,
    enviados,
    pendientesList: pendientesRestantes.slice(0, 50),
  }, DRY_RUN);

  log(`Sesión completada. Enviados: ${enviadosEmail + enviadosWA} | Errores: ${errores.length}`);

  // ── 8. Preview de contenido (primeros 3 mensajes generados) ──────────────
  if (DRY_RUN && pendientes.length > 0) {
    console.log('\n============================================================');
    console.log('PREVIEW — primeros 3 mensajes que se generarían:');
    console.log('============================================================\n');

    const preview = pendientes.slice(0, 3);
    for (const [i, lead] of preview.entries()) {
      console.log(`--- #${i + 1}: ${lead.nombre} (${lead.zona}) ---`);
      if (lead.email) {
        const { asunto, cuerpo } = getEmailContent(lead);
        console.log(`Canal: EMAIL → ${lead.email}`);
        console.log(`Asunto: ${asunto}`);
        console.log(`Cuerpo:\n${cuerpo}`);
      } else if (lead.whatsapp) {
        const msg = getWhatsappContent(lead);
        console.log(`Canal: WHATSAPP → ${lead.whatsapp}`);
        console.log(`Mensaje:\n${msg}`);
      }
      console.log('');
    }
  }
}

main().catch(err => {
  console.error('[outreach] Error fatal:', err);
  process.exit(1);
});
