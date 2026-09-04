# SOLARPOWER-DECK

Automatizaciones de SolarPower migradas a Supabase Edge Functions, Postgres,
Storage y Cron. No requieren un servidor Windows o Node encendido permanentemente.

## Estado

- El codigo Node original sanitizado esta en `agent-legacy-node/` como referencia.
- La nueva implementacion vive en `supabase/`.
- Todos los recursos propios usan el prefijo `agent_` o `agent-`.
- Produccion usa SendPulse y el bot se ejecuta enteramente en Supabase.
- Meta queda implementado como proveedor alternativo para una migracion futura.
- `energy-analyze` procesa facturas nuevas y guarda el resultado solamente en
  el analisis energetico del lead dentro del CRM de Supabase.
- `newapp-cron` monitorea inversores, consolida energia, actualiza UVA,
  descubre plantas y envia el reporte matutino mediante SendPulse.

## Flujo

1. SendPulse envia el webhook a `agent-sendpulse-webhook`.
2. El webhook valida su secreto, guarda el evento y programa un trabajo con 5
   segundos de buffer por contacto.
3. `agent-process-queue` agrupa mensajes, consulta el historial, llama a Claude
   y responde mediante la API de WhatsApp de SendPulse.
4. `agent-cron` concilia los chats recientes con el historial de SendPulse y
   recupera mensajes entrantes cuyo webhook no haya llegado.
5. `agent-cron` corre cada minuto como respaldo, procesa reintentos y avisos de
   agenda.

## Funciones

- `agent-sendpulse-webhook`: webhook publico de SendPulse con secreto propio.
- `agent-whatsapp-webhook`: webhook alternativo de Meta con verificacion HMAC.
- `agent-process-queue`: procesador interno autenticado por secreto.
- `agent-cron`: trabajos programados, reintentos y recordatorios.
- `agent-health`: diagnostico sin exponer secretos ni datos personales.
- `agent-admin-api`: API del CRM protegida para perfiles `ADMIN` del sitio.
- `energy-analyze`: cola y endpoint interno del analizador energetico.
- `newapp-cron`: ejecutor autenticado de todas las tareas automaticas NEWAPP.

## Analisis energetico

Las facturas nuevas insertadas en `crm_lead_files` con `kind = 'invoice'` se
encolan automaticamente. El cron procesa hasta dos por ejecucion, combina el
archivo con el historial de WhatsApp y el contacto del CRM, ejecuta triage y
analisis con Claude, y actualiza los campos `energy_*` del contacto. El resultado
no se envia por SendPulse: queda asociado exclusivamente al lead en Supabase.
El agente de WhatsApp descarga las imagenes y PDF recibidos, identifica las
facturas electricas, marca `bill_received`, conserva el archivo en el CRM y lo
conecta con esta cola sin depender de un proceso Windows en memoria.
La migracion no encola facturas historicas para evitar costos o avisos masivos
inesperados; si se desea, ese lote se puede habilitar por separado.

El endpoint acepta tambien JSON o `multipart/form-data`, siempre autenticado
con `x-energy-cron-secret`. Los PDF se pasan a Claude como documentos nativos,
por lo que se conservan tablas y graficos sin depender de `pdf-parse` o `sharp`.

## NEWAPP

Supabase Cron reemplaza `node-cron`, PM2 y los scripts de Windows:

- DEYE, FusionSolar, SEMS/GoodWe y Growatt: cada 5 minutos de dia y una vez por
  hora durante la noche argentina.
- Enphase: cron cada 15 minutos, con filtro persistente de horarios y limite
  diario para cuidar la cuota de API.
- Consolidacion del dia cada 30 minutos; cierre diario y agregado mensual.
- Descubrimiento diario de plantas, actualizacion UVA y reporte de las 08:00 AR.

Cada corrida se registra en `newapp_bot_runs`, lo que evita duplicados aunque
Supabase reintente una invocacion. Los errores por sistema se guardan en las
tablas existentes de alarmas y uso de API.

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

Los dos runtimes nuevos usan namespaces Vault separados (`energy_*` y
`newapp_*`). Para importar las credenciales historicas sin imprimir valores:

```bash
python3 scripts/import_bot_runtime_secrets.py \
  --energy-env /ruta/SOLARPOWER-ANALISIS-ENERGETICO/.env \
  --newapp-env /ruta/NEWAPP/.env
```

Luego de desplegar y verificar, se activan con:

```sql
update public.energy_analysis_settings set value = 'true' where key = 'enabled';
update public.newapp_bot_settings set value = 'true' where key = 'enabled';
```

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
