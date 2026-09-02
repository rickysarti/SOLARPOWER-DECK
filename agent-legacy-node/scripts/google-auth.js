/**
 * scripts/google-auth.js
 * Script de autorización única para Google Calendar.
 *
 * Uso:
 *   node scripts/google-auth.js
 *
 * Abrí la URL que imprime, autorizá con tu cuenta de Google,
 * copiá el código de la URL de redirección y pegalo acá.
 * El script guarda el GOOGLE_REFRESH_TOKEN en el .env automáticamente.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { google } = require('googleapis');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = 'http://localhost';

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n❌ Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el .env');
    console.error('   Agregálos antes de correr este script.\n');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Forzar para recibir refresh_token siempre
  });

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  PASO 1: Abrí esta URL en tu navegador:');
  console.log('');
  console.log('  ' + authUrl);
  console.log('');
  console.log('  PASO 2: Autorizá el acceso con tu cuenta riki@sarti.com.ar');
  console.log('');
  console.log('  PASO 3: El navegador redirige a http://localhost/?code=XXXX');
  console.log('  (va a mostrar un error de conexión — es normal)');
  console.log('  Copiá el valor del parámetro "code" de la URL.');
  console.log('════════════════════════════════════════════════════════════════\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('Pegá el código aquí y presioná Enter: ', async (rawCode) => {
    rl.close();

    try {
      const code = decodeURIComponent(rawCode.trim());
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        console.error('\n❌ No se recibió refresh_token.');
        console.error('   Probablemente ya autorizaste antes esta app.');
        console.error('   Revocá el acceso en: https://myaccount.google.com/permissions');
        console.error('   Buscá la app, eliminá el permiso, y volvé a correr este script.\n');
        process.exit(1);
      }

      // Guardar refresh_token en el .env
      const envPath = path.join(__dirname, '../.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

      if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }

      fs.writeFileSync(envPath, envContent);

      console.log('\n✅ Autorización exitosa!');
      console.log(`   refresh_token: ${tokens.refresh_token.substring(0, 20)}...`);
      console.log('   GOOGLE_REFRESH_TOKEN guardado en .env');
      console.log('   Reiniciá el bot para que use Google Calendar.\n');

    } catch (error) {
      console.error('\n❌ Error al canjear el código:', error.message);
      if (error.message.includes('invalid_grant')) {
        console.error('   El código ya fue usado o expiró. Volvé a correr el script.\n');
      }
      process.exit(1);
    }
  });
}

main();
