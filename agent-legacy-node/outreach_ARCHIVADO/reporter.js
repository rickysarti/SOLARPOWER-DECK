'use strict';

/**
 * outreach/reporter.js
 * Genera el reporte de sesión y notifica a Ricardo por WhatsApp.
 */

const fs        = require('fs');
const path      = require('path');
const sendpulse = require('../sendpulse');

const REPORTS_DIR  = path.join(__dirname, 'reports');
const RICARDO_PHONE = process.env.RICARDO_PHONE || '5491134583958';

/**
 * Genera el archivo de reporte y notifica a Ricardo.
 *
 * @param {Object} stats
 * @param {number} stats.busquedas          - cantidad de búsquedas ejecutadas
 * @param {number} stats.encontradas        - empresas encontradas en total
 * @param {number} stats.conEmail           - empresas con email
 * @param {number} stats.soloWA             - empresas solo WhatsApp
 * @param {number} stats.sinContacto        - descartadas por sin contacto
 * @param {number} stats.enviadosEmail      - enviados por email en esta sesión
 * @param {number} stats.enviadosWA         - enviados por WhatsApp en esta sesión
 * @param {number} stats.pendientes         - pendientes para mañana
 * @param {number} stats.errores            - errores de envío
 * @param {Array}  stats.enviados           - lista de leads enviados
 * @param {Array}  stats.pendientesList     - lista de leads pendientes
 */
async function generateReport(stats, isDryRun = false) {
  const now   = new Date();
  const fecha = now.toISOString().split('T')[0];                       // YYYY-MM-DD
  const hora  = now.toTimeString().split(' ')[0];                      // HH:MM:SS
  const totalEnviados = stats.enviadosEmail + stats.enviadosWA;

  // ─── Construir contenido del reporte ─────────────────────────────────────

  const lines = [
    `SESIÓN OUTREACH — ${fecha} ${hora}`,
    '==================================',
    `Búsquedas Perplexity: ${stats.busquedas}`,
    `Empresas encontradas: ${stats.encontradas}`,
    `  Con email: ${stats.conEmail}`,
    `  Solo WhatsApp: ${stats.soloWA}`,
    `  Sin contacto (descartadas): ${stats.sinContacto}`,
    `Enviados hoy: ${totalEnviados} / 20`,
    `  Por email: ${stats.enviadosEmail}`,
    `  Por WhatsApp: ${stats.enviadosWA}`,
    `Pendientes para mañana: ${stats.pendientes}`,
    `Errores: ${stats.errores}`,
    '',
    'ENVIADOS:',
  ];

  if (stats.enviados && stats.enviados.length > 0) {
    for (const lead of stats.enviados) {
      const contacto = lead.email || lead.whatsapp || '-';
      lines.push(`${lead.nombre} | ${contacto} | ${lead.canal_envio || '-'} | ${lead.rubro || '-'} | ${lead.zona || '-'}`);
    }
  } else {
    lines.push('(ninguno)');
  }

  lines.push('');
  lines.push('PENDIENTES PARA MAÑANA:');

  if (stats.pendientesList && stats.pendientesList.length > 0) {
    for (const lead of stats.pendientesList) {
      const contacto = lead.email || lead.whatsapp || '-';
      lines.push(`${lead.nombre} | ${contacto} | ${lead.canal_envio || '-'} | ${lead.rubro || '-'} | ${lead.zona || '-'}`);
    }
  } else {
    lines.push('(ninguno)');
  }

  const contenido = lines.join('\n') + '\n';

  // ─── Guardar archivo ──────────────────────────────────────────────────────

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const filePath = path.join(REPORTS_DIR, `outreach_${fecha}.txt`);
  fs.writeFileSync(filePath, contenido, 'utf8');
  console.log(`[reporter] Reporte guardado: ${filePath}`);

  // ─── Notificar a Ricardo por WhatsApp ────────────────────────────────────

  if (isDryRun) {
    console.log('[reporter] DRY-RUN: notificación a Ricardo omitida.');
  } else {
    const resumen =
      `Outreach ${fecha}: ${totalEnviados} enviados (${stats.enviadosEmail} email, ${stats.enviadosWA} WA) | ${stats.pendientes} pendientes | ${stats.errores} errores.`;

    try {
      await sendpulse.initialize();
      await sendpulse.sendMessage(RICARDO_PHONE, resumen);
      console.log(`[reporter] Notificación enviada a Ricardo (${RICARDO_PHONE})`);
    } catch (err) {
      console.warn(`[reporter] No se pudo notificar a Ricardo: ${err.message}. Reporte guardado en ${filePath}`);
    }
  }

  return filePath;
}

module.exports = { generateReport };
