'use strict';

/**
 * outreach/searcher.js
 * Busca empresas usando Perplexity API y normaliza los resultados.
 */

const axios = require('axios');
const { getSearch, saveSearch, getAllSearches } = require('./db');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const DELAY_BETWEEN_SEARCHES_MS = 2000;
const SEARCH_CACHE_DAYS = 14; // no re-buscar si fue buscado hace menos de X días
const FALLBACK_REFRESH_COUNT = 3; // si todo fue buscado recientemente, refrescar las N más antiguas

// ─── Zonas y rubros ───────────────────────────────────────────────────────────

const ZONAS = [
  'Tigre', 'San Isidro', 'San Fernando', 'Vicente López',
  'Escobar', 'Pilar', 'Zárate', 'Campana',
  'General Pacheco', 'Martínez', 'Olivos',
];

const RUBROS = [
  { nombre: 'frigoríficos y plantas de frío industrial',          prioridad: 1 },
  { nombre: 'galpones logísticos y centros de distribución',      prioridad: 2 },
  { nombre: 'supermercados y mayoristas',                         prioridad: 3 },
  { nombre: 'industrias alimenticias y de bebidas',               prioridad: 4 },
  { nombre: 'plantas industriales y fábricas',                    prioridad: 5 },
  { nombre: 'metalúrgicas y talleres industriales grandes',       prioridad: 6 },
  { nombre: 'viveros y establecimientos de jardinería comercial', prioridad: 7 },
  { nombre: 'colegios y universidades privadas grandes',          prioridad: 8 },
  { nombre: 'gimnasios y clubes deportivos grandes',              prioridad: 9 },
];

// ─── Normalización de WhatsApp ────────────────────────────────────────────────

/**
 * Normaliza un número de teléfono al formato argentino E.164: 549XXXXXXXXXX
 * @param {string} phone
 * @returns {string} número normalizado o '' si no es válido
 */
function normalizeWhatsapp(phone) {
  if (!phone) return '';

  // Eliminar todos los caracteres no numéricos (espacios, guiones, paréntesis, puntos, +, etc.)
  let n = String(phone).replace(/\D/g, '');

  if (n.length < 8) return ''; // demasiado corto para ser válido

  // Si empieza con 0 → reemplazar el 0 inicial por 549
  // Ej: "01145236789" → "54" + "9" + "1145236789" pero el spec dice "011 → 54911"
  // Significa: quitar el 0 inicial y anteponer 549
  if (n.startsWith('0')) {
    n = '549' + n.slice(1);
  }
  // Si empieza con 54 pero sin el 9 de prefijo móvil → insertar el 9
  // Ej: "541145236789" → "549" + "1145236789"
  else if (n.startsWith('54') && n.length >= 3 && n[2] !== '9') {
    n = '549' + n.slice(2);
  }
  // Si ya empieza con 549 → ok, no hacer nada
  else if (n.startsWith('549')) {
    // nada
  }
  // Si no tiene prefijo de país → agregar 549
  else if (!n.startsWith('54')) {
    n = '549' + n;
  }

  // Validar longitud mínima esperada (549 + 10 dígitos = 13)
  if (n.length < 11 || n.length > 15) return '';

  return n;
}

// ─── Construcción del prompt ──────────────────────────────────────────────────

function buildPrompt(rubro, zona) {
  return `Buscá empresas del rubro "${rubro}" ubicadas en "${zona}", provincia de Buenos Aires, Argentina. Usá Google Maps, páginas amarillas, directorios empresariales, LinkedIn y sitios corporativos.

REGLA IMPORTANTE: Solo incluí empresas para las que encontrés AL MENOS uno de estos dos datos de contacto: email corporativo O número de WhatsApp/teléfono celular. No incluyas empresas sin ningún dato de contacto.

Devolvé SOLO un JSON válido, sin texto adicional ni bloques de código markdown:

{
  "empresas": [
    {
      "nombre": "nombre completo de la empresa",
      "rubro": "descripción específica del rubro",
      "zona": "${zona}",
      "direccion": "dirección si aparece",
      "email": "email corporativo o vacío string si no encontrás",
      "whatsapp": "número de WhatsApp o celular con código de país, ej: 5491112345678, o vacío string si no encontrás",
      "contacto_nombre": "nombre del dueño o gerente si aparece, sino vacío",
      "sitio_web": "URL si tiene, sino vacío",
      "fuente": "URL de donde obtuviste esta información"
    }
  ]
}

Devolvé entre 15 y 25 empresas. Solo empresas grandes o medianas con consumo eléctrico alto probable. Preferí calidad sobre cantidad.`;
}

// ─── Llamada a Perplexity ─────────────────────────────────────────────────────

/**
 * Busca empresas para una combinación zona+rubro.
 * @param {string} rubro
 * @param {string} zona
 * @returns {Promise<Array>} array de empresas (puede estar vacío si hay error)
 */
async function searchEmpresas(rubro, zona) {
  try {
    const response = await axios.post(
      PERPLEXITY_URL,
      {
        model: 'sonar',
        messages: [
          { role: 'user', content: buildPrompt(rubro, zona) },
        ],
        max_tokens: 2000,
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    return parseResponse(content, rubro, zona);
  } catch (err) {
    console.error(`[searcher] Error en Perplexity para ${rubro} / ${zona}: ${err.message}`);
    return [];
  }
}

/**
 * Parsea la respuesta de Perplexity y extrae el array de empresas.
 * @param {string} content
 * @param {string} rubro - para logging
 * @param {string} zona  - para logging
 * @returns {Array}
 */
function parseResponse(content, rubro, zona) {
  let parsed = null;

  // Intento 1: JSON.parse directo
  try {
    parsed = JSON.parse(content);
  } catch (_) {}

  // Intento 2: extraer bloque JSON con regex
  if (!parsed) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (_) {}
    }
  }

  if (!parsed || !Array.isArray(parsed.empresas)) {
    console.warn(`[searcher] No se pudo parsear respuesta para ${rubro} / ${zona}`);
    return [];
  }

  return parsed.empresas;
}

// ─── Delay helper ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Calcula cuántos días hace que se realizó una búsqueda.
 * Retorna Infinity si nunca fue buscada.
 */
function daysSinceSearch(fechaBusqueda) {
  if (!fechaBusqueda) return Infinity;
  const then = new Date(fechaBusqueda);
  const now  = new Date();
  return (now - then) / (1000 * 60 * 60 * 24);
}

/**
 * Ejecuta las búsquedas en Perplexity, saltando combinaciones buscadas
 * recientemente (< SEARCH_CACHE_DAYS días). Si todas fueron buscadas,
 * refresca las FALLBACK_REFRESH_COUNT más antiguas.
 *
 * @returns {Promise<Array>} empresas encontradas con email válido, sin duplicados
 */
async function runSearch() {
  const todas = [];
  const emailsSeen = new Set();
  const whatsappsSeen = new Set();

  // Construir lista completa de combinaciones ordenadas por prioridad de rubro
  const combinaciones = [];
  for (const rubro of RUBROS) {
    for (const zona of ZONAS) {
      const registro = getSearch(zona, rubro.nombre);
      const diasDesde = daysSinceSearch(registro?.fecha_busqueda);
      combinaciones.push({ rubro, zona, diasDesde, registro });
    }
  }

  // Separar las que necesitan búsqueda de las recientes
  const pendientes  = combinaciones.filter(c => c.diasDesde >= SEARCH_CACHE_DAYS);
  const recientes   = combinaciones.filter(c => c.diasDesde <  SEARCH_CACHE_DAYS);

  let aaBuscar;

  if (pendientes.length > 0) {
    // Buscar todas las que no fueron buscadas recientemente (ya vienen ordenadas por prioridad)
    aaBuscar = pendientes;
    console.log(`[searcher] ${recientes.length} combinaciones salteadas (< ${SEARCH_CACHE_DAYS} días) | ${pendientes.length} a buscar`);
  } else {
    // Todas fueron buscadas recientemente → refrescar las N más antiguas
    const masAntiguas = [...combinaciones].sort((a, b) => a.diasDesde - b.diasDesde).slice(-FALLBACK_REFRESH_COUNT);
    aaBuscar = masAntiguas;
    console.log(`[searcher] Todas las combinaciones fueron buscadas recientemente. Refrescando las ${FALLBACK_REFRESH_COUNT} más antiguas.`);
  }

  let totalBusquedas = 0;

  for (const { rubro, zona, diasDesde } of aaBuscar) {
    totalBusquedas++;
    const diasStr = diasDesde === Infinity ? 'nunca' : `hace ${diasDesde.toFixed(1)} días`;
    console.log(`[searcher] Buscando: ${rubro.nombre} en ${zona} — ${diasStr}`);

    const empresas = await searchEmpresas(rubro.nombre, zona);

    // Registrar la búsqueda en DB independientemente del resultado
    saveSearch(zona, rubro.nombre, empresas.length);

    let nuevasDeEsta = 0;
    for (const emp of empresas) {
      const emailRaw = (emp.email || '').trim().toLowerCase();
      const waRaw    = normalizeWhatsapp(emp.whatsapp || '');

      // Descartar si no tiene email (canal WA desactivado)
      if (!emailRaw) continue;

      // Descartar duplicados en esta sesión
      if (emailsSeen.has(emailRaw)) continue;
      if (waRaw && whatsappsSeen.has(waRaw)) continue;

      emailsSeen.add(emailRaw);
      if (waRaw) whatsappsSeen.add(waRaw);

      todas.push({
        nombre:          emp.nombre          || 'Sin nombre',
        rubro:           emp.rubro           || rubro.nombre,
        zona:            emp.zona            || zona,
        email:           emailRaw,
        whatsapp:        waRaw               || null,
        contacto_nombre: emp.contacto_nombre || null,
        sitio_web:       emp.sitio_web       || null,
        fuente:          emp.fuente          || null,
      });
      nuevasDeEsta++;
    }

    console.log(`[searcher]   → ${nuevasDeEsta} empresas con email válido`);
    await sleep(DELAY_BETWEEN_SEARCHES_MS);
  }

  // Loggear las salteadas
  const salteadas = combinaciones.filter(c => c.diasDesde < SEARCH_CACHE_DAYS && !aaBuscar.includes(c));
  for (const { rubro, zona, diasDesde } of salteadas) {
    console.log(`[searcher] Salteando: ${rubro.nombre} en ${zona} — buscado hace ${diasDesde.toFixed(1)} días`);
  }

  console.log(`[searcher] Búsquedas realizadas: ${totalBusquedas} | Empresas con email: ${todas.length}`);
  return todas;
}

module.exports = { runSearch, normalizeWhatsapp, ZONAS, RUBROS };
