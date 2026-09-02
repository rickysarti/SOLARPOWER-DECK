'use strict';

/**
 * outreach/sender.js
 * Decide el canal de envío y ejecuta el envío.
 *
 * Email  → nodemailer via SMTP de Gmail (App Password)
 * WA     → desactivado: SendPulse /sendByPhone requiere contacto suscriptor previo,
 *          no soporta cold outreach a números nuevos sin templates aprobados por Meta.
 *          Los leads con solo whatsapp se omiten y se marcan como 'descartado'.
 */

const nodemailer      = require('nodemailer');
const { countSentToday } = require('./db');

const DAILY_LIMIT = parseInt(process.env.DAILY_EMAIL_LIMIT || '20', 10);

// ─── Transporte SMTP ──────────────────────────────────────────────────────────

function createTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      'Faltan credenciales SMTP. Completar GMAIL_USER y GMAIL_APP_PASSWORD en .env. ' +
      'Obtener App Password en: https://myaccount.google.com/apppasswords'
    );
  }

  return nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth:   { user, pass },
  });
}

/**
 * Envía un email via SMTP.
 * Si falla por autenticación (535), loggea instrucciones claras.
 * Si falla por rate limit (421/450), espera 60s y reintenta una vez.
 */
async function sendEmail(to, subject, body) {
  const transport = createTransport();

  const mailOptions = {
    from:    `"SolarPower" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text:    body,
  };

  try {
    const info = await transport.sendMail(mailOptions);
    return info;
  } catch (err) {
    // Rate limit / temp fail → reintentar una vez
    if (err.responseCode === 421 || err.responseCode === 450) {
      console.warn('[sender] SMTP rate limit — esperando 60s y reintentando...');
      await sleep(60000);
      const info = await transport.sendMail(mailOptions);
      return info;
    }
    // Auth error → mensaje claro
    if (err.responseCode === 535 || (err.message && err.message.includes('Invalid login'))) {
      throw new Error(
        'Error de autenticación SMTP (535). ' +
        'Verificar que GMAIL_APP_PASSWORD en .env sea un App Password de Google válido. ' +
        'Generarlo en: https://myaccount.google.com/apppasswords'
      );
    }
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Envía a un lead por el canal correspondiente.
 *
 * Canal email  → nodemailer SMTP
 * Canal WA     → descartado (no soportado para cold outreach)
 *
 * @param {Object}  lead    - registro de outreach_leads con asunto y cuerpo ya seteados
 * @param {boolean} dryRun  - si true, loggea pero no envía
 * @returns {Promise<{ canal: string, ok: boolean, error?: string }>}
 */
async function sendToLead(lead, dryRun = false) {
  // Verificar límite diario antes de enviar
  const sentHoy = countSentToday();
  if (sentHoy >= DAILY_LIMIT) {
    return { canal: null, ok: false, error: 'DAILY_LIMIT_REACHED' };
  }

  // Solo canal email habilitado
  if (!lead.email) {
    console.log(`  [SKIP] ${lead.nombre} — sin email, descartado`);
    return { canal: null, ok: false, error: 'NO_EMAIL' };
  }
  const canal = 'email';

  if (dryRun) {
    console.log(`  [DRY-RUN] ${canal.toUpperCase()} → ${lead.nombre} <${lead.email}>`);
    console.log(`  Asunto: ${lead.email_asunto || '(sin asunto)'}`);
    console.log(`  Mensaje: ${(lead.mensaje_cuerpo || '').slice(0, 120)}...`);
    return { canal, ok: true };
  }

  try {
    await sendEmail(lead.email, lead.email_asunto, lead.mensaje_cuerpo);
    return { canal, ok: true };
  } catch (err) {
    return { canal, ok: false, error: err.message };
  }
}

module.exports = { sendToLead };
