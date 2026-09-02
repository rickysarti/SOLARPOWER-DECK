/**
 * claude.js
 * Cliente de Claude AI (modelo haiku).
 * Maneja historial de conversación, detecta marcadores especiales y hace retry en errores.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getHistory } = require('./database');
const { getSystemPrompt } = require('./prompts/system');
const logger = require('./logger');

// Inicializar cliente de Anthropic
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Modelo a usar (el más barato)
const MODEL = 'claude-haiku-4-5-20251001';

// Cantidad máxima de tokens en la respuesta
const MAX_TOKENS = 1024;

// Reintentos en caso de error
const MAX_RETRIES = 2;

// Prompt del clasificador (cargado una vez)
let _classifierPrompt = null;
function getClassifierPrompt() {
  if (!_classifierPrompt) {
    _classifierPrompt = fs.readFileSync(
      path.join(__dirname, 'prompts', 'classifier.md'),
      'utf8'
    );
  }
  return _classifierPrompt;
}

/**
 * Limpia los marcadores especiales del texto antes de enviarlo al cliente.
 * @param {string} text - Texto con posibles marcadores
 * @returns {string} Texto limpio
 */
function cleanMarkers(text) {
  return text
    .replace(/##NOTIFICAR_RICARDO##/g, '')
    .replace(/##ETIQUETAR:[^#]+##/g, '')
    .replace(/##DERIVAR_HUMANO##/g, '')
    .replace(/##RECLASIFICAR:[^#]+##/g, '')
    // Eliminar bloques internos que Claude a veces genera por error
    .replace(/\n?-{2,}\n?\*{0,2}Resumen para el equipo\*{0,2}[\s\S]*/i, '')
    .trim();
}

/**
 * Detecta si la respuesta contiene un marcador de reclasificación y retorna el tipo.
 * @param {string} text
 * @returns {string|null} tipo nuevo ('residencial'|'comercial'|'academia'|'cv') o null
 */
function detectReclasificarMarker(text) {
  const match = text.match(/##RECLASIFICAR:([^#]+)##/i);
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * Detecta si la respuesta contiene el marcador de notificación a Ricardo.
 * @param {string} text
 * @returns {boolean}
 */
function detectNotifyMarker(text) {
  return text.includes('##NOTIFICAR_RICARDO##');
}

/**
 * Detecta si la respuesta contiene un marcador de etiqueta y retorna el valor.
 * @param {string} text
 * @returns {string|null}
 */
function detectLabelMarker(text) {
  const match = text.match(/##ETIQUETAR:([^#]+)##/);
  return match ? match[1].trim() : null;
}

/**
 * Detecta si la respuesta contiene el marcador de derivación a humano.
 * @param {string} text
 * @returns {boolean}
 */
function detectDerivarMarker(text) {
  return text.includes('##DERIVAR_HUMANO##');
}

/**
 * Clasifica el tipo de contacto usando Claude con el prompt del clasificador.
 * Se llama una sola vez por contacto (cuando tipo === null).
 *
 * @param {string} text - Primer mensaje del usuario
 * @returns {Promise<string>} tipo: 'residencial' | 'comercial' | 'academia' | 'cv' | 'otro'
 */
async function classifyContactWithClaude(text) {
  const VALID_TIPOS = ['residencial', 'comercial', 'academia', 'cv', 'otro'];

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 10,
      system: getClassifierPrompt(),
      messages: [{ role: 'user', content: text }]
    });

    const tipo = response.content[0]?.text?.trim().toLowerCase();

    if (VALID_TIPOS.includes(tipo)) {
      return tipo;
    }

    logger.warn(`[CLASSIFIER] Tipo inválido recibido: "${tipo}" — usando residencial por defecto`);
    return 'residencial';

  } catch (error) {
    logger.error(`[CLASSIFIER] Error en clasificación: ${error.message}`);
    return 'residencial'; // Fallback seguro
  }
}

/**
 * Llama a Claude con el historial y el system prompt especializado.
 * Implementa retry automático en caso de error transitorio.
 *
 * @param {string} phone - Teléfono del contacto (para cargar historial)
 * @param {string} userMessage - Mensaje actual del usuario
 * @param {Object} contact - Objeto contacto de la base de datos
 * @returns {Object} { text, shouldNotify, newLabel, shouldDerivar, rawResponse }
 */
async function askClaude(phone, userMessage, contact) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.warn(`Reintento ${attempt}/${MAX_RETRIES} para ${phone}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }

      // Cargar historial de la DB
      const history = getHistory(phone, 40);

      // Agregar el mensaje actual del usuario al historial
      const messages = [
        ...history,
        { role: 'user', content: userMessage }
      ];

      // Llamar a la API de Claude
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: getSystemPrompt(contact),
        messages
      });

      // Extraer el texto de la respuesta
      const rawResponse = response.content[0]?.text || '';

      if (!rawResponse) {
        throw new Error('Respuesta vacía de Claude');
      }

      // Detectar marcadores antes de limpiarlos
      const shouldNotify     = detectNotifyMarker(rawResponse);
      const newLabel         = detectLabelMarker(rawResponse);
      const shouldDerivar    = detectDerivarMarker(rawResponse);
      const reclasificarTipo = detectReclasificarMarker(rawResponse);

      // Limpiar marcadores del texto que irá al cliente
      const text = cleanMarkers(rawResponse);

      logger.info(`Claude respondió para ${phone} | notify: ${shouldNotify} | label: ${newLabel || 'ninguna'} | derivar: ${shouldDerivar} | reclasificar: ${reclasificarTipo || 'no'}`);

      return { text, shouldNotify, newLabel, shouldDerivar, reclasificarTipo, rawResponse };

    } catch (error) {
      lastError = error;
      logger.error(`Error en askClaude (intento ${attempt + 1}): ${error.message}`);

      if (error.status === 401 || error.status === 403) {
        break;
      }
    }
  }

  throw lastError;
}

async function generateConversationImprovement(phone, contact, finalResponse = '', reason = '') {
  const history = getHistory(phone, 60);
  const lastMessage = history[history.length - 1];
  const shouldAppendFinal = finalResponse && !(lastMessage?.role === 'assistant' && lastMessage.content === finalResponse);
  const transcript = [
    ...history.map(msg => `${msg.role === 'user' ? 'Cliente' : 'Tomas'}: ${msg.content}`),
    shouldAppendFinal ? `Tomas: ${finalResponse}` : null
  ].filter(Boolean).join('\n');

  const prompt = `Analiza esta conversacion de WhatsApp de SolarPower y escribi UN solo parrafo breve para un log interno.

Objetivo del parrafo: detectar cosas concretas para mejorar en ese chat: datos que faltaron pedir, momentos confusos, oportunidades de mejor seguimiento, tono, velocidad de derivacion o informacion que convendria aclarar mejor.

No le hables al cliente. No propongas tareas operativas. No uses bullets. Maximo 4 oraciones.

Motivo de cierre: ${reason || 'sin especificar'}
Contacto: ${contact?.name || 'Sin nombre'} (${phone})

Conversacion:
${transcript || '(sin historial)'}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 220,
    messages: [{ role: 'user', content: prompt }]
  });

  return (response.content[0]?.text || '').trim();
}

module.exports = { askClaude, classifyContactWithClaude, generateConversationImprovement };
