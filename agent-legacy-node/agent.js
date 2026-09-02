/**
 * agent.js
 * Lógica principal del agente SolarPower.
 * Orquesta el flujo: clasificación → Claude → notificaciones → respuesta.
 */

const { getOrCreateContact, updateContact, saveMessage, getContact, isHumanMode, isBotPaused, getHistory, setHumanMode, addConversationLog, hasRecentConversationLog } = require('./database');
const { askClaude, classifyContactWithClaude, generateConversationImprovement } = require('./claude');
const { notifyRicardo, notifyDataComplete } = require('./notifier');
const { processAgendaMessage } = require('./agenda-agent');
const sendpulse = require('./sendpulse');
const supabaseSync = require('./supabase-sync');
const logger = require('./logger');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// URL del agente de análisis energético
const ENERGY_ANALYZER_URL = process.env.ENERGY_ANALYZER_URL || 'http://localhost:3002/analyze';

// Número al que el bot envía notificaciones (número de notificaciones, no el de agenda)
const RICARDO_PHONE = process.env.RICARDO_PHONE;

// Número personal de Ricardo → ruta al agente de agenda personal
const AGENDA_PHONE = process.env.AGENDA_PHONE;

// Mapa en memoria: phone → [{url, mimeType, filename}]
const contactFiles = new Map();
const GENERAL_LOG_PATH = path.join(__dirname, 'logs', 'general.log');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].trim() : null;
}

function looksLikeFullName(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 5 || clean.length > 80) return false;
  if (/[0-9@?¿!¡:;/\\]/.test(clean)) return false;
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  const blocked = ['hola', 'buenas', 'gracias', 'saludos', 'paneles', 'solar', 'curso', 'precio', 'factura'];
  const normalized = normalizeText(clean);
  if (blocked.some(word => normalized === word || normalized.startsWith(`${word} `))) return false;
  return words.every(word => /^[\p{L}][\p{L}'.-]+$/u.test(word));
}

function botRecentlyAskedForName(history) {
  return history
    .slice(-6)
    .some(msg => msg.role === 'assistant' && /nombre completo|me decis tu nombre|tu nombre|como te llamas/.test(normalizeText(msg.content)));
}

function captureContactDetails(phone, text, contact, historyBeforeUserMessage) {
  const fields = {};
  const email = extractEmail(text);
  if (email && !contact.email) {
    fields.email = email;
    contact.email = email;
  }

  if (!contact.name && botRecentlyAskedForName(historyBeforeUserMessage) && looksLikeFullName(text)) {
    const cleanName = String(text).trim().replace(/\s+/g, ' ');
    fields.name = cleanName;
    contact.name = cleanName;
  }

  if (Object.keys(fields).length > 0) {
    updateContact(phone, fields);
    const updated = getContact(phone);
    if (updated) supabaseSync.syncContact(updated);
    logger.info(`[CONTACT DATA] ${phone} actualizado: ${Object.keys(fields).join(', ')}`);
  }
}

function getClosureReason(claudeResult) {
  if (claudeResult.shouldDerivar) return { eventType: 'derivacion_humano', label: claudeResult.newLabel || null };
  if (claudeResult.shouldNotify) return { eventType: 'cierre_con_datos', label: claudeResult.newLabel || null };
  const label = claudeResult.newLabel || '';
  if (/no interesado/i.test(label)) return { eventType: 'cierre_no_interesado', label };
  if (/recordar/i.test(label)) return { eventType: 'cierre_seguimiento', label };
  return null;
}

function appendGeneralLogLine(phone, contact, eventType, label, paragraph) {
  try {
    const line = [
      `[${new Date().toISOString()}] ${eventType}${label ? ` | ${label}` : ''}`,
      `Contacto: ${contact?.name || 'Sin nombre'} | ${phone}`,
      paragraph,
      ''
    ].join('\n');
    fs.mkdirSync(path.dirname(GENERAL_LOG_PATH), { recursive: true });
    fs.appendFileSync(GENERAL_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    logger.warn(`[GENERAL LOG] No se pudo escribir archivo: ${error.message}`);
  }
}

function scheduleClosureLog(phone, contact, claudeResult, responseText) {
  const closure = getClosureReason(claudeResult);
  if (!closure) return;
  if (hasRecentConversationLog(phone, closure.eventType, closure.label, 6)) {
    logger.info(`[GENERAL LOG] Cierre duplicado omitido para ${phone}`);
    return;
  }

  const contactSnapshot = getContact(phone) || contact;
  generateConversationImprovement(phone, contactSnapshot, responseText, `${closure.eventType}${closure.label ? ` - ${closure.label}` : ''}`)
    .then(paragraph => {
      if (!paragraph) return;
      addConversationLog(phone, closure.eventType, closure.label, paragraph, { tipo: contactSnapshot?.tipo || null });
      appendGeneralLogLine(phone, contactSnapshot, closure.eventType, closure.label, paragraph);
    })
    .catch(error => logger.warn(`[GENERAL LOG] No se pudo generar mejora para ${phone}: ${error.message}`));
}

/**
 * Procesa un mensaje entrante de WhatsApp y genera una respuesta.
 *
 * @param {string} phone - Teléfono del remitente
 * @param {string} text - Texto del mensaje
 * @param {string|null} contactName - Nombre del contacto (si viene del webhook)
 * @returns {Object} { success, response, category }
 */
async function processMessage(phone, text, contactName = null) {
  const normalizedPhone = sendpulse.normalizePhone(phone);

  // --- RUTA 1: Número personal de Ricardo → Agente de Agenda ---
  if (AGENDA_PHONE && normalizedPhone === sendpulse.normalizePhone(AGENDA_PHONE)) {
    logger.info(`[AGENDA] Mensaje de Ricardo (${phone})`);
    return await processAgendaMessage(phone, text);
  }

  // --- RUTA 2: Número de notificaciones → ignorar para evitar loop ---
  if (RICARDO_PHONE && normalizedPhone === sendpulse.normalizePhone(RICARDO_PHONE)) {
    logger.info(`Mensaje ignorado: es el número de notificaciones (${phone})`);
    return { success: true, response: null, category: 'ignored' };
  }

  // --- RUTA 3: Verificar human_mode en Supabase — FUENTE AUTORITATIVA ---
  // El frontend del CRM escribe human_mode directamente en Supabase.
  // ESTE CHECK DEBE SER EL PRIMERO antes de cualquier otra lógica de respuesta.
  // Si Supabase no está disponible, cae al check local de SQLite (RUTA 5).
  try {
    const supabaseHumanMode = await supabaseSync.getHumanModeFromSupabase(phone);

    if (supabaseHumanMode !== null) {
      // Supabase respondió → sincronizar a SQLite local para consistencia
      const localContact = getContact(phone);
      if (localContact) {
        const localMode = localContact.human_mode === 1;
        if (localMode !== supabaseHumanMode) {
          setHumanMode(phone, supabaseHumanMode);
          logger.info(`[SUPABASE→SQLite] human_mode para ${phone} sincronizado: ${supabaseHumanMode}`);
        }
      }

      if (supabaseHumanMode) {
        logger.info(`[HUMAN MODE SUPABASE] Mensaje de ${phone} ignorado — human_mode=true en Supabase (CRM)`);
        const contact = getOrCreateContact(phone, contactName);
        saveMessage(phone, 'user', text);
        supabaseSync.logMessage(phone, contact.name, 'user', text);
        return { success: true, response: null, category: 'human_mode' };
      }
    } else {
      logger.debug(`[SUPABASE] No disponible para ${phone} — usando fallback SQLite local`);
    }
  } catch (err) {
    logger.warn(`[SUPABASE] Error verificando human_mode para ${phone}: ${err.message} — fallback a SQLite`);
  }

  // --- RUTA 4: Bot pausado globalmente ---
  if (isBotPaused()) {
    logger.info(`[BOT PAUSADO] Mensaje de ${phone} ignorado — bot en pausa global`);
    return { success: true, response: null, category: 'bot_paused' };
  }

  // --- RUTA 5: Fallback — Modo humano activo en SQLite local ---
  // Se activa si Supabase no estaba disponible en RUTA 3,
  // o si el modo humano fue seteado localmente (ej: Ricardo respondió manualmente).
  if (isHumanMode(normalizedPhone)) {
    logger.info(`[HUMAN MODE SQLite] Mensaje de ${phone} — guardando en DB sin responder`);
    const contact = getOrCreateContact(phone, contactName);
    saveMessage(phone, 'user', text);
    supabaseSync.logMessage(phone, contact.name, 'user', text);
    return { success: true, response: null, category: 'human_mode' };
  }

  // --- RUTA 5: Clientes → Bot de ventas SolarPower ---

  // Obtener o crear el contacto en la DB
  const contact = getOrCreateContact(phone, contactName);
  supabaseSync.syncContact(contact);
  const historyBeforeUserMessage = getHistory(phone, 12);

  captureContactDetails(phone, text, contact, historyBeforeUserMessage);

  // Guardar el mensaje del usuario
  saveMessage(phone, 'user', text);
  supabaseSync.logMessage(phone, contact.name, 'user', text);

  // Actualizar last_contact
  updateContact(phone, { last_contact: new Date().toISOString() });

  // --- Clasificar tipo de contacto ---
  // Re-clasifica si no tiene tipo aún o si mensajes previos resultaron en "otro" sin resolver
  if (!contact.tipo || contact.tipo === 'otro') {
    logger.info(`[CLASSIFIER] Clasificando tipo para ${phone}...`);
    try {
      const tipo = await classifyContactWithClaude(text);
      logger.info(`[CLASSIFIER] Tipo detectado para ${phone}: ${tipo}`);

      if (tipo !== 'otro') {
        // Tipo concreto: guardar permanentemente y resetear contador
        updateContact(phone, { tipo, otro_count: 0 });
        contact.tipo = tipo;
        contact.otro_count = 0;
        const updatedForSync = getContact(phone);
        if (updatedForSync) supabaseSync.syncContact(updatedForSync);
      } else {
        // Tipo "otro": no fijar como tipo permanente, solo incrementar contador
        const otroCount = (contact.otro_count || 0) + 1;
        updateContact(phone, { tipo: null, otro_count: otroCount });
        contact.tipo = null;
        contact.otro_count = otroCount;
        logger.info(`[CLASSIFIER] Tipo "otro" — intento ${otroCount}/2 para ${phone}`);
      }
    } catch (err) {
      logger.error(`[CLASSIFIER] Error clasificando ${phone}: ${err.message}`);
      contact.tipo = 'residencial'; // Fallback seguro
    }
  }

  // --- Derivar a humano solo si "otro" persiste después de 2 intentos ---
  // (Primer intento: Claude pregunta qué necesita. Segundo: ya confirmado fuera de alcance)
  if (!contact.tipo && (contact.otro_count || 0) >= 2) {
    logger.info(`[OTRO] Tipo "otro" persistente (${contact.otro_count} intentos) para ${phone} — derivando a humano`);

    setHumanMode(phone, true);

    const clientMsg = 'Entiendo tu consulta, voy a derivarte con un asesor que te va a ayudar enseguida.';
    try {
      await sendpulse.sendLongMessage(phone, clientMsg);
    } catch (sendErr) {
      logger.warn(`[OTRO] No se pudo enviar mensaje al cliente ${phone}: ${sendErr.message}`);
      await notifyRicardo(
        contact,
        'Derivacion no enviada al cliente',
        `El bot intento derivar este chat, pero WhatsApp no permitio enviar el mensaje.\n\nhttps://wa.me/${phone}`,
        'support'
      ).catch(err => logger.error(`[OTRO] Error notificando fallo de envio: ${err.message}`));
      return { success: false, response: null, category: 'send_failed' };
    }
    saveMessage(phone, 'assistant', clientMsg);
    supabaseSync.logMessage(phone, contact.name, 'assistant', clientMsg);

    await notifyRicardo(
      contact,
      '❓ Consulta fuera de alcance del bot',
      `El cliente escribió algo que no pudo manejar el bot.\n\nhttps://wa.me/${phone}`,
      'support'
    );

    scheduleClosureLog(phone, getContact(phone) || contact, { shouldDerivar: true, shouldNotify: false, newLabel: 'Otro' }, clientMsg);
    return { success: true, response: clientMsg, category: 'otro' };
  }

  let responseText;

  try {
    // --- Llamar a Claude con el prompt especializado por tipo ---
    let claudeResult = await askClaude(phone, text, contact);
    responseText = claudeResult.text;

    // --- Detectar y aplicar reclasificación ---
    // Si Claude detecta que el cliente quiere algo de otro área, reclasifica y vuelve a llamar
    if (claudeResult.reclasificarTipo) {
      const newTipo = claudeResult.reclasificarTipo;
      const VALID_TIPOS = ['residencial', 'comercial', 'academia', 'cv'];
      if (VALID_TIPOS.includes(newTipo)) {
        logger.info(`[RECLASIFICAR] ${phone}: tipo "${contact.tipo || 'sin tipo'}" → "${newTipo}"`);
        updateContact(phone, { tipo: newTipo, otro_count: 0 });
        contact.tipo = newTipo;
        contact.otro_count = 0;
        const reclasContact = getContact(phone);
        if (reclasContact) supabaseSync.syncContact(reclasContact);
        // Re-llamar Claude con el nuevo prompt especializado — no enviamos la respuesta anterior
        claudeResult = await askClaude(phone, text, contact);
        responseText = claudeResult.text;
      } else {
        logger.warn(`[RECLASIFICAR] Tipo inválido ignorado: "${newTipo}"`);
      }
    }

    // Enviar primero; guardar y aplicar marcadores solo si WhatsApp confirma el envio.

    if (responseText) {
      try {
        await sendpulse.sendLongMessage(phone, responseText);
        logger.info(`Respuesta enviada a ${phone}`);
      } catch (sendError) {
        if (sendError.isWindowExpired) {
          logger.warn(`[24H] Respuesta generada para ${phone} pero NO enviada. No se guarda como respuesta del bot.`);
          await notifyRicardo(
            getContact(phone) || contact,
            'Respuesta no enviada al cliente',
            `El bot genero una respuesta pero WhatsApp no permitio enviarla.\n\nRespuesta pendiente:\n${responseText}\n\nhttps://wa.me/${phone}`,
            'support'
          ).catch(err => logger.error(`[SEND FAIL] Error notificando a Ricardo: ${err.message}`));
          return { success: false, response: null, category: 'send_failed' };
        } else {
          throw sendError;
        }
      }

      saveMessage(phone, 'assistant', responseText);
      supabaseSync.logMessage(phone, contact.name, 'assistant', responseText);
    }

    await handleMarkers(claudeResult, contact, phone);
    scheduleClosureLog(phone, getContact(phone) || contact, claudeResult, responseText);

    return { success: true, response: responseText, category: contact.tipo || 'general' };

  } catch (error) {
    logger.error(`Error al procesar mensaje de ${phone}: ${error.message}`);
    throw error;
  }
}

/**
 * Procesa los marcadores especiales detectados en la respuesta de Claude.
 * Actualiza etiquetas, dispara notificaciones y maneja derivaciones.
 *
 * @param {Object} claudeResult - Resultado de askClaude()
 * @param {Object} contact - Contacto de la DB
 * @param {string} phone - Teléfono del contacto
 */
async function handleMarkers(claudeResult, contact, phone) {
  const { shouldNotify, newLabel, shouldDerivar } = claudeResult;

  // Actualizar etiqueta si Claude indicó una
  if (newLabel) {
    updateContact(phone, { label: newLabel });
    logger.info(`Etiqueta actualizada para ${phone}: ${newLabel}`);

    if (newLabel.toLowerCase().includes('bateria')) {
      updateContact(phone, { product_interest: 'plan_bateria' });
    } else if (newLabel.toLowerCase().includes('academia')) {
      updateContact(phone, { product_interest: 'academia' });
    } else if (newLabel.toLowerCase().includes('comercial')) {
      updateContact(phone, { product_interest: 'comercial' });
    } else if (newLabel.toLowerCase().includes('proveedor') || newLabel.toLowerCase().includes('vendedor')) {
      updateContact(phone, { product_interest: 'proveedor' });
    }
  }

  // Derivar a humano si Claude lo indicó (##DERIVAR_HUMANO##)
  if (shouldDerivar) {
    logger.info(`[DERIVAR] Claude indicó derivación a humano para ${phone}`);
    setHumanMode(phone, true);
    const updatedContact = getContact(phone);
    await notifyRicardo(
      updatedContact || contact,
      '🔄 Derivación — asesor requerido',
      `El bot indicó que este cliente necesita atención humana.\n\nhttps://wa.me/${phone}`,
      'support'
    ).catch(err => logger.error(`[DERIVAR] Error notificando a Ricardo: ${err.message}`));
  }

  // Notificar a Ricardo si Claude lo indicó (##NOTIFICAR_RICARDO##)
  if (shouldNotify) {
    const updatedContact = getContact(phone);
    if (!updatedContact?.notified_ricardo) {
      const tipo = updatedContact?.tipo || 'residencial';

      await notifyDataComplete(updatedContact || contact);

      updateContact(phone, { notified_ricardo: 1 });
      supabaseSync.syncContact({ ...(updatedContact || contact), notified_ricardo: 1 });
      supabaseSync.syncPendingAction(
        phone,
        updatedContact?.name,
        tipo === 'cv' ? 'call' : 'send_budget',
        tipo === 'cv'      ? 'CV / candidato a revisar' :
        tipo === 'academia' ? 'Inscripción academia — datos recolectados' :
                              'Datos completos — listo para presupuesto'
      );

      // Solo disparar análisis energético para clientes de producto solar (no cv ni academia)
      if (tipo !== 'cv' && tipo !== 'academia') {
        triggerEnergyAnalysis(phone, updatedContact || contact).catch(err =>
          logger.warn(`[energy] Análisis energético no enviado para ${phone}: ${err.message}`)
        );
      }
    } else {
      logger.info(`[NOTIFY] ${phone} ya fue notificado — omitiendo duplicado`);
    }
  }

  // Sincronizar contacto si cambió la etiqueta
  if (newLabel) {
    const updated = getContact(phone);
    if (updated) supabaseSync.syncContact(updated);
  }
}

/**
 * Llama al servicio de análisis energético con la conversación completa del prospecto.
 * Se ejecuta en background (fire & forget) sin bloquear la respuesta al cliente.
 */
async function triggerEnergyAnalysis(phone, contact) {
  logger.info(`[energy] Iniciando análisis energético para ${phone}`);

  const history = getHistory(phone, 100);
  const conversation = history
    .map(msg => `${msg.role === 'user' ? 'Cliente' : 'Agente'}: ${msg.content}`)
    .join('\n');

  if (!conversation.trim()) {
    logger.warn(`[energy] Sin historial para ${phone} — análisis omitido`);
    return;
  }

  const savedFiles = contactFiles.get(phone) || [];
  logger.info(`[energy] Archivos para ${phone}: ${savedFiles.length}`);

  const filesBase64 = [];
  if (savedFiles.length > 0) {
    let spToken = null;
    try {
      spToken = await sendpulse.getValidToken();
    } catch (err) {
      logger.warn(`[energy] No se pudo obtener token SP para descargar medios: ${err.message}`);
    }

    for (const file of savedFiles) {
      try {
        const resp = await axios.get(file.url, {
          headers: spToken ? { Authorization: `Bearer ${spToken}` } : {},
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        filesBase64.push({
          data:     Buffer.from(resp.data).toString('base64'),
          mimeType: file.mimeType,
          filename: file.filename,
        });
        supabaseSync.syncLeadFileBuffer(phone, file, Buffer.from(resp.data));
        logger.info(`[energy] Archivo descargado: ${file.filename} (${resp.data.byteLength} bytes)`);
      } catch (err) {
        logger.warn(`[energy] No se pudo descargar archivo de ${phone}: ${err.message}`);
      }
    }
  }

  const response = await axios.post(
    ENERGY_ANALYZER_URL,
    { conversation, phone, filesBase64 },
    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
  );

  if (response.data?.success) {
    logger.info(`[energy] Análisis completado para ${phone} — email enviado: ${response.data.emailSent}`);
    supabaseSync.syncEnergyAnalysis(phone, response.data);
    contactFiles.delete(phone);
  } else {
    logger.warn(`[energy] Análisis respondió sin éxito para ${phone}:`, response.data);
  }
}

/**
 * Guarda la URL de un archivo (imagen/PDF) recibido por WA para un contacto.
 */
function storeContactFile(phone, { url, mimeType, filename }) {
  if (!url) return;
  const existing = contactFiles.get(phone) || [];
  existing.push({ url, mimeType, filename });
  contactFiles.set(phone, existing);
  logger.info(`[ARCHIVO] URL guardada para ${phone} — ${filename}`);
}

module.exports = { processMessage, storeContactFile };
