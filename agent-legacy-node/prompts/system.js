/**
 * prompts/system.js
 * Carga el system prompt especializado según el tipo de contacto.
 * Cada tipo tiene su propio archivo MD en este directorio.
 */

const fs = require('fs');
const path = require('path');

// Cache de prompts en memoria (se cargan una vez, se reusan)
const promptCache = {};

/**
 * Lee y cachea un archivo MD de esta carpeta.
 * @param {string} filename - Nombre del archivo (ej: 'residencial.md')
 * @returns {string} Contenido del archivo
 */
function loadPrompt(filename) {
  if (!promptCache[filename]) {
    promptCache[filename] = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  }
  return promptCache[filename];
}

/**
 * Retorna el system prompt especializado según el tipo de contacto,
 * combinado con el estado actual del contacto.
 *
 * @param {Object} contact - Objeto contacto de la base de datos
 * @returns {string} System prompt completo
 */
function getSystemPrompt(contact) {
  const tipo = contact.tipo;
  let basePrompt;

  if (tipo === 'comercial') {
    basePrompt = loadPrompt('comercial.md');
  } else if (tipo === 'academia') {
    basePrompt = loadPrompt('academia.md');
  } else if (tipo === 'cv') {
    basePrompt = loadPrompt('cv.md');
  } else {
    // residencial es el default (también aplica a contactos sin tipo todavía)
    basePrompt = loadPrompt('residencial.md');
  }

  const estadoContacto = `

## ESTADO ACTUAL DE ESTE CONTACTO
- Nombre: ${contact.name || 'desconocido'}
- Email: ${contact.email || 'no informado'}
- Tipo de cliente: ${contact.tipo || 'no clasificado'}
- Etiqueta actual: ${contact.label || 'Interesado'}
- Factura recibida: ${contact.bill_received ? 'SÍ' : 'NO'}
- Tipo de techo: ${contact.roof_type || 'no informado'}
- Conexión: ${contact.connection_type || 'no informado'}
- Localidad: ${contact.locality || 'no informado'}
- Interés: ${contact.product_interest || 'no definido'}
- Primera consulta: ${contact.first_contact}`;

  return basePrompt + estadoContacto;
}

module.exports = { getSystemPrompt };
