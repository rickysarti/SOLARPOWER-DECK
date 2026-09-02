# SOLARPOWER-DECK

Agente de WhatsApp de SolarPower migrado a Supabase Edge Functions, Postgres,
Storage y Cron. No requiere un servidor Node encendido permanentemente.

## Estado

- El codigo Node original sanitizado esta en `agent-legacy-node/` como referencia.
- La nueva implementacion vive en `supabase/`.
- Todos los recursos propios usan el prefijo `agent_` o `agent-`.
- El bot nace desactivado (`agent_settings.bot_enabled = false`) para permitir
  migrar y probar sin interferir con el sistema actual.

## Flujo

1. Meta envia el webhook a `agent-whatsapp-webhook`.
2. El webhook valida la firma, guarda el evento y programa un trabajo con 20
   segundos de buffer por contacto.
3. `agent-process-queue` agrupa mensajes, consulta el historial, llama a Claude
   y responde mediante WhatsApp Cloud API.
4. `agent-cron` corre cada minuto como respaldo, procesa reintentos y avisos de
   agenda.

## Funciones

- `agent-whatsapp-webhook`: webhook publico de Meta con verificacion HMAC.
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

Crear los secretos listados en `.env.example` desde Supabase Dashboard, en
Project Settings > Edge Functions > Secrets. No se deben guardar tokens en Git.

El webhook de Meta sera:

`https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/agent-whatsapp-webhook`

Antes del corte definitivo, verificar el webhook y luego activar el bot:

```sql
update public.agent_settings
set value = 'true'
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
