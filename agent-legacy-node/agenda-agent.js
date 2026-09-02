/**
 * agenda-agent.js
 * Agente personal de Ricardo. Maneja su agenda via WhatsApp usando Claude con tool use.
 *
 * Flujo:
 * 1. Ricardo manda un mensaje desde su número personal
 * 2. Se carga el historial de conversación de la agenda
 * 3. Se llama a Claude con herramientas de agenda
 * 4. Claude decide qué herramientas usar (add, list, update, cancel)
 * 5. Se ejecutan las herramientas y se retornan resultados a Claude
 * 6. Claude genera la respuesta final y se envía a Ricardo
 */

const Anthropic = require('@anthropic-ai/sdk');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  addAgendaEvent,
  getAgendaEvents,
  getAgendaEventById,
  updateAgendaEvent,
  cancelAgendaEvent,
  saveAgendaMessage,
  getAgendaHistory,
  setHumanMode,
  getContact,
  getOrCreateContact,
  isBotPaused,
  setBotPaused,
  searchContacts,
  getLeadsSummary,
  getContactsActiveToday,
  getRecentConversations,
  getPendingNotifications,
  markNotificationSent,
  getPendingActions,
  getHistory,
} = require('./database');
const { getAgendaSystemPrompt } = require('./prompts/agenda-system');
const sendpulse = require('./sendpulse');
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require('./google-calendar');
const supabaseSync = require('./supabase-sync');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// ─── Definición de herramientas de agenda ────────────────────────────────────

const AGENDA_TOOLS = [
  {
    name: 'add_event',
    description: 'Agrega un nuevo evento a la agenda de Ricardo. Usá esta herramienta cuando Ricardo quiere agendar algo.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Título descriptivo del evento (ej: "Visita técnica - Juan García", "Instalación - Belgrano")'
        },
        date_time: {
          type: 'string',
          description: 'Fecha y hora en formato ISO 8601 con zona argentina (ej: 2026-03-15T14:30:00). IMPORTANTE: calculá la fecha correcta según lo que dice Ricardo.'
        },
        duration_minutes: {
          type: 'number',
          description: 'Duración en minutos. Por defecto 60. Para instalaciones usá 480 (8 horas). Para visitas técnicas 90.'
        },
        description: {
          type: 'string',
          description: 'Notas adicionales, dirección exacta, teléfono del cliente, etc.'
        },
        location: {
          type: 'string',
          description: 'Lugar del evento (barrio, dirección, empresa)'
        },
        event_type: {
          type: 'string',
          enum: ['visita', 'instalacion', 'reunion', 'llamada', 'recordatorio', 'tramite', 'otro'],
          description: 'Tipo de evento'
        },
        contact_name: {
          type: 'string',
          description: 'Nombre de la persona con quien es el evento'
        },
        contact_phone: {
          type: 'string',
          description: 'Teléfono de la persona (si Ricardo lo menciona)'
        },
        attendee_emails: {
          type: 'string',
          description: 'Emails de personas a invitar al evento en Google Calendar, separados por coma (ej: "juan@gmail.com, maria@empresa.com"). Solo si Ricardo menciona explícitamente que quiere invitar a alguien.'
        }
      },
      required: ['title', 'date_time', 'event_type']
    }
  },
  {
    name: 'list_events',
    description: 'Lista los eventos de la agenda en un rango de fechas. Usá esta herramienta cuando Ricardo pregunta qué tiene agendado.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: {
          type: 'string',
          description: 'Fecha de inicio en formato YYYY-MM-DD. Para "hoy" usá la fecha actual de Argentina.'
        },
        date_to: {
          type: 'string',
          description: 'Fecha de fin en formato YYYY-MM-DD (opcional). Si no se especifica, se usa la misma que date_from.'
        }
      },
      required: ['date_from']
    }
  },
  {
    name: 'update_event',
    description: 'Actualiza un evento existente. Usá esta herramienta cuando Ricardo quiere cambiar hora, lugar u otro dato de un evento.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'number',
          description: 'ID del evento a actualizar (se obtiene con list_events)'
        },
        title: { type: 'string', description: 'Nuevo título' },
        date_time: { type: 'string', description: 'Nueva fecha y hora en formato ISO 8601' },
        duration_minutes: { type: 'number', description: 'Nueva duración en minutos' },
        description: { type: 'string', description: 'Nueva descripción o notas' },
        location: { type: 'string', description: 'Nuevo lugar' },
        event_type: {
          type: 'string',
          enum: ['visita', 'instalacion', 'reunion', 'llamada', 'recordatorio', 'tramite', 'otro']
        },
        contact_name: { type: 'string', description: 'Nombre de la persona' },
        contact_phone: { type: 'string', description: 'Teléfono de la persona' },
        status: {
          type: 'string',
          enum: ['pendiente', 'completado', 'cancelado'],
          description: 'Estado del evento'
        }
      },
      required: ['event_id']
    }
  },
  {
    name: 'cancel_event',
    description: 'Cancela un evento de la agenda. Usá esta herramienta cuando Ricardo quiere cancelar algo.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'number',
          description: 'ID del evento a cancelar'
        }
      },
      required: ['event_id']
    }
  },
  {
    name: 'search_contacts',
    description: 'Busca clientes/leads en la base de datos de WhatsApp por nombre o teléfono. Usá esta herramienta cuando Ricardo pregunta por un cliente específico.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre o número de teléfono a buscar (búsqueda parcial)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_leads_summary',
    description: 'Retorna un resumen de todos los leads agrupados por etiqueta/estado. Usá esta herramienta cuando Ricardo pregunta cuántos leads hay, qué leads están pendientes, quiénes escribieron hoy, qué pasó hoy, resumen del día, etc.',
    input_schema: {
      type: 'object',
      properties: {
        include_today: {
          type: 'boolean',
          description: 'Si true, también retorna los contactos que escribieron hoy'
        }
      },
      required: []
    }
  },
  {
    name: 'get_recent_conversations',
    description: 'Retorna las últimas conversaciones que tuvo el bot con clientes de WhatsApp, incluyendo los mensajes recientes de cada una. Usá esto cuando Ricardo pregunta qué conversaciones tuvo el bot, qué dijeron los clientes, qué pasó últimamente, resumen de chats, etc.',
    input_schema: {
      type: 'object',
      properties: {
        contact_limit: {
          type: 'number',
          description: 'Cuántos contactos mostrar (default 8)'
        },
        msgs_per_contact: {
          type: 'number',
          description: 'Cuántos mensajes por contacto mostrar (default 4)'
        }
      },
      required: []
    }
  },
  {
    name: 'read_logs',
    description: 'Lee las últimas líneas del log del bot. Usá esto cuando Ricardo quiere saber qué pasó, si hubo errores, actividad reciente, etc.',
    input_schema: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: 'Cantidad de líneas a leer (default 40)'
        },
        errors_only: {
          type: 'boolean',
          description: 'Si true, muestra solo las líneas de error o warning'
        },
        log_type: {
          type: 'string',
          description: 'Usar "general" para leer logs de cierre/mejoras de chats; default "app"'
        }
      },
      required: []
    }
  },
  {
    name: 'run_script',
    description: 'Ejecuta un script del bot y retorna el resultado. Usá esto cuando Ricardo quiere correr un proceso o verificar algo. Scripts disponibles: "test-calendar" (prueba Google Calendar), "status" (estado del proceso y BD).',
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'Script a ejecutar. Opciones: "test-calendar", "status"'
        }
      },
      required: ['script']
    }
  },
  {
    name: 'reply',
    description: 'Usá esta herramienta SOLO para respuestas que no requieren consultar ningún dato: saludos puros, confirmaciones simples ("agendado ✅"), o cuando ya tenés toda la info necesaria del contexto anterior.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'El mensaje a enviar a Ricardo'
        }
      },
      required: ['message']
    }
  },
  {
    name: 'get_contact_detail',
    description: 'Trae los datos completos de un contacto y los últimos mensajes de su conversación. Usá esto cuando Ricardo quiere saber más sobre un cliente específico.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Teléfono del contacto (solo dígitos)' },
        history_limit: { type: 'number', description: 'Cantidad de mensajes a incluir (default 15)' }
      },
      required: ['phone']
    }
  },
  {
    name: 'get_pending_actions',
    description: 'Lista todas las acciones pendientes (presupuestos a enviar, llamadas, seguimientos). Usá esto cuando Ricardo pregunta qué tiene pendiente.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

// ─── Ejecución de herramientas ────────────────────────────────────────────────

/**
 * Ejecuta la herramienta que Claude solicitó y retorna el resultado.
 * @param {string} toolName - Nombre de la herramienta
 * @param {Object} toolInput - Parámetros de la herramienta
 * @returns {string} Resultado en formato string (JSON o texto)
 */
async function executeTool(toolName, toolInput) {
  logger.info(`Ejecutando herramienta: ${toolName} → ${JSON.stringify(toolInput)}`);

  try {
    switch (toolName) {
      case 'add_event': {
        const event = addAgendaEvent(toolInput);
        // Sincronizar con Google Calendar (no bloquea si falla)
        const googleEventId = await createCalendarEvent(toolInput);
        if (googleEventId) {
          updateAgendaEvent(event.id, { google_event_id: googleEventId });
        }
        // Sincronizar con Supabase
        const finalEvent = { ...event, google_event_id: googleEventId || null };
        supabaseSync.syncAgendaEvent(finalEvent);
        return JSON.stringify({
          success: true,
          event_id: event.id,
          message: `Evento creado con ID ${event.id}${googleEventId ? ' y sincronizado con Google Calendar' : ''}`,
          event
        });
      }

      case 'list_events': {
        const events = getAgendaEvents(toolInput.date_from, toolInput.date_to);
        if (events.length === 0) {
          return JSON.stringify({
            success: true,
            events: [],
            message: 'No hay eventos en ese rango de fechas'
          });
        }
        return JSON.stringify({
          success: true,
          events,
          count: events.length
        });
      }

      case 'update_event': {
        const { event_id, ...fields } = toolInput;
        const existing = getAgendaEventById(event_id);
        if (!existing) {
          return JSON.stringify({ success: false, message: `No existe un evento con ID ${event_id}` });
        }
        updateAgendaEvent(event_id, fields);
        const updated = getAgendaEventById(event_id);
        // Sincronizar con Google Calendar
        if (updated.google_event_id) {
          await updateCalendarEvent(updated.google_event_id, updated);
        }
        // Sincronizar con Supabase
        supabaseSync.syncAgendaEvent(updated);
        return JSON.stringify({ success: true, message: 'Evento actualizado', event: updated });
      }

      case 'cancel_event': {
        const { event_id } = toolInput;
        const existing = getAgendaEventById(event_id);
        if (!existing) {
          return JSON.stringify({ success: false, message: `No existe un evento con ID ${event_id}` });
        }
        cancelAgendaEvent(event_id);
        // Sincronizar cancelación con Supabase
        supabaseSync.syncAgendaEvent({ ...existing, status: 'cancelado' });
        // Eliminar de Google Calendar
        if (existing.google_event_id) {
          await deleteCalendarEvent(existing.google_event_id);
        }
        return JSON.stringify({ success: true, message: `Evento "${existing.title}" cancelado` });
      }

      case 'search_contacts': {
        const results = searchContacts(toolInput.query, 8);
        if (results.length === 0) {
          return JSON.stringify({ success: true, contacts: [], message: `No se encontraron contactos para "${toolInput.query}"` });
        }
        return JSON.stringify({ success: true, contacts: results, count: results.length });
      }

      case 'get_leads_summary': {
        const summary = getLeadsSummary();
        const result = { success: true, ...summary };
        if (toolInput.include_today) {
          result.activeToday = getContactsActiveToday();
        }
        return JSON.stringify(result);
      }

      case 'get_recent_conversations': {
        const convos = getRecentConversations(
          toolInput.contact_limit || 8,
          toolInput.msgs_per_contact || 4
        );
        return JSON.stringify({ success: true, conversations: convos, count: convos.length });
      }

      case 'read_logs': {
        const logFile = path.join(__dirname, 'logs', toolInput.log_type === 'general' ? 'general.log' : 'app.log');
        if (!fs.existsSync(logFile)) {
          return JSON.stringify({ success: false, message: 'No se encontró el archivo de logs' });
        }
        const content = fs.readFileSync(logFile, 'utf8');
        let lines = content.split('\n').filter(Boolean);

        if (toolInput.errors_only) {
          lines = lines.filter(l => l.includes(' ERROR:') || l.includes(' WARN:'));
        }

        const limit = toolInput.lines || 40;
        const recent = lines.slice(-limit);
        return JSON.stringify({ success: true, lines: recent, total_shown: recent.length });
      }

      case 'run_script': {
        const SCRIPTS = {
          'test-calendar': path.join(__dirname, 'scripts', 'test-calendar.js'),
          'status': null // manejado internamente
        };

        if (toolInput.script === 'status') {
          const { db: rawDb } = require('./database');
          const contacts = rawDb.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
          const msgsToday = rawDb.prepare("SELECT COUNT(*) as c FROM messages WHERE date(timestamp)=date('now')").get().c;
          const mem = process.memoryUsage();
          return JSON.stringify({
            success: true,
            uptime_seconds: Math.floor(process.uptime()),
            node_version: process.version,
            memory_mb: Math.round(mem.rss / 1024 / 1024),
            contacts_total: contacts,
            messages_today: msgsToday,
            timestamp: new Date().toISOString()
          });
        }

        const scriptPath = SCRIPTS[toolInput.script];
        if (!scriptPath) {
          return JSON.stringify({ success: false, message: `Script desconocido: "${toolInput.script}". Opciones: ${Object.keys(SCRIPTS).join(', ')}` });
        }

        const output = await new Promise((resolve) => {
          execFile('node', [scriptPath], { timeout: 30000, cwd: __dirname }, (err, stdout, stderr) => {
            resolve({
              success: !err,
              stdout: stdout?.trim().substring(0, 1500) || '',
              stderr: stderr?.trim().substring(0, 500) || '',
              exit_code: err?.code || 0
            });
          });
        });
        logger.info(`[SHELL] run_script "${toolInput.script}" → exit ${output.exit_code}`);
        return JSON.stringify(output);
      }

      case 'search_contacts': {
        const results = searchContacts(toolInput.query, 10);
        return JSON.stringify({ success: true, contacts: results, count: results.length });
      }

      case 'get_contact_detail': {
        const contact = getContact(toolInput.phone);
        if (!contact) return JSON.stringify({ success: false, message: `No encontré contacto con teléfono ${toolInput.phone}` });
        const history = getHistory(toolInput.phone, toolInput.history_limit || 15);
        return JSON.stringify({ success: true, contact, history });
      }

      case 'get_pending_actions': {
        const actions = getPendingActions();
        return JSON.stringify({ success: true, actions, count: actions.length });
      }

      case 'reply':
        // Herramienta de respuesta directa — el mensaje ya está en toolInput.message
        return JSON.stringify({ success: true, final_response: toolInput.message });

      default:
        return JSON.stringify({ success: false, message: `Herramienta desconocida: ${toolName}` });
    }
  } catch (error) {
    logger.error(`Error ejecutando herramienta ${toolName}: ${error.message}`);
    return JSON.stringify({ success: false, error: error.message });
  }
}

// ─── Loop de tool use con Claude ─────────────────────────────────────────────

/**
 * Llama a Claude con tool use y ejecuta las herramientas hasta obtener
 * la respuesta final en texto.
 *
 * @param {Array} messages - Historial de mensajes para Claude
 * @returns {string} Texto final de respuesta
 */
async function callClaudeWithTools(messages) {
  let currentMessages = [...messages];

  // Máximo 5 rondas de tool use para evitar loops
  for (let round = 0; round < 5; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: getAgendaSystemPrompt(),
      tools: AGENDA_TOOLS,
      tool_choice: { type: 'any' }, // Haiku SIEMPRE debe usar al menos una herramienta
      messages: currentMessages
    });

    logger.debug(`Claude stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === 'tool_use') {
      // Claude quiere usar herramientas — ejecutarlas y continuar
      const toolResults = [];
      let replyText = null;

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input);

          // Si Claude llamó "reply", ese ES el texto final — no seguimos el loop
          if (block.name === 'reply') {
            try {
              const parsed = JSON.parse(result);
              if (parsed.final_response) replyText = parsed.final_response;
            } catch (_) {}
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          });
        }
      }

      if (replyText !== null) return replyText;

      // Agregar la respuesta del asistente y los resultados al historial
      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });

    } else {
      // Claude terminó sin tool use (no debería pasar con tool_choice: any)
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text || 'Listo ✅';
    }
  }

  return 'Acción completada ✅';
}

// ─── Función principal del agente de agenda ───────────────────────────────────

/**
 * Procesa un mensaje de Ricardo y responde via WhatsApp.
 * Esta función es llamada desde agent.js cuando el remitente es AGENDA_PHONE.
 *
 * @param {string} phone - Número de Ricardo
 * @param {string} text - Texto del mensaje
 * @returns {Object} { success, response }
 */
/**
 * Detecta y ejecuta comandos de control del bot (tomar/liberar).
 * Retorna el mensaje de respuesta si fue un comando, null si no lo es.
 * @param {string} text - Texto del mensaje
 * @returns {string|null}
 */
// ─── Integración con SOLARPOWERTOTALBOT ──────────────────────────────────────

const SOLARBOT_DIR = 'C:\\Users\\Ricky\\Desktop\\CLAUDIO\\CLAUDIO\\BASE DE DATOS\\SOLARPOWERTOTALBOT';

/**
 * Parsea el resto del texto tras detectar el patrón "artículo sobre/: X"
 * y extrae opcionalmente titulo y datos.
 * @param {string} rest - Texto después del patrón base
 * @returns {{ tema: string, titulo: string|null, datos: string|null }}
 */
function _parseArticleRest(rest) {
  let tema = rest.trim();
  let titulo = null;
  let datos = null;

  // Extraer "con datos[:]..." al final
  const datosMatch = tema.match(/^([\s\S]+?)\s+con\s+datos\s*[:\-]?\s*(.+)$/i);
  if (datosMatch) {
    tema = datosMatch[1].trim();
    datos = datosMatch[2].trim();
  }

  // Extraer "con título/nombre/titulado ..." del tema
  const tituloMatch = tema.match(/^([\s\S]+?)\s+(?:con\s+)?(?:t[ií]tulo|nombre|titulado)\s*["\"]?(.+?)["\"]?$/i);
  if (tituloMatch) {
    tema = tituloMatch[1].trim();
    titulo = tituloMatch[2].trim().replace(/^[""]|[""]$/g, '');
  }

  return { tema, titulo, datos };
}

/**
 * Detecta si el texto es un comando de artículo y extrae tema/titulo/datos.
 * Patrones reconocidos (ampliado):
 *   "artículo: X"
 *   "publicar artículo sobre X"
 *   "publicá / publica un artículo sobre X"
 *   "quiero que publiques un artículo titulado X"
 *   "quiero que publiques un articulo"
 *   "publicar artículo titulado X"
 *   "escribir artículo: X"
 *   "hacé un artículo sobre X"
 *   Todos con opcionales "titulado Y", "con título Y", "con datos: Z"
 * @param {string} text
 * @returns {{ tema, titulo, datos }|null}
 */
function detectArticleCommand(text) {
  const t = text.trim();

  // Patrón simple: empieza con "artículo: X"
  let m = t.match(/^art[ií]culo\s*[:\-]\s*(.+)/i);
  if (m) return _parseArticleRest(m[1]);

  // Patrón: "quiero que publiques/publicar un artículo ..."
  // Nota: en subjuntivo "publiques" usa 'qu', no 'c' → necesitamos publiqu[eé]
  m = t.match(
    /(?:quiero\s+que\s+)?(?:public[aáe][sr]?|publiqu[eé][sr]?|public[aá]|escrib[ií][rs]?|hac[eé][rs]?|armar?)\s+(?:un\s+)?art[ií]culo\s*(.*)/i
  );
  if (m) {
    const rest = m[1].trim();
    // Si viene "titulado X ..." o "sobre X" o solo texto
    const sobreMatch = rest.match(/^(?:sobre\s+|:\s*|titulado\s+)?(.+)/i);
    return _parseArticleRest(sobreMatch ? sobreMatch[1] : rest || t);
  }

  // Patrón: "publicar artículo" en cualquier parte del texto (mensaje largo con contexto)
  if (/art[ií]culo/i.test(t) && /public[aáe]|publiqu[eé]|escrib[ií]|hac[eé]|armar/i.test(t)) {
    // Extraer el título si dice "titulado '...'"
    const titMatch = t.match(/titulado\s*["\u201c]?(.+?)["\u201d]?\s*(?:\n|$)/i);
    const titulo = titMatch ? titMatch[1].trim() : null;
    // El tema es el título o un resumen del texto
    const tema = titulo || 'paneles solares';
    // Todo el resto del texto son datos adicionales
    const datos = t.replace(/.*art[ií]culo[^:]*:?\s*/i, '').trim().substring(0, 800);
    return { tema, titulo, datos: datos.length > 20 ? datos : null };
  }

  return null;
}

/**
 * Lanza SOLARPOWERTOTALBOT en background y notifica a Ricardo cuando termina.
 * Usa 'py' (Windows Python Launcher) como ejecutable principal con fallback a 'python'.
 */
async function handleArticleCommand(phone, text) {
  const cmd = detectArticleCommand(text);
  if (!cmd) return null;

  const { tema, titulo, datos } = cmd;
  const notifTitulo = titulo || tema;

  const args = ['SOLARPOWERTOTALBOT.py', '--tema', tema];
  if (titulo) args.push('--titulo', titulo);
  if (datos) args.push('--datos', datos.substring(0, 800));

  logger.info(`[AGENDA] Lanzando artículo: tema="${tema}" titulo="${titulo}"`);

  // Enviar confirmación ANTES de lanzar el proceso
  const ackMsg = `📝 Arrancando artículo *"${notifTitulo}"* — listo en ~8-10 minutos, te aviso cuando esté publicado.`;
  await sendpulse.sendMessage(phone, ackMsg).catch(() => {});

  // Intentar con 'py' (Windows launcher), fallback a 'python'
  const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';

  const proc = spawn(pythonCmd, args, {
    cwd: SOLARBOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stderrOutput = '';
  if (proc.stderr) proc.stderr.on('data', (d) => { stderrOutput += d.toString(); });

  proc.on('exit', async (code) => {
    logger.info(`[AGENDA] SOLARPOWERTOTALBOT exit=${code} tema="${tema}"`);
    if (stderrOutput) logger.error(`[AGENDA] SOLARPOWERTOTALBOT stderr: ${stderrOutput.substring(0, 300)}`);
    const msg = code === 0
      ? `✅ Artículo publicado: *"${notifTitulo}"*`
      : `⚠️ Error generando artículo *"${notifTitulo}"* (código ${code}). Revisá los logs del SOLARPOWERTOTALBOT.`;
    await sendpulse.sendMessage(phone, msg).catch((err) => {
      logger.error(`[AGENDA] Error notificando artículo: ${err.message}`);
    });
  });

  proc.on('error', async (err) => {
    logger.error(`[AGENDA] Error lanzando SOLARPOWERTOTALBOT: ${err.message}`);
    await sendpulse.sendMessage(phone, `⚠️ No pude iniciar el bot de artículos: ${err.message}`).catch(() => {});
  });

  proc.unref();
  return ackMsg; // ya enviado, devolvemos para que el caller no lo envíe de nuevo
}

// ─── Comandos de control y normalización ─────────────────────────────────────

/**
 * Normaliza cualquier formato de teléfono a solo dígitos sin '+'.
 * "+54 9 11 5992-9323" → "5491159929323"
 */
function normalizePhoneInput(raw) {
  return raw.replace(/[\s\-\+\(\)\.]/g, '');
}

function handleControlCommand(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Comandos reconocidos: pausar / tomar → activar modo humano
  //                       liberar / activar / reactivar → desactivar modo humano
  // Comando: "pausar todo" / "pausa global" / "pausa el bot" / etc. → pausa global
  if (
    /^(pausa|pausar|stop|detener|frenar)\s+(el\s+)?bot$/.test(lower) ||
    /^(pausar?)\s+todo$/.test(lower) ||
    /^pausa\s+global$/.test(lower)
  ) {
    setBotPaused(true);
    return `🔴 *Bot pausado globalmente.*\n\nTomás no responderá a NINGÚN cliente externo hasta que uses:\n*reanudar todo*`;
  }

  // Comando: "reanudar todo" / "reanudar global" / "activar bot" / etc. → reactiva global
  if (
    /^(activar|reactivar|iniciar|arrancar|encender)\s+(el\s+)?bot$/.test(lower) ||
    /^reanudar\s+(todo|global)$/.test(lower)
  ) {
    setBotPaused(false);
    return `🟢 *Bot reactivado.*\n\nTomás vuelve a responder a todos los clientes automáticamente.`;
  }

  // Comando: estado bot → informa si está pausado o activo
  if (/^estado\s+(del?\s+)?bot$/.test(lower)) {
    const paused = isBotPaused();
    return paused
      ? `🔴 *Bot pausado globalmente.* Ningún cliente recibe respuestas.\n\nUsá *activar bot* para reactivarlo.`
      : `🟢 *Bot activo.* Tomás está respondiendo normalmente.\n\nUsá *pausa el bot* para detenerlo.`;
  }

  // Comando: pausar <numero> / tomar <numero>
  const pauseMatch = lower.match(/^(pausar|tomar)\s+(.+)$/);
  if (pauseMatch) {
    const targetPhone = normalizePhoneInput(pauseMatch[2]);
    if (!targetPhone) return null;
    // Crear el contacto si no existe — así podemos pausarlo antes de que escriba
    const contact = getOrCreateContact(targetPhone);
    setHumanMode(targetPhone, true);
    // Sincronizar human_mode=true a Supabase para que sea la fuente autoritativa
    const pausedContact = getContact(targetPhone);
    if (pausedContact) supabaseSync.syncContact(pausedContact);
    const name = contact.name || targetPhone;
    const isNew = !contact.name && !contact.last_contact;
    const extra = isNew ? '\n\n_(Contacto nuevo — datos se completarán cuando escriba al bot)_' : '';
    return `✅ *Bot pausado* para ${name} (${targetPhone}).${extra}\n\nTomás no responderá sus mensajes.\n\nCuando termines usá:\n*liberar ${targetPhone}*`;
  }

  // Comandos: liberar / activar / reactivar → desactivar modo humano
  const releaseMatch = lower.match(/^(liberar|activar|reactivar)\s+(.+)$/);
  if (releaseMatch) {
    const targetPhone = normalizePhoneInput(releaseMatch[2]);
    if (!targetPhone) return null;
    const contact = getContact(targetPhone);
    if (!contact) {
      return `❌ No encontré ningún contacto con el número ${targetPhone}.`;
    }
    setHumanMode(targetPhone, false);
    // Sincronizar human_mode=false a Supabase para que sea la fuente autoritativa
    const releasedContact = getContact(targetPhone);
    if (releasedContact) supabaseSync.syncContact(releasedContact);
    const name = contact.name || targetPhone;
    return `✅ *Bot reactivado* para ${name} (${targetPhone}).\n\nTomás vuelve a responder automáticamente.`;
  }

  return null;
}

/**
 * Envía todas las notificaciones que quedaron encoladas (ventana 24h expirada).
 * Se llama al inicio de cada mensaje de Ricardo — él re-abre la ventana con su mensaje.
 */
async function flushPendingNotifications(phone) {
  try {
    const pending = getPendingNotifications(phone);
    if (pending.length === 0) return;

    logger.info(`[AGENDA] Enviando ${pending.length} notificación(es) encolada(s) a Ricardo`);

    // Aviso previo para que Ricardo sepa que hay pendientes
    await sendpulse.sendMessage(phone,
      `🔔 *${pending.length} notificación${pending.length > 1 ? 'es' : ''} pendiente${pending.length > 1 ? 's' : ''} mientras estabas sin WhatsApp:*`
    ).catch(() => {});

    for (const notif of pending) {
      await sendpulse.sendMessage(phone, notif.message).catch((err) => {
        logger.error(`[AGENDA] Error enviando notificación encolada ${notif.id}: ${err.message}`);
      });
      markNotificationSent(notif.id);
      // Pequeña pausa entre mensajes
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (error) {
    logger.error(`[AGENDA] Error en flushPendingNotifications: ${error.message}`);
  }
}

async function processAgendaMessage(phone, text) {
  logger.info(`[AGENDA] Mensaje de Ricardo: "${text.substring(0, 100)}"`);

  try {
    // Enviar notificaciones que quedaron encoladas (ventana 24h re-abierta)
    await flushPendingNotifications(phone);

    // Verificar si es un comando de control del bot
    const commandResponse = handleControlCommand(text);
    if (commandResponse) {
      await sendpulse.sendMessage(phone, commandResponse);
      logger.info(`[AGENDA] Comando de control ejecutado: "${text}"`);
      return { success: true, response: commandResponse };
    }

    // Verificar si es un comando de artículo (lanza SOLARPOWERTOTALBOT en background)
    // handleArticleCommand ya envía el ack internamente — no re-enviar
    const articleResponse = await handleArticleCommand(phone, text);
    if (articleResponse) {
      logger.info(`[AGENDA] Artículo encargado: "${text.substring(0, 80)}"`);
      return { success: true, response: articleResponse };
    }

    // Guardar mensaje de Ricardo en el historial
    saveAgendaMessage('user', text);
    supabaseSync.logMessage(phone, 'Ricardo', 'user', text);

    // Cargar historial de conversación de la agenda
    const history = getAgendaHistory(15);

    // Llamar a Claude con las herramientas
    const responseText = await callClaudeWithTools(history);

    // Guardar respuesta del asistente
    saveAgendaMessage('assistant', responseText);
    supabaseSync.logMessage(phone, 'Ricardo', 'assistant', responseText);

    // Enviar respuesta a Ricardo via WhatsApp
    await sendpulse.sendMessage(phone, responseText);

    logger.info(`[AGENDA] Respuesta enviada a Ricardo`);
    return { success: true, response: responseText };

  } catch (error) {
    logger.error(`[AGENDA] Error procesando mensaje: ${error.message}`);

    const errorMsg = 'No pude procesar eso ahora 😅 Intentá de nuevo.';
    await sendpulse.sendMessage(phone, errorMsg).catch(() => {});

    return { success: false, response: errorMsg };
  }
}

/**
 * Formatea un evento de agenda como mensaje de recordatorio para WhatsApp.
 * @param {Object} event - Evento de la DB
 * @returns {string} Mensaje formateado
 */
function formatReminderMessage(event, overdue = false) {
  const eventDate = new Date(event.date_time);
  const now = new Date();
  const diffMin = Math.round((eventDate - now) / 60000);

  const hora = eventDate.toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit'
  });

  const tipoEmoji = {
    visita: '🔧',
    instalacion: '⚡',
    reunion: '🤝',
    llamada: '📞',
    recordatorio: '🔔',
    tramite: '📋',
    otro: '📅'
  }[event.event_type] || '📅';

  let header;
  if (overdue || diffMin < 0) {
    header = `⚠️ *Evento vencido sin recordatorio*`;
  } else if (diffMin <= 15) {
    header = `🔔 *Recordatorio — en ${diffMin} min*`;
  } else {
    header = `⏰ *Recordatorio — en ${diffMin} min*`;
  }

  let msg = `${header}\n\n`;
  msg += `${tipoEmoji} *${event.title}*\n`;
  msg += `🕐 ${hora}`;
  if (event.duration_minutes && event.duration_minutes !== 60) {
    msg += ` (${event.duration_minutes >= 60 ? Math.round(event.duration_minutes / 60) + 'h' : event.duration_minutes + 'min'})`;
  }
  msg += '\n';
  if (event.location) msg += `📍 ${event.location}\n`;
  if (event.contact_name) msg += `👤 ${event.contact_name}\n`;
  if (event.contact_phone) msg += `📱 ${event.contact_phone}\n`;
  if (event.description) msg += `📝 ${event.description}\n`;

  return msg.trim();
}

// ─── Chatbot interno para Ricardo Guillermo (0267) ────────────────────────────
// Herramientas de solo-lectura: consultas al sistema, leads, conversaciones, logs.

const CHAT_TOOLS = [
  {
    name: 'get_leads_summary',
    description: 'Resumen general de leads: totales, por etiqueta, activos hoy, pendientes de presupuesto.',
    input_schema: { type: 'object', properties: { include_today: { type: 'boolean' } }, required: [] }
  },
  {
    name: 'get_recent_conversations',
    description: 'Trae las últimas conversaciones del bot con clientes.',
    input_schema: {
      type: 'object',
      properties: {
        contact_limit: { type: 'number', description: 'Cantidad de contactos (default 8)' },
        msgs_per_contact: { type: 'number', description: 'Mensajes por contacto (default 4)' }
      },
      required: []
    }
  },
  {
    name: 'search_contacts',
    description: 'Busca contactos por nombre o teléfono.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Nombre o teléfono' } },
      required: ['query']
    }
  },
  {
    name: 'get_contact_detail',
    description: 'Datos completos de un contacto y su historial de conversación.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Teléfono del contacto (solo dígitos)' },
        history_limit: { type: 'number', description: 'Cantidad de mensajes a incluir (default 15)' }
      },
      required: ['phone']
    }
  },
  {
    name: 'get_pending_actions',
    description: 'Lista acciones pendientes: presupuestos, llamadas, seguimientos.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'read_logs',
    description: 'Lee las últimas líneas del log del bot para ver actividad reciente o errores.',
    input_schema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Cantidad de líneas (default 30)' },
        errors_only: { type: 'boolean', description: 'Si true, solo errores y warnings' },
        log_type: { type: 'string', description: 'Usar "general" para logs de cierre/mejoras; default "app"' }
      },
      required: []
    }
  },
  {
    name: 'reply',
    description: 'Respondé con esta herramienta cuando ya tenés la info o el mensaje no requiere consultar datos.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Respuesta a enviar' } },
      required: ['message']
    }
  }
];

const INTERNAL_CHAT_SYSTEM = `Sos el asistente interno de SolarPower Argentina. Respondés mensajes de WhatsApp del equipo directivo.
Tenés acceso a la base de datos del bot de WhatsApp: contactos, conversaciones, acciones pendientes, leads, y logs del sistema.
Respondé de forma concisa y útil. Usá las herramientas disponibles para consultar datos reales antes de responder.
Siempre usá al menos una herramienta. La fecha actual en Argentina es ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.`;

async function callClaudeChat(messages) {
  let currentMessages = [...messages];
  for (let round = 0; round < 5; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: INTERNAL_CHAT_SYSTEM,
      tools: CHAT_TOOLS,
      tool_choice: { type: 'any' },
      messages: currentMessages
    });

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      let replyText = null;

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input);
          if (block.name === 'reply') {
            try { const p = JSON.parse(result); if (p.final_response) replyText = p.final_response; } catch (_) {}
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
      }

      if (replyText !== null) return replyText;
      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });
    } else {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text || 'Listo ✅';
    }
  }
  return 'Consulta procesada ✅';
}

/**
 * Procesa un mensaje de Ricardo Guillermo (0267) como chatbot interno con acceso a la DB.
 * Esta función es llamada desde index.js cuando el remitente es RICARDO_GUILLERMO_PHONE.
 */
async function processInternalChatMessage(phone, text) {
  logger.info(`[CHAT-INTERNO] Mensaje de ${phone}: "${text.substring(0, 100)}"`);

  try {
    // Guardar en historial de agenda (reutilizamos la tabla para no crear una nueva)
    saveAgendaMessage('user', `[GUILLERMO] ${text}`);

    const history = getAgendaHistory(10).map(m => ({
      role: m.role,
      content: m.content
    }));

    const responseText = await callClaudeChat(history);

    saveAgendaMessage('assistant', `[GUILLERMO] ${responseText}`);
    await sendpulse.sendMessage(phone, responseText);

    logger.info(`[CHAT-INTERNO] Respuesta enviada a ${phone}`);
    return { success: true, response: responseText };
  } catch (error) {
    logger.error(`[CHAT-INTERNO] Error: ${error.message}`);
    const err = 'No pude procesar eso ahora. Intentá de nuevo.';
    await sendpulse.sendMessage(phone, err).catch(() => {});
    return { success: false, response: err };
  }
}

module.exports = { processAgendaMessage, processInternalChatMessage, formatReminderMessage };
