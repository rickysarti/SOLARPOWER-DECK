/**
 * test.js
 * Tests básicos del agente SolarPower.
 * Correr con: node test.js
 */

require('dotenv').config();

// Forzar DB en memoria para tests (no afecta la DB real)
process.env.DB_PATH = ':memory:';

let passed = 0;
let failed = 0;

/**
 * Utilidad simple de assertion.
 */
function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

// ─── Test 1: Base de datos ────────────────────────────────────────────────────

console.log('\n📦 TEST 1 — Conexión y operaciones de base de datos');
console.log('─'.repeat(50));

try {
  const db = require('./database');

  // Crear contacto nuevo
  const contact = db.getOrCreateContact('5491100000001', 'Test User');
  assert(contact !== null, 'getOrCreateContact retorna un contacto');
  assert(contact.phone === '5491100000001', 'El teléfono del contacto es correcto');
  assert(contact.name === 'Test User', 'El nombre del contacto es correcto');
  assert(contact.label === 'Interesado', 'La etiqueta inicial es "Interesado"');

  // Obtener el mismo contacto (no debe duplicar)
  const contactRepeat = db.getOrCreateContact('5491100000001', 'Otro Nombre');
  assert(contactRepeat.id === contact.id, 'No se duplica el contacto existente');

  // Actualizar campos
  db.updateContact('5491100000001', { label: 'Test Label', roof_type: 'losa' });
  const updated = db.getContact('5491100000001');
  assert(updated.label === 'Test Label', 'updateContact actualiza la etiqueta');
  assert(updated.roof_type === 'losa', 'updateContact actualiza roof_type');

  // Guardar mensajes
  db.saveMessage('5491100000001', 'user', 'Hola quiero info');
  db.saveMessage('5491100000001', 'assistant', 'Hola! Soy Ricardo de SolarPower...');

  const history = db.getHistory('5491100000001', 20);
  assert(history.length === 2, 'getHistory retorna 2 mensajes');
  assert(history[0].role === 'user', 'El primer mensaje es del usuario');
  assert(history[1].role === 'assistant', 'El segundo mensaje es del asistente');

  // Acciones pendientes
  db.addPendingAction('5491100000001', 'send_budget', 'Enviar presupuesto');
  const pending = db.getPendingActions();
  assert(pending.length === 1, 'addPendingAction agrega una acción pendiente');
  assert(pending[0].action_type === 'send_budget', 'El tipo de acción es correcto');

  db.resolveAction(pending[0].id);
  const pendingAfter = db.getPendingActions();
  assert(pendingAfter.length === 0, 'resolveAction elimina la acción pendiente');

  // getAllContacts
  const all = db.getAllContacts();
  assert(all.length >= 1, 'getAllContacts retorna al menos un contacto');

  console.log(`\n  Resultado: ${passed} tests pasaron\n`);

} catch (error) {
  console.error(`  💥 Error inesperado en Test 1: ${error.message}`);
  failed++;
}

// ─── Test 2: Clasificador de mensajes ─────────────────────────────────────────

console.log('🔍 TEST 2 — Clasificador de mensajes');
console.log('─'.repeat(50));

try {
  const { classifyMessage } = require('./classifier');

  // Academia
  assert(classifyMessage('quiero hacer el curso de instalación solar') === 'academia', 'Detecta academia');
  assert(classifyMessage('me interesa la academia solar') === 'academia', 'Detecta academia (variante)');

  // Proveedor
  assert(classifyMessage('quiero ser vendedor de SolarPower') === 'proveedor', 'Detecta proveedor');
  assert(classifyMessage('soy distribuidor y quiero vender paneles') === 'proveedor', 'Detecta distribuidor');

  // Comercial
  assert(classifyMessage('tengo una empresa y quiero instalar paneles') === 'comercial', 'Detecta comercial');
  assert(classifyMessage('es para una fábrica grande') === 'comercial', 'Detecta fábrica');

  // Soporte
  assert(classifyMessage('el panel no funciona bien') === 'soporte', 'Detecta soporte');
  assert(classifyMessage('me instalaron paneles y hay un error') === 'soporte', 'Detecta soporte (instalado)');

  // Greeting / mensaje corto
  assert(classifyMessage('hola') === 'greeting', 'Detecta saludo corto');
  assert(classifyMessage('info') === 'greeting', 'Detecta mensaje corto');

  // General
  assert(classifyMessage('quiero saber cuánto ahorro con los paneles') === 'general', 'Clasificación general');
  assert(classifyMessage('qué incluye el plan de alquiler?') === 'general', 'Clasificación general (plan)');

  const localPassed = passed;
  console.log(`\n  Resultado: tests de clasificador completados\n`);

} catch (error) {
  console.error(`  💥 Error inesperado en Test 2: ${error.message}`);
  failed++;
}

// ─── Test 3: Mock de autenticación SendPulse ───────────────────────────────────

console.log('📡 TEST 3 — Cliente SendPulse (mock)');
console.log('─'.repeat(50));

try {
  // Mockear axios para no hacer llamadas reales
  const axios = require('axios');
  const originalPost = axios.post;
  const originalGet = axios.get;

  let tokenCalled = false;
  let botsCalled = false;
  let messageSent = false;
  let lastMessageBody = null;

  // Mock de obtener token
  axios.post = async (url, data) => {
    if (url.includes('oauth/access_token')) {
      tokenCalled = true;
      return {
        data: {
          access_token: 'mock-token-12345',
          expires_in: 3600
        }
      };
    }
    if (url.includes('sendByPhone')) {
      messageSent = true;
      lastMessageBody = data;
      return { data: { success: true } };
    }
    return { data: {} };
  };

  // Mock de obtener bots
  axios.get = async (url) => {
    if (url.includes('/whatsapp/bots')) {
      botsCalled = true;
      return {
        data: {
          data: [{ id: 'mock-bot-id-001', name: 'SolarPower Bot' }]
        }
      };
    }
    return { data: {} };
  };

  // Resetear el módulo de sendpulse para que use los mocks
  delete require.cache[require.resolve('./sendpulse')];
  const sendpulse = require('./sendpulse');

  // Test de inicialización
  await sendpulse.initialize();
  assert(tokenCalled, 'initialize() llama al endpoint de OAuth2');
  assert(botsCalled, 'initialize() obtiene la lista de bots');

  // Test de envío de mensaje
  await sendpulse.sendMessage('+5491134583958', 'Hola, esto es un test');
  assert(messageSent, 'sendMessage() llama al endpoint de WhatsApp');
  assert(lastMessageBody?.phone === '5491134583958', 'El número se normaliza (elimina el +)');
  assert(lastMessageBody?.message?.type === 'text', 'El tipo de mensaje es "text"');
  assert(lastMessageBody?.message?.text?.body === 'Hola, esto es un test', 'El cuerpo del mensaje es correcto');

  // Test de normalización de número
  const { normalizePhone } = sendpulse;
  assert(normalizePhone('+5491134583958') === '5491134583958', 'normalizePhone elimina el +');
  assert(normalizePhone('5491134583958') === '5491134583958', 'normalizePhone no modifica número sin +');

  // Restaurar axios original
  axios.post = originalPost;
  axios.get = originalGet;

  console.log(`\n  Resultado: tests de SendPulse mock completados\n`);

} catch (error) {
  console.error(`  💥 Error inesperado en Test 3: ${error.message}`);
  failed++;
}

// ─── Resumen final ────────────────────────────────────────────────────────────

console.log('═'.repeat(50));
console.log(`\n🏁 RESULTADO FINAL`);
console.log(`  ✅ Tests pasaron: ${passed}`);
console.log(`  ❌ Tests fallaron: ${failed}`);
console.log(`  📊 Total: ${passed + failed}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('  Todo en orden. El bot está listo para usar.\n');
  process.exit(0);
}
