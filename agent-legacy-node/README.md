# SolarPower WhatsApp Agent

Agente de WhatsApp para **SolarPower Energy S.A.S** construido con Node.js + Claude AI + SendPulse.

---

## Arquitectura

```
index.js          → Servidor Express + webhook
agent.js          → Orquestador del flujo principal
claude.js         → Cliente Claude AI con historial
sendpulse.js      → Cliente SendPulse (OAuth2 + envío de mensajes)
database.js       → SQLite: contactos, mensajes, acciones pendientes
classifier.js     → Clasificador de intención (keywords, sin IA)
notifier.js       → Notificaciones a Ricardo via WhatsApp
logger.js         → Winston (consola + archivos)
prompts/system.js → System prompt completo del agente
```

---

## Setup inicial

### 1. Instalar dependencias

```bash
cd solarpower-agent
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con las credenciales reales:

```
ANTHROPIC_API_KEY=sk-ant-...
SENDPULSE_API_ID=tu_id
SENDPULSE_API_SECRET=tu_secret
RICARDO_PHONE=5491134583958
PORT=3000
```

### 3. Crear carpeta de datos

```bash
mkdir data
```

(La DB se crea automáticamente al arrancar el servidor.)

### 4. Arrancar el servidor

```bash
npm start
```

O en modo desarrollo (recarga automática):

```bash
npm run dev
```

### 5. Correr los tests

```bash
node test.js
```

---

## Configurar el webhook en SendPulse

### URL del webhook

| Entorno | URL |
|---------|-----|
| Local (ngrok) | `https://XXXX.ngrok.io/webhook/whatsapp` |
| Railway | `https://tu-app.railway.app/webhook/whatsapp` |
| Render | `https://tu-app.onrender.com/webhook/whatsapp` |
| VPS propio | `https://tu-dominio.com/webhook/whatsapp` |

### Pasos en SendPulse

1. Entrar a [app.sendpulse.com](https://app.sendpulse.com)
2. Ir a **Chatbots → WhatsApp → tu bot**
3. Ir a **Configuración → Webhook**
4. Pegar la URL: `[TU_URL]/webhook/whatsapp`
5. Seleccionar evento: **"Mensaje entrante"**
6. Guardar

---

## Testing local con ngrok

```bash
# Instalar ngrok (una sola vez)
npm install -g ngrok

# En terminal 1: arrancar el bot
npm start

# En terminal 2: exponer al exterior
ngrok http 3000
```

ngrok te dará una URL pública como `https://abc123.ngrok.io`.
Usá esa URL en SendPulse: `https://abc123.ngrok.io/webhook/whatsapp`

---

## Deploy en Railway (recomendado)

1. Subir el código a GitHub **sin el archivo `.env`**
2. Ir a [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Seleccionar el repositorio
4. En el dashboard de Railway, ir a **Variables** y agregar todas las variables del `.env`
5. Railway genera automáticamente una URL pública → usarla como webhook en SendPulse

---

## Endpoints disponibles

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/webhook/whatsapp` | POST | Recibe mensajes de SendPulse |
| `/health` | GET | Estado del servidor |
| `/dashboard` | GET | Resumen de contactos y métricas |

---

## Estructura de la base de datos

```sql
contacts        → Datos de cada cliente/lead
messages        → Historial completo de conversaciones
pending_actions → Acciones que Ricardo debe tomar
```

---

## Resetear la base de datos (solo desarrollo)

```bash
npm run db:reset
```

---

## Logs

Los logs se guardan en la carpeta `logs/`:
- `logs/app.log` → todos los eventos
- `logs/error.log` → solo errores

---

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | API key de Anthropic |
| `SENDPULSE_API_ID` | ✅ | ID de la aplicación SendPulse |
| `SENDPULSE_API_SECRET` | ✅ | Secret de la aplicación SendPulse |
| `RICARDO_PHONE` | ✅ | Número de WhatsApp de Ricardo (sin +) |
| `PORT` | ❌ | Puerto del servidor (default: 3000) |
| `DB_PATH` | ❌ | Ruta a la DB SQLite (default: ./data/solarpower.db) |
| `LOG_LEVEL` | ❌ | Nivel de logs: error/warn/info/debug (default: info) |
| `SENDPULSE_BOT_ID` | ❌ | ID del bot (se auto-detecta si no se especifica) |
| `NODE_ENV` | ❌ | Entorno: development/production |
