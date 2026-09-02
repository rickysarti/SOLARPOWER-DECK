# SOLARPOWER-DECK

Agente de WhatsApp de SolarPower migrado a Supabase Edge Functions, Postgres,
Storage y Cron. No requiere un servidor Node encendido permanentemente.

## Estado

- El codigo Node original sanitizado esta en `agent-legacy-node/` como referencia.
- La nueva implementacion vive en `supabase/`.
- Todos los recursos propios usan el prefijo `agent_` o `agent-`.
- Produccion usa SendPulse y el bot se ejecuta enteramente en Supabase.
- Meta queda implementado como proveedor alternativo para una migracion futura.

## Flujo

1. SendPulse envia el webhook a `agent-sendpulse-webhook`.
2. El webhook valida su secreto, guarda el evento y programa un trabajo con 20
   segundos de buffer por contacto.
3. `agent-process-queue` agrupa mensajes, consulta el historial, llama a Claude
   y responde mediante la API de WhatsApp de SendPulse.
4. `agent-cron` corre cada minuto como respaldo, procesa reintentos y avisos de
   agenda.

## Funciones

- `agent-sendpulse-webhook`: webhook publico de SendPulse con secreto propio.
- `agent-whatsapp-webhook`: webhook alternativo de Meta con verificacion HMAC.
- `agent-process-queue`: procesador interno autenticado por secreto.
- `agent-cron`: trabajos programados, reintentos y recordatorios.
- `agent-health`: diagnostico sin exponer secretos ni datos personales.
- `agent-admin-api`: API del CRM protegida para perfiles `ADMIN` del sitio.

## Compatibilidad con el CRM actual

El agente mantiene `agent_*` como fuente operativa aislada y sincroniza los
contactos, mensajes, agenda y acciones hacia las tablas `chatbot_*` que ya usa
el frontend de SolarPower. Antes de responder, tambien lee `human_mode` y los
datos editables desde `chatbot_wa_contacts`, por lo que pausar o liberar el bot
desde el CRM actual sigue funcionando.

## Configuracion

Los secretos del agente se guardan cifrados en Supabase Vault con prefijo
`agent_`. No se guardan tokens en Git ni se exponen al frontend.

El proveedor se selecciona en `agent_settings.whatsapp_provider`. El webhook de
SendPulse es `agent-sendpulse-webhook` y su URL contiene el secreto almacenado
en `agent_settings.sendpulse_webhook_secret`.

El webhook alternativo de Meta es:

`https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/agent-whatsapp-webhook`

Para pausar globalmente o reactivar el bot:

```sql
update public.agent_settings
set value = 'false' -- cambiar a true para reactivar
where key = 'bot_enabled';
```

## Desarrollo

El proyecto remoto usa Postgres 15. Supabase CLI crea y prueba las migraciones:

```bash
supabase start
supabase db reset
supabase functions serve --env-file .env.local
```

## Seguridad

Las tablas `agent_*` tienen RLS habilitado y no conceden acceso a `anon` ni a
usuarios autenticados. Las Edge Functions operan con `service_role`, que nunca
se envia al navegador. El bucket `agent-files` es privado.
