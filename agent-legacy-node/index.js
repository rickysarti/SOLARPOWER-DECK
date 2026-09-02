/**
 * index.js
 * Servidor principal Express.
 * Expone el webhook de WhatsApp, health check y dashboard básico.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

// FAILSAFE: si stdout/stderr no puede escribir (ej. ENOSPC con disco C: lleno),
// no tirar abajo el proceso. Esto fue lo que crasheo el bot el 2026-06-30 (ver bot-err.log).
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { processMessage, storeContactFile } = require('./agent');
const sendpulse = require('./sendpulse');
const { getPendingActions, getAllContacts, getMessageCountToday, getUpcomingEvents, getOverdueEvents, markReminderSent, setHumanMode, getHistory, getContact, getRecentPendingActions, getOrCreateContact, updateContact, getAgendaEvents } = require('./database');
const { notifyRicardo } = require('./notifier');
const { formatReminderMessage, processInternalChatMessage } = require('./agenda-agent');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Buffer de mensajes por teléfono (30 segundos) ────────────────────────────

/**
 * Acumula mensajes del mismo número durante 30 segundos y los procesa juntos.
 * Evita responder por separado cuando el cliente manda varios mensajes seguidos.
 */
const messageBuffers = new Map(); // phone → { messages: [], contactName, timer }

function tagText(tag) {
  if (!tag) return '';
  if (typeof tag === 'string') return tag;
  return tag.name || tag.title || tag.label || tag.value || '';
}

function hasHumanControlTag(tags = []) {
  return tags
    .map(tagText)
    .some(tag => /humano|human|manual|pausad|tomado|asesor|operador|ricardo/i.test(tag));
}

// ─── Circuit breaker para errores sistémicos ──────────────────────────────────
// Evita mandar "Un segundo" a todos cuando hay un fallo de infraestructura
// (disco lleno, SQLite caído, etc.)
const _errorCB = {
  timestamps: [],      // timestamps de errores recientes
  alerted: false,      // si ya notificamos a Ricardo de este brote
  alertedAt: 0,        // cuándo fue la última alerta
  WINDOW_MS: 60_000,   // ventana de 60 segundos
  MAX_ERRORS: 3,       // umbral: si supera esto → modo silencioso
};

// Errores que indican fallo de infraestructura (no transitorios)
const SYSTEMIC_ERRORS = /ENOSPC|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_IOERR|disk|no space|EROFS|EACCES/i;

function isSystemicError(err) {
  return SYSTEMIC_ERRORS.test(err.message || '') || SYSTEMIC_ERRORS.test(err.code || '');
}

function circuitBreakerTripped() {
  const now = Date.now();
  // Limpiar timestamps viejos
  _errorCB.timestamps = _errorCB.timestamps.filter(t => now - t < _errorCB.WINDOW_MS);
  _errorCB.timestamps.push(now);
  return _errorCB.timestamps.length > _errorCB.MAX_ERRORS;
}

async function handleProcessError(source, phone, contactName, err) {
  logger.error(`[${source}] Error procesando mensaje de ${phone}: ${err.message}`);

  const systemic = isSystemicError(err);
  const tripped   = circuitBreakerTripped();

  if (systemic || tripped) {
    // Fallo sistémico o demasiados errores seguidos → NO spamear usuarios
    logger.error(`[CIRCUIT-BREAKER] Fallo ${systemic ? 'sistémico' : 'repetido'} detectado — suprimiendo mensaje al usuario ${phone}`);

    // Notificar a Ricardo UNA sola vez por brote (máx cada 5 min)
    const now = Date.now();
    if (!_errorCB.alerted || now - _errorCB.alertedAt > 5 * 60_000) {
      _errorCB.alerted  = true;
      _errorCB.alertedAt = now;
      try {
        const dummyContact = { phone: process.env.RICARDO_PHONE, name: 'Sistema', label: '⚠️', bill_received: 0, roof_type: null, connection_type: null, locality: null, product_interest: null };
        await notifyRicardo(
          dummyContact,
          `🔴 Bot caído — fallo ${systemic ? 'sistémico' : 'en cascada'}`,
          `Múltiples mensajes están fallando.\n\nÚltimo error: ${err.message}\n\nLos usuarios NO están recibiendo el mensaje "Un segundo". Revisá disco, logs y reiniciá el bot si es necesario.`,
          'support'
        );
      } catch (notifyErr) {
        logger.error(`[CIRCUIT-BREAKER] No se pudo notificar a Ricardo: ${notifyErr.message}`);
      }
    }
    return; // No hacer nada más
  }

  // Error transitorio normal → comportamiento original
  try {
    await sendpulse.sendMessage(phone, 'Un segundo, ahora te respondo 🙏');
  } catch (sendErr) {
    logger.warn(`[${source}] No se pudo enviar fallback a ${phone}: ${sendErr.message}`);
  }

  try {
    const contact = getOrCreateContact(phone, contactName);
    await notifyRicardo(
      contact,
      'Error procesando mensaje del bot',
      `El bot falló al procesar el último mensaje.\n\nError: ${err.message}\n\nhttps://wa.me/${phone}`,
      'support'
    );
  } catch (notifyErr) {
    logger.error(`[${source}] Error notificando fallo a Ricardo: ${notifyErr.message}`);
  }
}

function bufferAndProcess(phone, text, contactName, delayMs = 20000) {
  // Sin buffer: procesar inmediatamente
  if (delayMs === 0) {
    processMessage(phone, text, contactName).catch(err => {
      handleProcessError('DIRECTO', phone, contactName, err);
    });
    return;
  }

  if (!messageBuffers.has(phone)) {
    messageBuffers.set(phone, { messages: [], contactName: contactName || null, timer: null });
  }
  const buffer = messageBuffers.get(phone);
  buffer.messages.push(text);
  if (contactName && !buffer.contactName) buffer.contactName = contactName;

  // Reiniciar el timer cada vez que llega un mensaje nuevo
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    const pending = messageBuffers.get(phone);
    if (!pending) return;
    messageBuffers.delete(phone);
    const combined = pending.messages.join('\n');
    logger.info(`[BUFFER] Procesando ${pending.messages.length} mensaje(s) de ${phone}`);
    processMessage(phone, combined, pending.contactName).catch(err => {
      handleProcessError('BUFFER', phone, pending.contactName, err);
    });
  }, delayMs);
}

// ─── Análisis de imágenes con Claude Vision ────────────────────────────────────

/**
 * Descarga una imagen desde SendPulse y pide a Claude una descripción breve.
 * Se usa para dar contexto al bot cuando el cliente manda una foto.
 *
 * @param {string} fileUrl - URL autenticada de la imagen en SendPulse
 * @param {string} mimeType - MIME type de la imagen (ej: 'image/jpeg')
 * @returns {string|null} Descripción breve en español o null si falla
 */
async function analyzeImageWithClaude(fileUrl, mimeType) {
  try {
    const spToken = await sendpulse.getValidToken();
    const resp = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${spToken}` },
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    const base64Data = Buffer.from(resp.data).toString('base64');
    const safeMime   = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response  = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: safeMime, data: base64Data }
          },
          {
            type: 'text',
            text: 'Describí en una oración qué se ve en esta imagen. Si es una factura de luz, indicalo. Si es una foto de techo, panel solar o instalación eléctrica, describí lo que ves. Sé breve y específico. Respondé en español.'
          }
        ]
      }]
    });

    const description = response.content[0]?.text?.trim() || null;
    logger.info(`[VISION] Imagen analizada: "${(description || 'sin resultado').substring(0, 100)}"`);
    return description;

  } catch (err) {
    logger.warn(`[VISION] Error analizando imagen (${fileUrl?.substring(0, 60)}): ${err.message}`);
    return null;
  }
}

// Middleware para parsear JSON
app.use(express.json());

// Middleware para logear todas las requests entrantes
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ─── Webhook principal de WhatsApp ───────────────────────────────────────────

/**
 * POST /webhook/whatsapp
 * Recibe mensajes entrantes de SendPulse y los procesa con el agente.
 *
 * Payload esperado de SendPulse:
 * {
 *   "contact": { "phone": "5491134583958", "name": "Juan Pérez" },
 *   "message": { "type": "text", "text": { "body": "Hola quiero info" } },
 *   "bot_id": "xxxxx"
 * }
 */
app.post('/webhook/whatsapp', async (req, res) => {
  // Responder 200 inmediatamente para que SendPulse no reintente
  res.status(200).json({ status: 'received' });

  const rawPayload = req.body;

  // Log SIEMPRE del payload completo para debug
  logger.info(`[WEBHOOK RAW] ${JSON.stringify(rawPayload).substring(0, 500)}`);

  let payload;
  try {
    // SendPulse manda un array con un objeto adentro → tomamos el primero
    payload = Array.isArray(rawPayload) ? rawPayload[0] : rawPayload;

    // Extraer campos según la estructura real de SendPulse
    const phone = String(payload?.contact?.phone || '').trim();
    const contactName = payload?.contact?.name || null;
    const contactId = payload?.contact?.id || null;

    // Intentar extraer el texto desde múltiples rutas del payload.
    // Mensajes del bot (vía API) llegan con channel_data; mensajes manuales
    // desde WhatsApp Web o SendPulse pueden llegar sin channel_data.
    const channelMsg = payload?.info?.message?.channel_data?.message;
    const messageType = channelMsg?.type || payload?.info?.message?.type || null;
    const messageText =
      channelMsg?.text?.body ||
      channelMsg?.text ||
      payload?.info?.message?.text?.body ||
      payload?.info?.message?.text ||
      payload?.message?.text?.body ||
      null;

    const webhookTitle = payload?.title || 'unknown';

    if (!phone) {
      logger.warn('Webhook recibido sin número de teléfono');
      return;
    }

    // ── Detección de mensaje saliente (Ricardo tomando control manual) ────────
    // Se detecta cualquier webhook que NO sea incoming_message.
    // Si el texto NO coincide exactamente con el último mensaje del bot,
    // se asume que fue enviado manualmente por Ricardo → activar human mode.
    const OUTGOING_TITLES = ['outgoing_message', 'message_sent', 'operator_message', 'admin_message', 'sent_message', 'human_message', 'agent_message'];
    const isOutgoing = OUTGOING_TITLES.includes(webhookTitle) ||
      payload?.info?.message?.direction === 'outgoing' ||
      payload?.info?.message?.from_me === true;
    const isIncoming = webhookTitle === 'incoming_message' || webhookTitle === 'unknown';

    if (!isOutgoing && !isIncoming) {
      logger.info(`[WEBHOOK EVENT] Evento no conversacional ignorado title="${webhookTitle}" phone=${phone}`);
      return;
    }

    if (isOutgoing) {
      // Log del payload COMPLETO — esencial para analizar estructura de mensajes manuales
      logger.info(`[OUTGOING] title="${webhookTitle}" phone=${phone} text="${(messageText || '[sin texto]').substring(0, 120)}"`);
      logger.info(`[OUTGOING FULL] ${JSON.stringify(payload).substring(0, 2000)}`);

      const RICARDO_PHONE = process.env.RICARDO_PHONE;
      const AGENDA_PHONE = process.env.AGENDA_PHONE;
      const GUILLERMO_PHONE = process.env.RICARDO_GUILLERMO_PHONE;
      const RICARDO_NORM = sendpulse.normalizePhone(RICARDO_PHONE || '');
      const AGENDA_NORM = sendpulse.normalizePhone(AGENDA_PHONE || '');
      const GUILLERMO_NORM = sendpulse.normalizePhone(GUILLERMO_PHONE || '');

      // Ignorar mensajes enviados a números internos (agenda / notificaciones / chat interno)
      if (phone === RICARDO_NORM || (AGENDA_NORM && phone === AGENDA_NORM) || (GUILLERMO_NORM && phone === GUILLERMO_NORM)) return;

      // Detectar si es eco del bot (mensaje enviado vía API por el propio Tomás).
      // Comparación ESTRICTA: solo match exacto normalizado.
      // !messageText = puede ser imagen/archivo enviado manualmente → NO es eco.
      const isBotEcho = (() => {
        if (!messageText) return false; // imagen/media manual → tratar como control humano
        const history = getHistory(phone, 5);
        const lastBotMsg = history.slice().reverse().find(m => m.role === 'assistant');
        if (!lastBotMsg) return false;
        const normalize = s => s.replace(/\s+/g, ' ').trim();
        const normalBot = normalize(lastBotMsg.content);
        const normalWebhook = normalize(messageText);
        // Solo match EXACTO — evitar falsos positivos con mensajes similares
        return normalBot === normalWebhook;
      })();

      if (!isBotEcho) {
        // Ricardo tomó control manualmente → pausar bot para este contacto
        let contact = getContact(phone);
        if (!contact) {
          // Crear contacto si no existe (Ricky respondió antes de que el cliente escribiera al bot)
          contact = getOrCreateContact(phone, contactName);
        }
        setHumanMode(phone, true);
        logger.info(`[AUTO HUMAN MODE] Bot pausado para ${phone} (${contact?.name || 'sin nombre'}) — mensaje manual detectado`);

        // Notificar a Ricardo en su número de agenda
        if (AGENDA_PHONE) {
          const name = contact?.name || phone;
          const waLink = `https://wa.me/${phone}`;
          const tipoMsg = messageText ? `"${messageText.substring(0, 60)}${messageText.length > 60 ? '...' : ''}"` : 'un archivo/imagen';
          await sendpulse.sendMessage(
            AGENDA_PHONE,
            `🤖 *Bot pausado automáticamente*\n\n` +
            `Enviaste ${tipoMsg} a *${name}*\n${waLink}\n\n` +
            `Tomás dejó de responder ese chat.\n\n` +
            `Cuando termines escribime:\n*liberar ${phone}*`
          ).catch(() => {});
        }
      } else {
        logger.debug(`[BOT ECHO] Ignorando eco de Tomás para ${phone}`);
      }
      return;
    }

    // ── Manejo de imágenes, documentos, videos y audios ──────────────────────
    const FILE_TYPES = ['image', 'document', 'video', 'audio'];
    if (!messageText && FILE_TYPES.includes(messageType)) {
      const caption = channelMsg?.[messageType]?.caption || '';
      const filename = channelMsg?.[messageType]?.filename || '';
      const fileMetaText = `${caption} ${filename}`;
      const isCvDocument = messageType === 'document' && /\bcv\b|curriculum|resume|hoja de vida/i.test(fileMetaText);
      let syntheticText;

      if (messageType === 'image') {
        // Intentar analizar la imagen con Claude Vision
        const imageUrl  = channelMsg?.image?.url;
        const imageMime = channelMsg?.image?.mime_type || 'image/jpeg';
        logger.info(`[IMAGEN] Mensaje tipo image de ${phone} — intentando análisis con Claude Vision`);
        if (imageUrl) {
          const description = await analyzeImageWithClaude(imageUrl, imageMime);
          syntheticText = description
            ? `[El cliente envió una imagen: ${description}]`
            : caption
              ? `[El cliente envió una imagen con el mensaje: "${caption}"]`
              : `[El cliente envió una imagen — posiblemente la factura de luz o un documento relacionado]`;
        } else {
          syntheticText = caption
            ? `[El cliente envió una imagen con el mensaje: "${caption}"]`
            : `[El cliente envió una imagen — posiblemente la factura de luz o un documento relacionado]`;
        }

      } else if (messageType === 'audio') {
        // Audio: no se puede transcribir automáticamente, pero no se ignora
        logger.info(`[AUDIO] Mensaje tipo audio de ${phone} — generando placeholder`);
        syntheticText = caption
          ? `[El cliente envió un audio con el mensaje: "${caption}"]`
          : `[El cliente envió un audio — no es posible transcribirlo automáticamente. Podés pedirle que escriba su consulta en texto.]`;

      } else {
        // document / video
        const typeLabel = messageType === 'document' ? 'un documento' : 'un archivo';
        logger.info(`[ARCHIVO] Mensaje tipo ${messageType} de ${phone} — procesando`);
        if (isCvDocument) {
          syntheticText = `[El cliente envio un CV o curriculum por WhatsApp${filename ? ` (${filename})` : ''}. Indicale que debe enviarlo por email para evaluacion.]`;
        } else {
          syntheticText = caption
            ? `[El cliente envió ${typeLabel} con el mensaje: "${caption}"]`
            : `[El cliente envió ${typeLabel} — posiblemente la factura de luz o un documento relacionado]`;
        }
      }

      logger.info(`[ARCHIVO] Texto sintético para ${phone}: "${syntheticText.substring(0, 120)}"`);

      // Guardar URL del archivo para que triggerEnergyAnalysis() lo descargue y procese
      // Solo aplica a imágenes y documentos, no a audio ni video
      if ((messageType === 'image' || messageType === 'document') && !isCvDocument) {
        storeContactFile(phone, {
          url:      channelMsg?.[messageType]?.url,
          mimeType: channelMsg?.[messageType]?.mime_type || (messageType === 'image' ? 'image/jpeg' : 'application/pdf'),
          filename: channelMsg?.[messageType]?.filename || (messageType === 'image' ? `factura_${Date.now()}.jpg` : `factura_${Date.now()}.pdf`),
        });

        // Marcar factura como recibida en la DB
        const existingContact = getContact(phone);
        if (existingContact && !existingContact.bill_received) {
          updateContact(phone, { bill_received: 1 });
          logger.info(`[ARCHIVO] bill_received marcado para ${phone}`);
        } else if (!existingContact) {
          getOrCreateContact(phone, contactName);
          updateContact(phone, { bill_received: 1 });
        }
      }

      // Tags vienen directamente en el payload — si tiene tags, Ricardo tomó el control
      const tagsForFile = Array.isArray(payload?.contact?.tags) ? payload.contact.tags : [];
      if (hasHumanControlTag(tagsForFile)) {
        logger.info(`[SENDPULSE TAG] Archivo de ${phone} ignorado por tag de control humano — tags: ${JSON.stringify(tagsForFile)}`);
        return;
      }

      bufferAndProcess(phone, syntheticText, contactName);
      return;
    }

    if (!messageText && messageType === 'location') {
      const loc = channelMsg?.location || payload?.info?.message?.location || payload?.message?.location || {};
      const parts = [
        loc.name || loc.address || null,
        loc.latitude && loc.longitude ? `coordenadas ${loc.latitude}, ${loc.longitude}` : null
      ].filter(Boolean);
      const syntheticText = parts.length > 0
        ? `[El cliente compartio su ubicacion: ${parts.join(' - ')}]`
        : '[El cliente compartio una ubicacion por WhatsApp.]';
      logger.info(`[LOCATION] Texto sintetico para ${phone}: "${syntheticText}"`);
      bufferAndProcess(phone, syntheticText, contactName);
      return;
    }

    if (!messageText && messageType === 'unsupported') {
      const syntheticText = '[El cliente envio un mensaje que WhatsApp marco como no disponible o no soportado. Pedile que lo reenvie como texto, imagen o PDF.]';
      logger.info(`[UNSUPPORTED] Texto sintetico para ${phone}`);
      bufferAndProcess(phone, syntheticText, contactName);
      return;
    }

    if (!messageText || messageType !== 'text') {
      logger.info(`Mensaje ignorado (tipo: ${messageType}) de ${phone}`);
      return;
    }

    // Ricardo Guillermo (RICARDO_GUILLERMO_PHONE) → chatbot interno con acceso a DB
    const GUILLERMO_PHONE_NORM = process.env.RICARDO_GUILLERMO_PHONE
      ? sendpulse.normalizePhone(process.env.RICARDO_GUILLERMO_PHONE)
      : null;
    if (GUILLERMO_PHONE_NORM && sendpulse.normalizePhone(phone) === GUILLERMO_PHONE_NORM) {
      logger.info(`[CHAT-INTERNO] Mensaje de Ricardo Guillermo: "${messageText.substring(0, 100)}"`);
      processInternalChatMessage(phone, messageText).catch(err =>
        logger.error(`[CHAT-INTERNO] Error: ${err.message}`)
      );
      return;
    }

    // Ricardo Gastón (AGENDA_PHONE) → procesar de inmediato, sin buffer ni tag check
    const AGENDA_PHONE_NORM = process.env.AGENDA_PHONE
      ? sendpulse.normalizePhone(process.env.AGENDA_PHONE)
      : null;
    if (AGENDA_PHONE_NORM && sendpulse.normalizePhone(phone) === AGENDA_PHONE_NORM) {
      logger.info(`[AGENDA] Mensaje directo de Ricardo Gastón: "${messageText.substring(0, 100)}"`);
      bufferAndProcess(phone, messageText, contactName, 0);
      return;
    }

    // Leer tags del contacto desde el payload del webhook (ya vienen incluidos)
    // Si tiene cualquier tag → Ricardo tomó el control, bot en pausa
    const contactTags = Array.isArray(payload?.contact?.tags) ? payload.contact.tags : [];
    if (hasHumanControlTag(contactTags)) {
      logger.info(`[SENDPULSE TAG] Mensaje de ${phone} ignorado por tag de control humano — tags: ${JSON.stringify(contactTags)}`);
      return;
    }

    logger.info(`Mensaje recibido de ${phone} (${contactName}): "${messageText.substring(0, 100)}"`);

    // Bufferear 20 segundos por si manda más mensajes seguidos
    bufferAndProcess(phone, messageText, contactName, 20000);

  } catch (error) {
    logger.error(`Error en webhook: ${error.message}`, error);

    // Notificar a Ricardo y (solo si es error transitorio) al cliente
    try {
      const phone = payload?.contact?.phone;
      const contactName = payload?.contact?.name || null;
      if (phone) {
        // Reusar el mismo circuit breaker para consistencia
        await handleProcessError('WEBHOOK', phone, contactName, error);
      }
    } catch (notifyError) {
      logger.error(`Error al manejar el error del webhook: ${notifyError.message}`);
    }
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * GET /health
 * Retorna el estado del servidor y cantidad de acciones pendientes.
 */
app.get('/health', async (req, res) => {
  try {
    const pendingActions = getPendingActions();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      pendingActions: pendingActions.length,
      uptime: Math.floor(process.uptime()) + 's'
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── Dashboard básico ─────────────────────────────────────────────────────────

/**
 * GET /dashboard
 * Retorna un resumen del estado del bot para monitoreo.
 */
app.get('/dashboard', async (req, res) => {
  try {
    const allContacts = getAllContacts();
    const pendingActions = getPendingActions();
    const messagesToday = getMessageCountToday();

    // Agrupar contactos por etiqueta
    const byLabel = {};
    for (const contact of allContacts) {
      const label = contact.label || 'Sin etiqueta';
      byLabel[label] = (byLabel[label] || 0) + 1;
    }

    // Últimos 10 contactos activos
    const recentContacts = allContacts.slice(0, 10).map(c => ({
      phone: c.phone,
      name: c.name,
      label: c.label,
      last_contact: c.last_contact,
      product_interest: c.product_interest
    }));

    res.json({
      summary: {
        totalContacts: allContacts.length,
        messagesToday,
        pendingActions: pendingActions.length
      },
      contactsByLabel: byLabel,
      recentContacts,
      pendingActions: pendingActions.map(a => ({
        id: a.id,
        phone: a.contact_phone,
        contact_name: a.contact_name,
        type: a.action_type,
        description: a.description,
        created_at: a.created_at
      }))
    });
  } catch (error) {
    logger.error(`Error en dashboard: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── Manejo de errores global ────────────────────────────────────────────────

app.use((err, req, res, next) => {
  logger.error(`Error no manejado: ${err.message}`, err);
  res.status(500).json({ status: 'error', message: 'Error interno del servidor' });
});

// ─── Arranque del servidor ────────────────────────────────────────────────────

// ─── Cron: Recordatorios de agenda ───────────────────────────────────────────

/**
 * Cada 15 minutos verifica si hay eventos de Ricardo en la próxima hora
 * y envía un recordatorio por WhatsApp.
 */
function startReminderCron() {
  const AGENDA_PHONE = process.env.AGENDA_PHONE;
  if (!AGENDA_PHONE) {
    logger.warn('AGENDA_PHONE no configurado, recordatorios de agenda desactivados');
    return;
  }

  cron.schedule('*/15 * * * *', async () => {
    try {
      // ── Salida temprana si no hay nada pendiente ──────────────────────────
      const RICARDO_PHONE = process.env.RICARDO_PHONE;
      const upcoming = getUpcomingEvents(65);   // ventana 65 min → garantiza que el cron de 15 min no se pierde ninguno
      const overdue = getOverdueEvents(24);      // eventos vencidos (hasta 24h atrás) que no fueron avisados
      const recentActions = getRecentPendingActions(15);
      if (upcoming.length === 0 && overdue.length === 0 && recentActions.length === 0) return;

      // ── 1. Recordatorios de agenda (eventos próximos) ─────────────────────
      for (const event of upcoming) {
        const msg = formatReminderMessage(event, false);
        await sendpulse.sendMessage(AGENDA_PHONE, msg);
        markReminderSent(event.id);
        logger.info(`Recordatorio enviado a Ricardo: "${event.title}"`);
      }

      // ── 2. Eventos vencidos no avisados (bot estaba apagado, etc.) ────────
      if (overdue.length > 0) {
        const lines = overdue.map(e => {
          const hora = new Date(e.date_time).toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit', minute: '2-digit',
            day: '2-digit', month: '2-digit'
          });
          return `• ${e.title} — ${hora}`;
        }).join('\n');
        const msg = `⚠️ *Eventos vencidos sin recordatorio*\n\n${lines}\n\n_Marcalos como completados o cancelados cuando puedas._`;
        await sendpulse.sendMessage(AGENDA_PHONE, msg);
        // Marcarlos para no volver a avisarlos
        for (const event of overdue) markReminderSent(event.id);
        logger.info(`Cron: ${overdue.length} eventos vencidos avisados a Ricardo`);
      }

      // ── 3. Acciones pendientes de los últimos 15 min (respaldo) ──────────
      // Si el bot generó una acción pendiente y la notificación inmediata falló,
      // el cron la reenvía para que Ricardo no se pierda ningún lead.
      if (recentActions.length > 0 && RICARDO_PHONE) {
        const actionLines = recentActions.map(a => {
          const name = a.contact_name || a.contact_phone;
          const waLink = `https://wa.me/${a.contact_phone}`;
          return `• ${name} — ${a.description || a.action_type} → ${waLink}`;
        }).join('\n');

        const msg = `🔔 *Resumen últimos 15 min — SolarPower Bot*\n\nHay ${recentActions.length} acción(es) pendiente(s):\n\n${actionLines}\n\n_Revisá cada chat cuando puedas._`;
        await sendpulse.sendMessage(RICARDO_PHONE, msg);
        logger.info(`Cron: resumen de ${recentActions.length} acciones pendientes enviado a Ricardo`);
      }

    } catch (error) {
      logger.error(`Error en cron de recordatorios: ${error.message}`);
    }
  });

  // ── Briefing matutino: 8:30 AM hora argentina (UTC-3 = 11:30 UTC) ─────────
  cron.schedule('30 11 * * *', async () => {
    try {
      if (!AGENDA_PHONE) return;

      const now = new Date();
      const argDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const yyyy = argDate.getFullYear();
      const mm = String(argDate.getMonth() + 1).padStart(2, '0');
      const dd = String(argDate.getDate()).padStart(2, '0');
      const today = `${yyyy}-${mm}-${dd}`;

      const events = getAgendaEvents(today);
      const pendingActions = getPendingActions();

      let msg = `☀️ *Buenos días Ricardo!*\n\n`;

      if (events.length === 0) {
        msg += `📅 No tenés eventos agendados para hoy.\n`;
      } else {
        msg += `📅 *Tu agenda de hoy (${events.length} evento${events.length > 1 ? 's' : ''}):*\n\n`;
        for (const e of events) {
          const hora = new Date(e.date_time).toLocaleTimeString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit'
          });
          const tipoEmoji = { visita: '🔧', instalacion: '⚡', reunion: '🤝', llamada: '📞', recordatorio: '🔔', tramite: '📋', otro: '📅' }[e.event_type] || '📅';
          msg += `${tipoEmoji} ${hora} — ${e.title}`;
          if (e.location) msg += ` (${e.location})`;
          if (e.contact_name) msg += `\n   👤 ${e.contact_name}`;
          msg += '\n';
        }
      }

      if (pendingActions.length > 0) {
        msg += `\n🔔 *Tenés ${pendingActions.length} acción${pendingActions.length > 1 ? 'es' : ''} pendiente${pendingActions.length > 1 ? 's' : ''}* de clientes.\n`;
        msg += `_Pedime el resumen cuando quieras._`;
      }

      await sendpulse.sendMessage(AGENDA_PHONE, msg);
      logger.info(`[CRON] Briefing matutino enviado a Ricardo`);
    } catch (error) {
      logger.error(`Error en briefing matutino: ${error.message}`);
    }
  });

  logger.info('Cron de recordatorios de agenda activo (cada 15 min) + briefing matutino (8:30 AR)');
}

// ─── Tunnel automático con cloudflared ────────────────────────────────────────

/**
 * Inicia cloudflared como proceso hijo y extrae la URL pública del tunnel.
 * Cloudflared no requiere cuenta ni tiene página de bypass.
 */
function startCloudflaredTunnel() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    const cfPath = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    const cf = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    // La URL aparece en stderr de cloudflared
    const onData = (data) => {
      const text = data.toString();

      // Buscar la URL trycloudflare.com en el output
      // La URL real tiene al menos un guión en el subdominio (ej: random-words-here.trycloudflare.com)
      // Excluye https://api.trycloudflare.com que aparece en los logs de cloudflared
      const match = text.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        const tunnelUrl = match[0];

        logger.info('');
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('  TUNNEL ACTIVO — Pegá esta URL en SendPulse:');
        logger.info(`  ${tunnelUrl}/webhook/whatsapp`);
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('');

        resolve(tunnelUrl);
      }
    };

    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);

    cf.on('error', (err) => {
      logger.error(`Error al iniciar cloudflared: ${err.message}`);
      if (!resolved) resolve(null);
    });

    // Timeout de 30 segundos por si no aparece la URL
    setTimeout(() => {
      if (!resolved) {
        logger.warn('Cloudflared no retornó URL en 30s. Verificá que esté instalado.');
        resolve(null);
      }
    }, 30000);

    // Cerrar cloudflared cuando el proceso Node termina
    process.on('exit', () => cf.kill());
    process.on('SIGINT', () => { cf.kill(); process.exit(0); });
  });
}

// ─── Arranque del servidor ────────────────────────────────────────────────────

async function startServer() {
  try {
    // Inicializar SendPulse (obtener token y bot_id)
    logger.info('Inicializando SendPulse...');
    await sendpulse.initialize();

    // Arrancar Express
    await new Promise((resolve) => {
      app.listen(PORT, () => {
        logger.info(`SolarPower WhatsApp Agent corriendo en puerto ${PORT}`);
        logger.info(`Health check: http://localhost:${PORT}/health`);
        logger.info(`Dashboard:    http://localhost:${PORT}/dashboard`);
        resolve();
      });
    });

    // Iniciar tunnel cloudflared automáticamente
    const tunnelUrl = await startCloudflaredTunnel();
    if (tunnelUrl) {
      const webhookUrl = `${tunnelUrl}/webhook/whatsapp`;
      require('fs').writeFileSync(require('path').join(__dirname, 'tunnel-url.txt'), webhookUrl, 'utf8');
      logger.info('');
      logger.info('┌─────────────────────────────────────────────────────────────┐');
      logger.info('│  WEBHOOK URL — Copiá esto en SendPulse → Configuración Bot  │');
      logger.info(`│  ${webhookUrl.padEnd(61)}│`);
      logger.info('└─────────────────────────────────────────────────────────────┘');
      logger.info('');
    }

    // Iniciar cron de recordatorios de agenda
    startReminderCron();

  } catch (error) {
    logger.error(`Error al arrancar el servidor: ${error.message}`);
    process.exit(1);
  }
}

startServer();
