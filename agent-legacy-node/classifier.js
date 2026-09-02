/**
 * classifier.js
 * Clasificador rápido de intención del mensaje basado en keywords.
 * Se usa ANTES de llamar a Claude para casos obvios y ahorrar tokens.
 */

/**
 * Normaliza el texto para comparación: minúsculas, sin tildes.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // eliminar tildes
    .trim();
}

/**
 * Verifica si el texto contiene alguna de las keywords.
 * @param {string} text - Texto normalizado
 * @param {string[]} keywords - Lista de palabras clave
 * @returns {boolean}
 */
function containsAny(text, keywords) {
  return keywords.some(kw => text.includes(normalize(kw)));
}

/**
 * Clasifica el mensaje del usuario en una categoría inicial.
 *
 * Categorías posibles:
 * - 'academia'   → Interés en el curso de instalación solar
 * - 'proveedor'  → Quiere ser proveedor, vendedor o distribuidor
 * - 'comercial'  → Consulta comercial grande (empresa, industria)
 * - 'soporte'    → Cliente con sistema instalado que reporta problema
 * - 'greeting'   → Saludo o mensaje muy corto
 * - 'general'    → Todo lo demás (pasa a Claude)
 *
 * @param {string} text - Mensaje original del usuario
 * @returns {string} Categoría del mensaje
 */
function classifyMessage(text) {
  if (!text || typeof text !== 'string') return 'general';

  const normalized = normalize(text);
  const wordCount = normalized.split(/\s+/).filter(w => w.length > 0).length;

  // --- Academia Solar ---
  const academiaKeywords = [
    'academia', 'curso', 'aprender', 'instalador', 'instalacion solar',
    'aprendizaje', 'capacitacion', 'formacion', 'ensenar', 'clases'
  ];
  if (containsAny(normalized, academiaKeywords)) {
    return 'academia';
  }

  // --- Proveedor / Vendedor / Distribuidor ---
  const proveedorKeywords = [
    'proveedor', 'vender', 'vendedor', 'distribuidor', 'revendedor',
    'ser agente', 'comision', 'representante', 'franquicia',
    'quiero vender', 'trabajar con ustedes', 'asociarme',
    'cv', 'curriculum', 'hoja de vida', 'busco trabajo', 'busco empleo'
  ];
  if (containsAny(normalized, proveedorKeywords)) {
    return 'proveedor';
  }

  // --- Comercial grande (empresa, industria, campo) ---
  const comercialKeywords = [
    'empresa', 'industria', 'fabrica', 'comercio', 'local comercial',
    'campo', 'establecimiento', 'planta', 'galpón', 'galpon',
    'supermercado', 'hotel', 'edificio', 'consorcio', 'frigorifico'
  ];
  if (containsAny(normalized, comercialKeywords)) {
    return 'comercial';
  }

  // --- Soporte de cliente con sistema instalado ---
  const soporteKeywords = [
    'no funciona', 'se rompio', 'roto', 'falla', 'problema con el sistema',
    'panel roto', 'inversor', 'alarma', 'error', 'no produce',
    'tengo instalado', 'ya tengo paneles', 'me instalaron'
  ];
  if (containsAny(normalized, soporteKeywords)) {
    return 'soporte';
  }

  // --- Saludo o mensaje muy corto ---
  const greetingKeywords = [
    'hola', 'buenas', 'buen dia', 'buenos dias', 'buenas tardes',
    'buenas noches', 'hi', 'hello', 'que tal', 'como estan'
  ];
  // Mensaje corto (menos de 4 palabras) o solo saludo
  if (wordCount < 4 || containsAny(normalized, greetingKeywords)) {
    // Si SOLO es saludo o mensaje muy corto, clasificar como greeting
    if (wordCount < 4) {
      return 'greeting';
    }
  }

  // Todo lo demás va a Claude para análisis completo
  return 'general';
}

module.exports = { classifyMessage };
