/**
 * sendpulse.js
 * Cliente de SendPulse para enviar mensajes de WhatsApp.
 * Maneja autenticación OAuth2 con renovación automática del token.
 */

const axios = require('axios');
const logger = require('./logger');

// URL base de la API de SendPulse
const API_BASE = 'https://api.sendpulse.com';

// Estado interno del módulo
let accessToken = null;
let tokenExpiresAt = null;
let botId = process.env.SENDPULSE_BOT_ID || null;

/**
 * Obtiene un nuevo access token usando credenciales OAuth2.
 * Almacena el token en memoria con su tiempo de expiración.
 */
async function refreshToken() {
  try {
    logger.info('Renovando token de SendPulse...');

    const response = await axios.post(`${API_BASE}/oauth/access_token`, {
      grant_type: 'client_credentials',
      client_id: process.env.SENDPULSE_API_ID,
      client_secret: process.env.SENDPULSE_API_SECRET
    });

    accessToken = response.data.access_token;
    // Restar 60 segundos para renovar antes de que expire
    const expiresIn = (response.data.expires_in || 3600) - 60;
    tokenExpiresAt = Date.now() + expiresIn * 1000;

    logger.info('Token de SendPulse renovado correctamente');
  } catch (error) {
    logger.error(`Error al renovar token de SendPulse: ${error.message}`);
    throw error;
  }
}

/**
 * Retorna un token válido, renovándolo si está vencido o si no existe.
 * @returns {string} Access token
 */
async function getValidToken() {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    await refreshToken();
  }
  return accessToken;
}

/**
 * Retorna los headers de autorización para las peticiones a SendPulse.
 */
async function getAuthHeaders() {
  const token = await getValidToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Normaliza un número de teléfono al formato internacional sin '+'.
 * Ejemplo: +5491134583958 → 5491134583958
 * @param {string|number} phone - Número de teléfono
 * @returns {string} Número normalizado
 */
function normalizePhone(phone) {
  return String(phone).replace(/^\+/, '').trim();
}

/**
 * Obtiene la lista de bots configurados en SendPulse.
 * @returns {Array} Lista de bots
 */
async function getBots() {
  try {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${API_BASE}/whatsapp/bots`, { headers });
    return response.data.data || response.data || [];
  } catch (error) {
    logger.error(`Error al obtener bots de SendPulse: ${error.message}`);
    throw error;
  }
}

/**
 * Inicializa el cliente: obtiene token y guarda el bot_id del primer bot disponible.
 * Llamar esta función al arrancar el servidor.
 */
async function initialize() {
  try {
    // Obtener token inicial
    await refreshToken();

    // Si ya tenemos el bot_id configurado en .env, no necesitamos buscarlo
    if (botId) {
      logger.info(`SendPulse inicializado con bot_id configurado: ${botId}`);
      return;
    }

    // Obtener bot_id automáticamente
    const bots = await getBots();
    if (bots.length === 0) {
      throw new Error('No hay bots configurados en SendPulse');
    }

    botId = bots[0].id;
    logger.info(`SendPulse inicializado | bot_id: ${botId} | bots disponibles: ${bots.length}`);
  } catch (error) {
    logger.error(`Error al inicializar SendPulse: ${error.message}`);
    throw error;
  }
}

/**
 * Envía un mensaje de texto a un número de WhatsApp.
 * @param {string} phone - Número de teléfono (con o sin '+')
 * @param {string} text - Texto del mensaje
 * @returns {Object} Respuesta de la API
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSendErrorBody(error) {
  return JSON.stringify(error.response?.data || {});
}

function isWindowExpiredError(status, bodyText) {
  if (status !== 400) return false;
  return /24h|24 horas|24-hour|window|ventana|outside.*session|session.*expired|recipient.*not.*available/i.test(bodyText);
}

function isRetryableSendError(status, bodyText) {
  if (!status) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 400) {
    return /internal error|temporar|unavailable|try again|timeout|facebook api request internal error|\(1\)/i.test(bodyText);
  }
  return false;
}

async function sendMessage(phone, text, attempt = 0) {
  const normalizedPhone = normalizePhone(phone);

  try {
    if (!botId) {
      throw new Error('bot_id no inicializado. Llamar a initialize() primero.');
    }

    const headers = await getAuthHeaders();

    const payload = {
      phone: normalizedPhone,
      bot_id: botId,
      message: {
        type: 'text',
        text: {
          body: text
        }
      }
    };

    const response = await axios.post(
      `${API_BASE}/whatsapp/contacts/sendByPhone`,
      payload,
      { headers }
    );

    logger.info(`Mensaje enviado a ${normalizedPhone}: "${text.substring(0, 60)}..."`);
    return response.data;

  } catch (error) {
    const status = error.response?.status;
    const bodyText = getSendErrorBody(error);

    // Si es error 401, el token venció y hay que renovarlo
    if (status === 401 && attempt < 2) {
      logger.warn('Token expirado, renovando y reintentando...');
      await refreshToken();
      return sendMessage(phone, text, attempt + 1); // Reintentar una vez
    }

    if (isRetryableSendError(status, bodyText) && attempt < 2) {
      const delay = 1500 * (attempt + 1);
      logger.warn(`[SENDPULSE RETRY] Error enviando a ${normalizedPhone} status=${status || 'sin status'} body=${bodyText}. Reintento ${attempt + 1}/2 en ${delay}ms`);
      await wait(delay);
      return sendMessage(phone, text, attempt + 1);
    }

    // Error 400 = ventana de 24h de WhatsApp expirada — el contacto no inició conversación reciente
    if (isWindowExpiredError(status, bodyText)) {
      const err400 = new Error(`Ventana 24h WhatsApp expirada para ${normalizedPhone} — no se puede enviar sin mensaje previo del usuario`);
      err400.status = 400;
      err400.isWindowExpired = true;
      logger.warn(`[24H] Ventana expirada para ${normalizedPhone}: ${bodyText}`);
      throw err400;
    }

    if (status) error.status = status;
    logger.error(`Error al enviar mensaje a ${normalizedPhone}: ${error.message} | status=${status || 'sin status'} | body=${bodyText}`);
    throw error;
  }
}

/**
 * Obtiene las tags actuales de un contacto consultando la API de SendPulse.
 * @param {string} contactId - ID del contacto (viene en payload.contact.id)
 * @returns {Array} Lista de tags (strings), vacío si no tiene o hay error
 */
async function getContactTags(contactId) {
  if (!contactId) return [];
  try {
    const headers = await getAuthHeaders();
    const response = await axios.get(`${API_BASE}/chatbots/contacts/${contactId}`, { headers });
    const tags = response.data?.data?.tags || response.data?.tags || [];
    return Array.isArray(tags) ? tags : [];
  } catch (error) {
    // Si falla la consulta, no bloqueamos el flujo — dejamos pasar el mensaje
    logger.warn(`No se pudieron obtener tags del contacto ${contactId}: ${error.message}`);
    return [];
  }
}

/**
 * Divide un texto en fragmentos respetando párrafos y oraciones.
 * No corta en medio de una oración.
 * @param {string} text - Texto a dividir
 * @param {number} maxChars - Máximo de caracteres por fragmento
 * @returns {string[]} Array de fragmentos
 */
function splitIntoChunks(text, maxChars) {
  // Si el texto ya entra, no hace falta dividir
  if (text.length <= maxChars) return [text];

  // Dividir primero por párrafos (doble salto de línea)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? current + '\n\n' + paragraph : paragraph;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      // Si hay acumulado, guardarlo
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }

      // Si el párrafo solo ya es demasiado largo, dividirlo por oraciones
      if (paragraph.length > maxChars) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(s => s.trim());
        for (const sentence of sentences) {
          const sc = current ? current + ' ' + sentence : sentence;
          if (sc.length <= maxChars) {
            current = sc;
          } else {
            if (current.trim()) chunks.push(current.trim());
            // Si la oración sola supera el límite, la mandamos igual (no cortamos palabras)
            current = sentence;
          }
        }
      } else {
        current = paragraph;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Envía un mensaje largo dividiéndolo en partes si supera 300 caracteres.
 * Envía cada parte con 1.5 segundos de delay para que parezca más natural.
 * @param {string} phone - Número de teléfono
 * @param {string} text - Texto completo a enviar
 */
async function sendLongMessage(phone, text) {
  const MAX_CHARS = 300;

  const parts = splitIntoChunks(text, MAX_CHARS);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // Pausa natural entre mensajes
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    await sendMessage(phone, parts[i]);
  }
}

module.exports = {
  sendMessage,
  sendLongMessage,
  getBots,
  initialize,
  normalizePhone,
  getContactTags,
  getValidToken,      // Para descargar medios autenticados (facturas)
};
