'use strict';

const path = require('path');
process.chdir(__dirname);
require('dotenv').config();

const http        = require('http');
const fs          = require('fs');
const { spawn }   = require('child_process');
const nodemailer  = require('nodemailer');

const HEALTH_URL      = 'http://localhost:3000/health';
const ALERT_TO        = 'riki@sarti.com.ar';
const COOLDOWN_MS     = 30 * 60 * 1000; // 30 minutos
const TIMESTAMP_FILE  = path.join(__dirname, 'monitor-last-alert.txt');
const TUNNEL_URL_FILE = path.join(__dirname, 'tunnel-url.txt');
const TIMEOUT_MS      = 8000;
const RELAUNCH_WAIT_MS = 22000; // esperar a que cloudflared levante el tunnel

function log(msg) {
  console.log(`[monitor-bot] ${new Date().toLocaleString('es-AR')} — ${msg}`);
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: TIMEOUT_MS }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error',   () => resolve(false));
  });
}

function isInCooldown() {
  try {
    const ts = parseInt(fs.readFileSync(TIMESTAMP_FILE, 'utf8').trim(), 10);
    return !isNaN(ts) && (Date.now() - ts) < COOLDOWN_MS;
  } catch {
    return false;
  }
}

function saveCooldownTimestamp() {
  fs.writeFileSync(TIMESTAMP_FILE, String(Date.now()), 'utf8');
}

function relaunchBot() {
  return new Promise((resolve) => {
    log('Intentando relanzar el bot (node index.js)...');

    // Borrar tunnel-url.txt viejo para no leer una URL stale
    try { fs.unlinkSync(TUNNEL_URL_FILE); } catch { /* no existía */ }

    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
      windowsHide: true,
    });
    child.unref();

    log(`Bot relanzado (PID ${child.pid}). Esperando ${RELAUNCH_WAIT_MS / 1000}s para que levante el tunnel...`);

    setTimeout(() => {
      let webhookUrl = null;
      try {
        webhookUrl = fs.readFileSync(TUNNEL_URL_FILE, 'utf8').trim();
        log(`Nueva webhook URL: ${webhookUrl}`);
      } catch {
        log('No se pudo leer tunnel-url.txt todavía (puede tardar unos segundos más).');
      }
      resolve(webhookUrl);
    }, RELAUNCH_WAIT_MS);
  });
}

async function sendAlert(webhookUrl) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    log('ERROR: Faltan GMAIL_USER o GMAIL_APP_PASSWORD en .env. No se puede enviar alerta.');
    return;
  }

  const transport = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth:   { user, pass },
  });

  const now = new Date().toLocaleString('es-AR');

  const urlSection = webhookUrl
    ? [
        '',
        '─── WEBHOOK URL PARA SENDPULSE ───────────────────────────────────',
        `  ${webhookUrl}`,
        '',
        'Pegá esa URL en SendPulse → Configuración Bot → Webhook URL',
        '──────────────────────────────────────────────────────────────────',
      ]
    : [
        '',
        'No se pudo obtener la nueva webhook URL todavía.',
        'Esperá unos segundos y revisá la consola del bot para obtenerla.',
      ];

  await transport.sendMail({
    from:    `"SolarPower Monitor" <${user}>`,
    to:      ALERT_TO,
    subject: '⚠️ Bot WhatsApp SolarPower caído — se intentó reiniciar automáticamente',
    text: [
      `Alerta generada el ${now}`,
      '',
      'El bot de WhatsApp SolarPower (solarpower-agent) no respondía.',
      `URL monitoreada: ${HEALTH_URL}`,
      '',
      'Se intentó reiniciar el proceso automáticamente.',
      ...urlSection,
      '',
      'Si el bot no levantó, reiniciá manualmente con `npm start` en la carpeta del proyecto.',
    ].join('\n'),
  });

  log(`Alerta enviada a ${ALERT_TO}`);
}

async function main() {
  const ok = await checkHealth();

  if (ok) {
    log('Bot OK — /health responde correctamente.');
    return;
  }

  log('Bot NO responde en /health.');

  if (isInCooldown()) {
    log('Cooldown activo (alerta enviada hace menos de 30 min). No se reenvía.');
    return;
  }

  let webhookUrl = null;
  try {
    webhookUrl = await relaunchBot();
  } catch (err) {
    log(`ERROR al intentar relanzar el bot: ${err.message}`);
  }

  try {
    await sendAlert(webhookUrl);
    saveCooldownTimestamp();
  } catch (err) {
    log(`ERROR al enviar alerta: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  log(`Error fatal: ${err.message}`);
  process.exit(1);
});
