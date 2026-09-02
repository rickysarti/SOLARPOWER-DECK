# Meta WhatsApp Cloud API

Esta es la guia para la migracion futura desde SendPulse a la API oficial de
Meta. Actualmente produccion sigue usando SendPulse desde Supabase.

## Datos necesarios

- ID de la cuenta de WhatsApp Business (WABA ID).
- ID del numero de telefono (Phone Number ID).
- Numero de WhatsApp que se va a usar y confirmacion de si hoy esta conectado a
  SendPulse.
- App Secret de la aplicacion de Meta.
- Token permanente de un System User con permisos
  `whatsapp_business_messaging` y `whatsapp_business_management`.

El token de verificacion del webhook puede generarse durante la configuracion;
no tiene que ser el token de acceso de Meta.

## Secretos de Supabase

Guardar estos valores en Edge Functions > Secrets:

```text
META_ACCESS_TOKEN
META_APP_SECRET
META_VERIFY_TOKEN
META_PHONE_NUMBER_ID
META_GRAPH_API_VERSION
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
AGENT_RICARDO_PHONE
AGENT_AGENDA_PHONE
AGENT_GUILLERMO_PHONE
GOOGLE_CALENDAR_ID
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

Los valores sensibles no deben pegarse en GitHub, archivos versionados ni el
frontend.

## Webhook

URL:

```text
https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/agent-whatsapp-webhook
```

Suscribir el campo `messages` y usar el mismo valor de `META_VERIFY_TOKEN` como
verify token en Meta y Supabase.

## Corte

1. Cargar secretos y verificar el webhook.
2. Probar con el numero de prueba de Meta.
3. Confirmar que los mensajes aparecen en `agent_*` y `chatbot_*`.
4. Desconectar o migrar el numero desde SendPulse.
5. Cambiar `agent_settings.whatsapp_provider` a `meta`.

El bot permanece apagado hasta el ultimo paso, de modo que no responde en
paralelo con la instalacion actual.
