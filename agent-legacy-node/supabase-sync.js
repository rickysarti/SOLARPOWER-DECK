/**
 * supabase-sync.js
 * Sincronización asíncrona (fire-and-forget) de datos a Supabase.
 *
 * Todas las funciones son no bloqueantes — si Supabase falla, el bot
 * sigue funcionando normalmente con SQLite como fuente principal.
 *
 * Tablas usadas:
 *   chatbot_wa_contacts     — contactos de WhatsApp
 *   chatbot_conversations   — conversaciones (canal whatsapp)
 *   chatbot_messages        — mensajes de cada conversación
 *   chatbot_agenda_events   — eventos de la agenda de Ricardo
 *   chatbot_pending_actions — acciones pendientes para Ricardo
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

// ─── Inicialización ───────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    const url  = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

function isEnabled() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Cache de conversation IDs por teléfono (evita queries repetidas)
const convCache = new Map(); // phone → UUID

// ─── Helper fire-and-forget ───────────────────────────────────────────────────

function fire(label, fn) {
  let sb;
  try {
    sb = getClient();
  } catch (err) {
    // createClient() puede lanzar síncronamente en algunas versiones del SDK
    logger.warn(`[SUPABASE] Error inicializando cliente en "${label}": ${err.message}`);
    return;
  }
  if (!sb) return; // Supabase no configurado → ignorar
  Promise.resolve()
    .then(fn)
    .catch(err => logger.warn(`[SUPABASE] ${label}: ${err.message}`));
}

// ─── Conversaciones ───────────────────────────────────────────────────────────

async function getOrCreateConvId(phone, name) {
  if (convCache.has(phone)) return convCache.get(phone);

  const sb = getClient();

  // Buscar conversación activa existente para este teléfono
  const { data: existing } = await sb
    .from('chatbot_conversations')
    .select('id')
    .eq('channel', 'whatsapp')
    .eq('status', 'active')
    .eq('metadata->>phone', phone)
    .maybeSingle();

  if (existing?.id) {
    convCache.set(phone, existing.id);
    return existing.id;
  }

  // Crear conversación nueva
  const { data, error } = await sb
    .from('chatbot_conversations')
    .insert({
      channel: 'whatsapp',
      status: 'active',
      title: name ? `${name} (${phone})` : phone,
      context: { lang: 'es', timezone: 'America/Argentina/Buenos_Aires' },
      metadata: { phone, name: name || null }
    })
    .select('id')
    .single();

  if (error) throw new Error(`crear conversación: ${error.message}`);

  convCache.set(phone, data.id);
  logger.debug(`[SUPABASE] Conversación creada para ${phone}: ${data.id}`);
  return data.id;
}

// ─── API pública (fire-and-forget) ────────────────────────────────────────────

/**
 * Sincroniza / actualiza un contacto de WhatsApp en Supabase.
 * @param {Object} contact - Objeto contacto de la DB local
 */
function syncContact(contact) {
  fire(`syncContact ${contact.phone}`, async () => {
    const sb = getClient();
    const { error } = await sb
      .from('chatbot_wa_contacts')
      .upsert({
        phone:            contact.phone,
        name:             contact.name           || null,
        email:            contact.email          || null,
        tipo:             contact.tipo           || null,
        label:            contact.label          || 'Interesado',
        stage:            contact.stage          || 'nuevo',
        bill_received:    !!contact.bill_received,
        roof_type:        contact.roof_type      || null,
        connection_type:  contact.connection_type|| null,
        locality:         contact.locality       || null,
        product_interest: contact.product_interest || null,
        human_mode:       !!contact.human_mode,
        notified_ricardo: !!contact.notified_ricardo,
        notes:            contact.notes          || null,
        first_contact:    contact.first_contact  || new Date().toISOString(),
        last_contact:     contact.last_contact   || new Date().toISOString(),
        updated_at:       new Date().toISOString()
      }, { onConflict: 'phone' });

    if (error) throw new Error(error.message);
  });
}

/**
 * Guarda un mensaje en chatbot_messages (crea la conversación si no existe).
 * @param {string} phone - Teléfono del contacto
 * @param {string|null} name - Nombre del contacto
 * @param {string} role - 'user' | 'assistant'
 * @param {string} content - Contenido del mensaje
 * @param {string} [model] - Modelo usado (solo para assistant)
 */
function logMessage(phone, name, role, content, model) {
  fire(`logMessage ${phone}`, async () => {
    const sb = getClient();
    const convId = await getOrCreateConvId(phone, name);

    const { error } = await sb
      .from('chatbot_messages')
      .insert({
        conversation_id: convId,
        role,
        content,
        model: model || (role === 'assistant' ? 'claude-haiku-4-5-20251001' : null)
      });

    if (error) throw new Error(error.message);
  });
}

/**
 * Sincroniza un evento de agenda en Supabase.
 * @param {Object} event - Evento de la DB local (con sqlite_id)
 */
function syncAgendaEvent(event) {
  fire(`syncAgendaEvent ${event.id}`, async () => {
    const sb = getClient();
    const { error } = await sb
      .from('chatbot_agenda_events')
      .upsert({
        sqlite_id:        event.id,
        google_event_id:  event.google_event_id || null,
        title:            event.title,
        description:      event.description     || null,
        date_time:        event.date_time,
        duration_minutes: event.duration_minutes || 60,
        location:         event.location        || null,
        event_type:       event.event_type      || 'reunion',
        contact_name:     event.contact_name    || null,
        contact_phone:    event.contact_phone   || null,
        status:           event.status          || 'pendiente',
        reminder_sent:    !!event.reminder_sent,
        updated_at:       new Date().toISOString()
      }, { onConflict: 'sqlite_id' });

    if (error) throw new Error(error.message);
  });
}

/**
 * Guarda una acción pendiente en Supabase.
 * @param {string} phone - Teléfono del contacto
 * @param {string|null} name - Nombre del contacto
 * @param {string} type - Tipo de acción
 * @param {string} description - Descripción
 */
function syncPendingAction(phone, name, type, description) {
  fire(`syncPendingAction ${phone}`, async () => {
    const sb = getClient();
    const { error } = await sb
      .from('chatbot_pending_actions')
      .insert({
        contact_phone: phone,
        contact_name:  name || null,
        action_type:   type,
        description:   description || null
      });

    if (error) throw new Error(error.message);
  });
}

function cleanName(value) {
  return String(value || 'archivo').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function normalizeEnergyUpdate(analyzerResponse) {
  const analysis = analyzerResponse?.analysis || analyzerResponse || {};
  const consumption = analysis.consumption || analyzerResponse?.consumption || {};
  const prospect = analysis.prospect || analyzerResponse?.prospect || {};
  const average = Number(consumption.promedioMensual || 0) || null;
  const annual = Number(consumption.totalAnual || 0) || null;
  const notes = [
    consumption.confidenceLevel ? `Confianza: ${consumption.confidenceLevel}` : null,
    consumption.confidenceNotes || null,
    analysis.additionalNotes || null,
  ].filter(Boolean).join('\n\n');

  return {
    consumo_mensual: average ? Math.round(average) : null,
    consumo_anual: annual ? Math.round(annual) : null,
    kwh_estimados: average ? Math.round(average) : null,
    tipo_conexion: prospect.conexionElectrica || null,
    energy_analysis_json: analysis,
    energy_months: consumption.months || [],
    energy_analysis_notes: notes || null,
    energy_analysis_source: 'SOLARPOWER ANALISIS ENERGETICO',
    energy_analysis_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function syncEnergyAnalysis(phone, analyzerResponse) {
  fire(`syncEnergyAnalysis ${phone}`, async () => {
    const sb = getClient();
    const { error } = await sb
      .from('chatbot_wa_contacts')
      .update(normalizeEnergyUpdate(analyzerResponse))
      .eq('phone', phone);

    if (error) throw new Error(error.message);
  });
}

function syncLeadFileBuffer(phone, file, buffer) {
  fire(`syncLeadFileBuffer ${phone}`, async () => {
    const sb = getClient();
    const bucket = process.env.CRM_FILES_BUCKET || 'crm-lead-files';
    const filename = cleanName(file.filename || file.originalname || `factura_${Date.now()}`);
    const path = `wa/${cleanName(phone)}/${Date.now()}-${filename}`;

    const { error: uploadError } = await sb.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: file.mimeType || file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (uploadError) throw new Error(uploadError.message);

    const { data: publicData } = sb.storage.from(bucket).getPublicUrl(path);
    const mimeType = file.mimeType || file.mimetype || null;
    const kind = mimeType && mimeType.startsWith('image/') ? 'image' : 'invoice';

    const { error } = await sb
      .from('crm_lead_files')
      .insert({
        source: 'wa',
        contact_phone: phone,
        file_url: publicData.publicUrl,
        file_name: file.filename || file.originalname || filename,
        mime_type: mimeType,
        file_size: buffer.length,
        kind,
        source_channel: 'whatsapp',
        storage_bucket: bucket,
        storage_path: path,
        metadata: { original_sendpulse_url: file.url || null }
      });

    if (error) throw new Error(error.message);
  });
}

/**
 * Consulta Supabase para saber si un contacto tiene human_mode activo.
 * Esta es la FUENTE AUTORITATIVA — el frontend escribe aquí cuando pausa el bot.
 *
 * @param {string} phone - Teléfono del contacto (tal como se almacena en chatbot_wa_contacts)
 * @returns {Promise<boolean|null>} true=pausado, false=activo, null=Supabase no disponible/error
 */
async function getHumanModeFromSupabase(phone) {
  const sb = getClient();
  if (!sb) return null; // Supabase no configurado

  try {
    // Timeout de 3 segundos para no bloquear el bot si Supabase es lento
    const queryPromise = sb
      .from('chatbot_wa_contacts')
      .select('human_mode')
      .eq('phone', phone)
      .maybeSingle();

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 3000)
    );

    const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

    if (error) {
      logger.warn(`[SUPABASE] Error leyendo human_mode para ${phone}: ${error.message}`);
      return null;
    }

    // Contacto no existe en Supabase todavía → desconocido, usar fallback SQLite
    if (!data) return null;

    return data.human_mode === true;

  } catch (err) {
    logger.warn(`[SUPABASE] Excepción leyendo human_mode para ${phone}: ${err.message}`);
    return null;
  }
}

module.exports = {
  isEnabled,
  syncContact,
  logMessage,
  syncAgendaEvent,
  syncPendingAction,
  syncEnergyAnalysis,
  syncLeadFileBuffer,
  getHumanModeFromSupabase
};
