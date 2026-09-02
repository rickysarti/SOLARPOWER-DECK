/**
 * notifier.js
 * Sistema de notificaciones a Ricardo via WhatsApp.
 * Envía alertas cuando se requiere acción humana.
 * Las notificaciones se analizan con Claude Haiku para generar mensajes precisos y personalizados.
 */

const Anthropic = require('@anthropic-ai/sdk');
const sendpulse = require('./sendpulse');
const { addPendingAction, getHistory, addPendingNotification } = require('./database');
const logger = require('./logger');

const RICARDO_PHONE = process.env.RICARDO_PHONE;

// Cliente de Anthropic para analizar conversaciones antes de notificar
const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Llama a Claude Haiku para analizar la conversación y generar un mensaje
 * de notificación preciso y personalizado para Ricardo.
 *
 * @param {Object} contact - Datos del contacto
 * @param {Array} history - Historial de mensajes
 * @returns {string|null} Mensaje analizado o null si falla
 */
async function analyzeConversationForRicardo(contact, history) {
  const historialTexto = history.length > 0
    ? history
        .map(m => {
          const who = m.role === 'user' ? 'Cliente' : 'Tomás';
          const clean = m.content.replace(/##[A-Z_:#a-z\s]+##/g, '').trim();
          return `${who}: ${clean}`;
        })
        .join('\n')
    : '(sin historial)';

  const prompt = `Sos un asistente de SolarPower Argentina. Analizá esta conversación de WhatsApp y generá un mensaje de notificación breve para Ricardo (el dueño) con los datos más importantes.

Formato exacto del mensaje (completá cada campo con la info real de la conversación):
🔔 [TIPO: PRESUPUESTO / CONSULTA COMERCIAL / INDUSTRIA / SOPORTE / ACADEMIA / PROVEEDOR / OTRO]
👤 [Nombre del cliente o "Sin nombre"]
📍 [Localidad o "No mencionó"]
📋 [2-3 líneas resumiendo qué quiere el cliente, sé específico]
🏠 [Residencial / Comercial / Industrial / No definido]
⚡ [On-Grid / On-Grid+Batería / Off-Grid / No definido]
📞 [PHONE]

Conversación:
${historialTexto}

Respondé SOLO con el mensaje formateado, sin texto adicional ni explicaciones.`;

  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const rawText = response.content[0]?.text?.trim() || null;
  // Reemplazar el placeholder con el número real sin pasar por Claude
  return rawText ? rawText.replace('[PHONE]', contact.phone) : null;
}

/**
 * Función base para notificar a Ricardo.
 * Usa Claude Haiku para analizar la conversación y generar un mensaje preciso.
 * Registra la acción en la DB y envía mensaje de WhatsApp.
 *
 * @param {Object} contact - Objeto contacto de la base de datos
 * @param {string} reason - Motivo de la notificación (fallback si Claude falla)
 * @param {string} details - Detalles adicionales (opcional)
 * @param {string} actionType - Tipo de acción para la DB
 */
async function notifyRicardo(contact, reason, details = '', actionType = 'call') {
  if (!RICARDO_PHONE) {
    logger.warn('RICARDO_PHONE no configurado, omitiendo notificación');
    return;
  }

  // Obtener historial completo para el análisis de Claude
  const history = getHistory(contact.phone, 30);

  // Intentar generar mensaje analizado con Claude Haiku
  let mainBody = null;
  try {
    mainBody = await analyzeConversationForRicardo(contact, history);
    logger.info(`[notifier] Mensaje analizado por Claude Haiku para ${contact.phone}`);
  } catch (analysisError) {
    logger.warn(`[notifier] Error en análisis Claude: ${analysisError.message} — usando formato básico`);
  }

  // Fallback al formato básico si Claude falla
  if (!mainBody) {
    const transcript = history.length > 0
      ? history
          .map(m => {
            const who = m.role === 'user' ? `👤 ${contact.name || 'Cliente'}` : '🤖 Tomás';
            const clean = m.content.replace(/##[A-Z_:#a-z\s]+##/g, '').trim();
            const truncated = clean.length > 180 ? clean.substring(0, 180) + '...' : clean;
            return `${who}: "${truncated}"`;
          })
          .join('\n')
      : '(sin historial previo)';

    const hasTechnicalData = contact.bill_received || contact.roof_type || contact.connection_type || contact.locality;
    const dataLine = hasTechnicalData
      ? `\n📋 ${contact.bill_received ? '✅ Factura recibida' : '❌ Sin factura'} · Techo: ${contact.roof_type || '—'} · Conexión: ${contact.connection_type || '—'} · Localidad: ${contact.locality || '—'}\n`
      : '\n';

    const waLink = `https://wa.me/${contact.phone}`;
    mainBody = `🔔 *${reason}*\n\n👤 *${contact.name || 'Sin nombre'}* — ${waLink}${details ? `\n\n${details}` : ''}\n\n💬 *Lo que se habló:*\n${transcript}${dataLine}`;
  }

  // Agregar comandos de control siempre al final
  const message = `${mainBody}

_Tomar chat: *tomar ${contact.phone}*_
_Liberar: *liberar ${contact.phone}*_`;

  try {
    await sendpulse.sendMessage(RICARDO_PHONE, message);
    await addPendingAction(contact.phone, actionType, reason);

    logger.info(`Ricardo notificado por: ${reason} (contacto: ${contact.phone})`);
  } catch (error) {
    const status = error.response?.status || error.status;
    const errBody = JSON.stringify(error.response?.data || {});
    logger.error(`Error al notificar a Ricardo: ${error.message} | status=${status} | body=${errBody}`);

    // Si es 400 (ventana 24h expirada), encolar para enviar cuando Ricardo vuelva a escribir
    if (status === 400 || error.isWindowExpired) {
      addPendingNotification(RICARDO_PHONE, message);
      logger.warn(`⚠️ Ventana WhatsApp expirada — notificación encolada: "${reason}". Se enviará cuando Ricardo escriba.`);
    }
  }
}

/**
 * Notifica a Ricardo cuando se recolectaron todos los datos para el presupuesto.
 */
async function notifyDataComplete(contact) {
  await notifyRicardo(
    contact,
    'Datos completos — listo para presupuesto ✅',
    '',
    'send_budget'
  );
}

/**
 * Notifica a Ricardo sobre un caso urgente.
 */
async function notifyUrgent(contact, message) {
  await notifyRicardo(contact, `⚠️ URGENTE: ${message}`, '', 'call');
}

/**
 * Notifica a Ricardo sobre un proveedor o potencial vendedor.
 */
async function notifyProviderOrSeller(contact) {
  await notifyRicardo(
    contact,
    'Proveedor / Vendedor potencial interesado',
    'Quiere sumarse como vendedor, proveedor o distribuidor de SolarPower.',
    'call'
  );
}

/**
 * Notifica a Ricardo sobre un cliente con problema técnico.
 */
async function notifySupport(contact, issue) {
  await notifyRicardo(contact, 'Soporte técnico — cliente instalado', issue, 'support');
}

/**
 * Notifica a Ricardo sobre una consulta comercial grande.
 */
async function notifyCommercial(contact, details) {
  await notifyRicardo(
    contact,
    'Consulta comercial grande (empresa / industria)',
    details,
    'call'
  );
}

module.exports = {
  notifyRicardo,
  notifyDataComplete,
  notifyUrgent,
  notifyProviderOrSeller,
  notifySupport,
  notifyCommercial
};
