'use strict';

/**
 * outreach/templates.js
 * Genera el contenido de emails y mensajes de WhatsApp por rubro y canal.
 *
 * REGLAS DE NEGOCIO:
 * - NUNCA escribir "sin inversión inicial"
 * - Plan SolarPower = inversión inicial accesible + cuota mensual fija en uvas
 * - Alternativa: compra con financiamiento bancario
 * - NO ofrecer visita técnica en primer contacto
 * - CTA único: que manden 4 datos (factura, techo, conexión, localidad)
 * - Máx 200 palabras email / 120 palabras WhatsApp
 */

// ─── Asuntos por rubro ────────────────────────────────────────────────────────

const ASUNTOS = [
  {
    pattern: /frigor|frío|fr[íi]o|c[aá]mara/i,
    asunto: (zona) => `¿Cuánto pagás de luz en tus cámaras de frío? Podemos ayudarte a reducirlo`,
  },
  {
    pattern: /galp[oó]n|log[íi]stic|distribuci/i,
    asunto: (zona) => `Sistema solar para tu galpón en ${zona} — propuesta a medida sin compromiso`,
  },
  {
    pattern: /supermercado|mayorista|comercio/i,
    asunto: () => `Reducí la factura eléctrica de tu comercio con energía solar`,
  },
  {
    pattern: /industria|f[áa]brica|aliment|bebida|pl[áa]nta/i,
    asunto: (zona) => `Energía solar para industrias en ${zona} — evaluación gratuita`,
  },
  {
    pattern: /metal[úu]rg|taller/i,
    asunto: (zona) => `Energía solar para industrias en ${zona} — evaluación gratuita`,
  },
  {
    pattern: /vivero|jardiner/i,
    asunto: () => `Sistema solar para tu vivero — cuota fija, ahorro desde el primer mes`,
  },
];

function getAsunto(lead) {
  const rubro = lead.rubro || '';
  const zona = lead.zona || 'GBA Norte';
  for (const entry of ASUNTOS) {
    if (entry.pattern.test(rubro)) return entry.asunto(zona);
  }
  return `Energía solar para empresas en ${zona} — propuesta personalizada`;
}

// ─── Descripción breve del rubro para el cuerpo del email ────────────────────

function describir(rubro) {
  if (!rubro) return 'la operación que tienen';
  const r = rubro.toLowerCase();
  if (/frigor|frío|fr[íi]o|c[aá]mara/.test(r))  return 'mantener cámaras de frío en funcionamiento continuo';
  if (/galp[oó]n|log[íi]stic|distribuci/.test(r)) return 'operar un galpón o centro de distribución de alta actividad';
  if (/supermercado|mayorista/.test(r))            return 'mantener refrigeración, iluminación y cajas funcionando todo el día';
  if (/industria|f[áa]brica|aliment|bebida/.test(r)) return 'sostener una planta industrial con consumo eléctrico elevado';
  if (/metal[úu]rg|taller/.test(r))                return 'operar maquinaria y equipos industriales de alto consumo';
  if (/vivero|jardiner/.test(r))                   return 'mantener riego, iluminación y climatización en producción vegetal';
  if (/colegio|universidad/.test(r))               return 'sostener la operación de una institución educativa de gran escala';
  if (/gimnasio|club/.test(r))                     return 'mantener iluminación, climatización y equipos deportivos activos';
  return 'sostener la operación con consumo eléctrico significativo';
}

function saludo(lead) {
  if (lead.contacto_nombre) return lead.contacto_nombre;
  return `equipo de ${lead.nombre}`;
}

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Genera el contenido del email para un lead.
 * @param {Object} lead
 * @returns {{ asunto: string, cuerpo: string }}
 */
function getEmailContent(lead) {
  const zona = lead.zona || 'GBA Norte';

  const asunto = getAsunto(lead);

  const cuerpo = `Hola ${saludo(lead)},

Somos SolarPower, instalamos sistemas fotovoltaicos para industrias y comercios en GBA Norte.

Viendo el tipo de operación que tienen — ${describir(lead.rubro)} — es muy probable que la factura eléctrica sea uno de sus costos fijos más importantes.

Tenemos dos opciones para empresas del sector:

→ Plan SolarPower: inversión inicial accesible más cuota mensual fija en uvas. El ahorro neto en el gasto eléctrico total (cuota + nueva factura reducida) puede llegar al 30-50%. El sistema es nuestro, el ahorro es de ustedes.

→ Compra con financiamiento bancario: el sistema queda de su propiedad desde el primer día.

Para evaluar si aplican a nuestro plan comercial y armar una propuesta a medida, necesitamos que nos manden:

• Foto o PDF de la factura de luz más reciente
• Tipo de techo (chapa, losa, teja u otro)
• Tipo de conexión (monofásica o trifásica)
• Localidad

Con eso les enviamos números concretos, sin ningún compromiso de su parte.

Saludos,
Ricardo
SolarPower Energy
WhatsApp: +54 9 11 3458-3958

---
Si no querés recibir más información, respondé este email y te damos de baja.`;

  return { asunto, cuerpo };
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

/**
 * Genera el texto del mensaje de WhatsApp para un lead.
 * Texto plano, sin markdown, máx 120 palabras.
 * @param {Object} lead
 * @returns {string}
 */
function getWhatsappContent(lead) {
  const rubro = lead.rubro || 'empresas de alto consumo eléctrico';

  return `Hola ${saludo(lead)},

Soy Ricardo de SolarPower Energy. Instalamos sistemas solares para ${rubro} en Zona Norte GBA.

Tenemos dos opciones para empresas como la de ustedes:
- Plan SolarPower: inversión inicial accesible + cuota mensual fija en uvas. El ahorro neto en la factura de luz puede llegar al 30-50%.
- Compra financiada por banco.

Para ver si aplican y armarles una propuesta necesito:
- Foto de la factura de luz
- Tipo de techo (chapa, losa, teja)
- Conexión: monofásica o trifásica
- Localidad

Les mando los números concretos sin compromiso. Les interesa?

Saludos`;
}

module.exports = { getEmailContent, getWhatsappContent };
