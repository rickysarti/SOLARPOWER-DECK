/**
 * scripts/test-calendar.js
 * Prueba rápida de conexión con Google Calendar.
 * Crea un evento de prueba y lo elimina si funciona.
 *
 * Uso: node scripts/test-calendar.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { google } = require('googleapis');

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Test de Google Calendar');
  console.log('═══════════════════════════════════════════════════\n');

  // Verificar variables de entorno
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'];
  for (const key of required) {
    const val = process.env[key];
    if (!val) {
      console.error(`❌ Falta ${key} en el .env`);
      process.exit(1);
    }
    console.log(`✅ ${key}: ${val.substring(0, 20)}...`);
  }

  console.log('\n--- Probando conexión OAuth2 ---');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  // Intentar obtener un access token
  try {
    const { token } = await oauth2Client.getAccessToken();
    console.log(`✅ Access token obtenido: ${token.substring(0, 20)}...`);
  } catch (err) {
    console.error(`❌ Error obteniendo access token: ${err.message}`);
    if (err.message.includes('invalid_grant')) {
      console.error('   El refresh token expiró o fue revocado.');
      console.error('   Volvé a correr: node scripts/google-auth.js');
    }
    process.exit(1);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  console.log('\n--- Verificando acceso al calendario ---');
  try {
    const cal = await calendar.calendars.get({ calendarId });
    console.log(`✅ Calendario accesible: "${cal.data.summary}" (${calendarId})`);
  } catch (err) {
    console.error(`❌ Error accediendo al calendario: ${err.message}`);
    if (err.code === 404) {
      console.error('   El calendario no existe o no tenés acceso.');
      console.error(`   Calendar ID usado: ${calendarId}`);
    } else if (err.code === 403) {
      console.error('   Sin permisos. Verificá que la Calendar API esté habilitada en:');
      console.error('   https://console.cloud.google.com/apis/library/calendar-json.googleapis.com');
    }
    process.exit(1);
  }

  console.log('\n--- Creando evento de prueba ---');
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 60000);

  let createdEventId = null;
  try {
    const res = await calendar.events.insert({
      calendarId,
      resource: {
        summary: '✅ TEST - Bot SolarPower (eliminar)',
        description: 'Evento de prueba creado por el bot. Podés eliminarlo.',
        start: { dateTime: now.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
        end:   { dateTime: end.toISOString(),  timeZone: 'America/Argentina/Buenos_Aires' }
      }
    });
    createdEventId = res.data.id;
    console.log(`✅ Evento creado con ID: ${createdEventId}`);
    console.log(`   Revisá tu Google Calendar — debería aparecer "TEST - Bot SolarPower"`);
  } catch (err) {
    console.error(`❌ Error creando evento: ${err.message}`);
    console.error('   Detalles:', JSON.stringify(err.errors || err.response?.data, null, 2));
    process.exit(1);
  }

  // Eliminar el evento de prueba
  console.log('\n--- Eliminando evento de prueba ---');
  try {
    await calendar.events.delete({ calendarId, eventId: createdEventId });
    console.log('✅ Evento de prueba eliminado correctamente');
  } catch (err) {
    console.warn(`⚠️  No se pudo eliminar el evento de prueba: ${err.message}`);
    console.warn(`   Eliminalo manualmente desde Google Calendar (ID: ${createdEventId})`);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('  ✅ Todo OK — Google Calendar está conectado!');
  console.log('════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Error inesperado:', err.message);
  process.exit(1);
});
