-- Repair and harden the SolarPower WhatsApp agent after the Supabase migration.
-- This migration is intentionally backwards compatible with the currently
-- deployed functions so it can be applied while the bot remains enabled.

alter table public.agent_contacts
  add column if not exists province text,
  add column if not exists agent_state jsonb not null default '{}'::jsonb;

alter table public.chatbot_wa_contacts
  add column if not exists agent_state jsonb not null default '{}'::jsonb;

alter table public.agent_inbound_events
  add column if not exists disposition text,
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists disposition_at timestamptz;

alter table public.agent_outbound_messages
  add column if not exists dedupe_key text,
  add column if not exists kind text not null default 'customer_reply',
  add column if not exists chunk_index integer not null default 0,
  add column if not exists chunk_count integer not null default 1,
  add column if not exists attempts integer not null default 0,
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists agent_outbound_dedupe_idx
  on public.agent_outbound_messages(dedupe_key);
create index if not exists agent_outbound_due_idx
  on public.agent_outbound_messages(status, available_at);

create table if not exists public.agent_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  phone text,
  outcome text not null check (outcome in ('accepted', 'duplicate', 'ignored', 'rejected', 'error')),
  reason text,
  inbound_event_id uuid references public.agent_inbound_events(id) on delete set null,
  payload_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists agent_webhook_receipts_recent_idx
  on public.agent_webhook_receipts(received_at desc);
create index if not exists agent_webhook_receipts_outcome_idx
  on public.agent_webhook_receipts(outcome, received_at desc);
create index if not exists agent_webhook_receipts_event_idx
  on public.agent_webhook_receipts(provider, provider_event_id, received_at desc);

create table if not exists public.agent_daily_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null unique,
  recipient text not null,
  subject text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  provider_message_id text,
  summary jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists agent_daily_reports_due_idx
  on public.agent_daily_reports(status, available_at);

alter table public.agent_webhook_receipts enable row level security;
alter table public.agent_daily_reports enable row level security;

drop policy if exists agent_webhook_receipts_service on public.agent_webhook_receipts;
create policy agent_webhook_receipts_service on public.agent_webhook_receipts
  for all to service_role using (true) with check (true);
drop policy if exists agent_daily_reports_service on public.agent_daily_reports;
create policy agent_daily_reports_service on public.agent_daily_reports
  for all to service_role using (true) with check (true);

revoke all on public.agent_webhook_receipts, public.agent_daily_reports
  from public, anon, authenticated;
grant all on public.agent_webhook_receipts, public.agent_daily_reports to service_role;

insert into public.agent_settings (key, value, is_secret)
values
  ('conversation_engine_version', 'v2', false),
  ('daily_report_enabled', 'true', false),
  ('daily_report_email', 'riki@sarti.com.ar', false),
  ('daily_report_hour_ar', '8', false),
  ('crm_base_url', 'https://solarpower.com.ar/admin/crm/leads', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();

-- Public-schema RPCs are SECURITY INVOKER and executable only by service_role.
-- They exist in public because PostgREST RPC does not expose the private schema.
create or replace function public.agent_enqueue_phone(
  p_phone text,
  p_delay_seconds integer default 20
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  pending_id uuid;
begin
  if length(normalized) < 8 or length(normalized) > 15 then
    raise exception 'invalid phone';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent:' || normalized, 0));

  select id into pending_id
  from public.agent_jobs
  where job_type = 'process_inbound'
    and payload->>'phone' = normalized
    and status = 'pending'
  order by created_at desc
  limit 1;

  if pending_id is not null then
    update public.agent_jobs
    set available_at = now() + make_interval(secs => greatest(0, p_delay_seconds)),
        attempts = 0,
        last_error = null,
        updated_at = now()
    where id = pending_id;
    return pending_id;
  end if;

  insert into public.agent_jobs (
    dedupe_key, job_type, payload, status, available_at
  ) values (
    'inbound:' || normalized || ':' || gen_random_uuid()::text,
    'process_inbound', jsonb_build_object('phone', normalized), 'pending',
    now() + make_interval(secs => greatest(0, p_delay_seconds))
  ) returning id into pending_id;
  return pending_id;
end;
$$;

create or replace function public.agent_claim_jobs(p_limit integer default 10)
returns setof public.agent_jobs
language sql
security invoker
set search_path = ''
as $$
  with selected as (
    select id
    from public.agent_jobs
    where status = 'pending' and available_at <= now()
    order by available_at, created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.agent_jobs as job
  set status = 'processing', locked_at = now(), updated_at = now()
  from selected
  where job.id = selected.id
  returning job.*;
$$;

create or replace function public.agent_ensure_contact(
  p_phone text,
  p_name text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  crm public.chatbot_wa_contacts%rowtype;
begin
  if length(normalized) < 8 or length(normalized) > 15 then
    raise exception 'invalid phone';
  end if;

  insert into public.chatbot_wa_contacts (
    phone, name, label, stage, bill_received, human_mode,
    notified_ricardo, first_contact, last_contact, last_activity_at
  ) values (
    normalized, nullif(trim(p_name), ''), 'Interesado', 'nuevo', false, false,
    false, now(), now(), now()
  )
  on conflict (phone) do update set
    name = coalesce(public.chatbot_wa_contacts.name, nullif(trim(excluded.name), '')),
    last_contact = now(),
    last_activity_at = now()
  returning * into crm;

  insert into public.agent_contacts (
    phone, name, email, label, stage, tipo, bill_received, roof_type,
    connection_type, locality, province, product_interest, notes,
    notified_ricardo, human_mode, first_contact, last_contact, agent_state
  ) values (
    crm.phone, crm.name, crm.email, coalesce(crm.label, 'Interesado'),
    coalesce(crm.stage, 'nuevo'), crm.tipo, coalesce(crm.bill_received, false),
    crm.roof_type, crm.connection_type, crm.locality, crm.province,
    crm.product_interest, crm.notes, coalesce(crm.notified_ricardo, false),
    coalesce(crm.human_mode, false), coalesce(crm.first_contact, now()),
    coalesce(crm.last_contact, now()), coalesce(crm.agent_state, '{}'::jsonb)
  )
  on conflict (phone) do update set
    name = excluded.name,
    email = excluded.email,
    label = excluded.label,
    stage = excluded.stage,
    tipo = excluded.tipo,
    bill_received = excluded.bill_received,
    roof_type = excluded.roof_type,
    connection_type = excluded.connection_type,
    locality = excluded.locality,
    province = excluded.province,
    product_interest = excluded.product_interest,
    notes = excluded.notes,
    notified_ricardo = excluded.notified_ricardo,
    human_mode = excluded.human_mode,
    first_contact = excluded.first_contact,
    last_contact = excluded.last_contact,
    agent_state = excluded.agent_state,
    updated_at = now();

  return to_jsonb(crm);
end;
$$;

create or replace function public.agent_apply_contact_state(
  p_phone text,
  p_patch jsonb,
  p_task_title text default null,
  p_task_description text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  crm public.chatbot_wa_contacts%rowtype;
  requested_stage text := nullif(p_patch->>'stage', '');
begin
  perform public.agent_ensure_contact(normalized, p_patch->>'name');

  update public.chatbot_wa_contacts as contact
  set
    name = case when p_patch ? 'name' then coalesce(nullif(trim(p_patch->>'name'), ''), contact.name) else contact.name end,
    email = case when p_patch ? 'email' then coalesce(nullif(trim(p_patch->>'email'), ''), contact.email) else contact.email end,
    label = case when p_patch ? 'label' then coalesce(nullif(trim(p_patch->>'label'), ''), contact.label) else contact.label end,
    stage = case
      when requested_stage is null then contact.stage
      when requested_stage = 'pendiente_presupuesto'
        and coalesce(contact.stage, 'nuevo') in ('nuevo', 'contactado', 'calificado', 'interior', 'pendiente_presupuesto')
        then requested_stage
      when requested_stage <> 'pendiente_presupuesto'
        and coalesce(contact.stage, 'nuevo') in ('nuevo', 'contactado', 'calificado', 'interior')
        then requested_stage
      else contact.stage
    end,
    bandeja = case
      when p_patch ? 'tipo' and coalesce(contact.bandeja_source, 'auto') = 'auto' then
        case p_patch->>'tipo'
          when 'academia' then 'academia'
          when 'cv' then 'rrhh'
          when 'soporte' then 'ingenieria'
          else 'ventas'
        end
      else contact.bandeja
    end,
    tipo_cliente = case
      when p_patch ? 'tipo' then
        case p_patch->>'tipo'
          when 'comercial' then 'empresa'
          when 'academia' then 'academia'
          when 'cv' then 'cv'
          else 'residencial'
        end
      else contact.tipo_cliente
    end,
    tipo = case when p_patch ? 'tipo' then coalesce(nullif(p_patch->>'tipo', ''), contact.tipo) else contact.tipo end,
    bill_received = case when p_patch ? 'bill_received' then (p_patch->>'bill_received')::boolean else contact.bill_received end,
    roof_type = case when p_patch ? 'roof_type' then coalesce(nullif(p_patch->>'roof_type', ''), contact.roof_type) else contact.roof_type end,
    connection_type = case when p_patch ? 'connection_type' then coalesce(nullif(p_patch->>'connection_type', ''), contact.connection_type) else contact.connection_type end,
    locality = case when p_patch ? 'locality' then coalesce(nullif(p_patch->>'locality', ''), contact.locality) else contact.locality end,
    province = case when p_patch ? 'province' then coalesce(nullif(p_patch->>'province', ''), contact.province) else contact.province end,
    product_interest = case when p_patch ? 'product_interest' then coalesce(nullif(p_patch->>'product_interest', ''), contact.product_interest) else contact.product_interest end,
    notes = case when p_patch ? 'notes' then coalesce(nullif(p_patch->>'notes', ''), contact.notes) else contact.notes end,
    human_mode = case when p_patch ? 'human_mode' then (p_patch->>'human_mode')::boolean else contact.human_mode end,
    notified_ricardo = case when p_patch ? 'notified_ricardo' then (p_patch->>'notified_ricardo')::boolean else contact.notified_ricardo end,
    consumo_mensual = case when p_patch ? 'consumo_mensual' and (p_patch->>'consumo_mensual') ~ '^[0-9]+([.][0-9]+)?$' then (p_patch->>'consumo_mensual')::numeric else contact.consumo_mensual end,
    consumo_anual = case when p_patch ? 'consumo_anual' and (p_patch->>'consumo_anual') ~ '^[0-9]+([.][0-9]+)?$' then (p_patch->>'consumo_anual')::numeric else contact.consumo_anual end,
    agent_state = coalesce(contact.agent_state, '{}'::jsonb) || coalesce(p_patch->'agent_state', '{}'::jsonb),
    last_contact = now(),
    last_activity_at = now(),
    updated_at = now()
  where contact.phone = normalized
  returning * into crm;

  perform public.agent_ensure_contact(normalized, crm.name);

  if nullif(trim(p_task_title), '') is not null and not exists (
    select 1 from public.crm_tasks
    where lead_phone = normalized
      and estado in ('pendiente', 'en_progreso', 'revision')
      and lower(titulo) = lower(trim(p_task_title))
  ) then
    insert into public.crm_tasks (
      titulo, descripcion, estado, prioridad, lead_phone, asignado_a, tipo
    ) values (
      trim(p_task_title), nullif(trim(p_task_description), ''), 'pendiente',
      'alta', normalized, crm.assigned_to,
      case when lower(trim(p_task_title)) = 'enviar presupuesto' then 'presupuesto' else 'seguimiento' end
    );
  end if;

  select * into crm from public.chatbot_wa_contacts where phone = normalized;
  return to_jsonb(crm);
end;
$$;

revoke all on function public.agent_enqueue_phone(text, integer) from public, anon, authenticated;
revoke all on function public.agent_claim_jobs(integer) from public, anon, authenticated;
revoke all on function public.agent_ensure_contact(text, text) from public, anon, authenticated;
revoke all on function public.agent_apply_contact_state(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.agent_enqueue_phone(text, integer) to service_role;
grant execute on function public.agent_claim_jobs(integer) to service_role;
grant execute on function public.agent_ensure_contact(text, text) to service_role;
grant execute on function public.agent_apply_contact_state(text, jsonb, text, text) to service_role;

-- The agent runtime needs the Resend key, but it is read only from Edge secrets
-- or Vault. No credential value is stored in the migration.
create or replace function public.agent_get_runtime_secret(p_name text)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  result text;
begin
  if p_name not in (
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'RESEND_API_KEY', 'AGENT_INTERNAL_PHONES',
    'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET', 'SENDPULSE_BOT_ID',
    'META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN',
    'META_PHONE_NUMBER_ID', 'META_GRAPH_API_VERSION',
    'AGENT_RICARDO_PHONE', 'AGENT_AGENDA_PHONE', 'AGENT_GUILLERMO_PHONE',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'
  ) then
    raise exception 'Runtime secret is not allowed';
  end if;
  select decrypted_secret into result
  from vault.decrypted_secrets
  where name = 'agent_' || p_name
  limit 1;
  return result;
end;
$$;

create or replace function public.agent_set_runtime_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if p_name not in (
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'RESEND_API_KEY', 'AGENT_INTERNAL_PHONES',
    'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET', 'SENDPULSE_BOT_ID',
    'META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN',
    'META_PHONE_NUMBER_ID', 'META_GRAPH_API_VERSION',
    'AGENT_RICARDO_PHONE', 'AGENT_AGENDA_PHONE', 'AGENT_GUILLERMO_PHONE',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'
  ) then
    raise exception 'Runtime secret is not allowed';
  end if;
  select id into secret_id from vault.decrypted_secrets
  where name = 'agent_' || p_name limit 1;
  if secret_id is null then
    perform vault.create_secret(p_value, 'agent_' || p_name, 'SolarPower agent runtime secret');
  else
    perform vault.update_secret(secret_id, p_value, 'agent_' || p_name, 'SolarPower agent runtime secret');
  end if;
end;
$$;

revoke all on function public.agent_get_runtime_secret(text) from public, anon, authenticated;
revoke all on function public.agent_set_runtime_secret(text, text) from public, anon, authenticated;
grant execute on function public.agent_get_runtime_secret(text) to service_role;
grant execute on function public.agent_set_runtime_secret(text, text) to service_role;

alter table public.energy_analysis_jobs
  drop constraint if exists energy_analysis_jobs_status_check;
alter table public.energy_analysis_jobs
  add constraint energy_analysis_jobs_status_check
  check (status in ('pending', 'pending_delivery', 'processing', 'completed', 'failed', 'skipped', 'needs_review'));

create or replace function private.energy_queue_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_phone is not null
     and lower(coalesce(new.kind, '')) = 'invoice'
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and lower(coalesce(old.kind, '')) <> 'invoice')) then
    insert into public.energy_analysis_jobs (dedupe_key, phone, source_file_id, input)
    values (
      'crm_lead_file:' || new.id::text,
      regexp_replace(new.contact_phone, '[^0-9]', '', 'g'),
      new.id,
      jsonb_build_object('source', 'crm_lead_files', 'analysis_version', 'v2')
    )
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.energy_queue_invoice() from public, anon, authenticated;

drop trigger if exists energy_queue_invoice on public.crm_lead_files;
create trigger energy_queue_invoice
after insert or update of kind on public.crm_lead_files
for each row execute function private.energy_queue_invoice();

-- Reconcile CRM contacts into the non-nullable compatibility cache.
insert into public.agent_contacts (
  phone, name, email, label, stage, tipo, bill_received, roof_type,
  connection_type, locality, province, product_interest, notes,
  notified_ricardo, human_mode, first_contact, last_contact, agent_state
)
select
  crm.phone, crm.name, crm.email, coalesce(crm.label, 'Interesado'),
  coalesce(crm.stage, 'nuevo'), crm.tipo, coalesce(crm.bill_received, false),
  crm.roof_type, crm.connection_type, crm.locality, crm.province,
  crm.product_interest, crm.notes, coalesce(crm.notified_ricardo, false),
  coalesce(crm.human_mode, false), coalesce(crm.first_contact, now()),
  coalesce(crm.last_contact, now()), coalesce(crm.agent_state, '{}'::jsonb)
from public.chatbot_wa_contacts crm
where crm.phone is not null and length(regexp_replace(crm.phone, '[^0-9]', '', 'g')) between 8 and 15
on conflict (phone) do update set
  name = excluded.name,
  email = excluded.email,
  label = excluded.label,
  stage = excluded.stage,
  tipo = excluded.tipo,
  bill_received = excluded.bill_received,
  roof_type = excluded.roof_type,
  connection_type = excluded.connection_type,
  locality = excluded.locality,
  province = excluded.province,
  product_interest = excluded.product_interest,
  notes = excluded.notes,
  notified_ricardo = excluded.notified_ricardo,
  human_mode = excluded.human_mode,
  first_contact = excluded.first_contact,
  last_contact = excluded.last_contact,
  agent_state = excluded.agent_state,
  updated_at = now();

-- Apply the control command that was missed during the regression.
select public.agent_apply_contact_state(
  '5491152471902',
  jsonb_build_object('human_mode', true, 'label', 'Interesado'),
  null,
  null
);

-- Old unprocessed messages must not receive a surprising automatic reply.
select public.agent_ensure_contact(stale.phone, stale.name)
from (
  select phone, max(contact_name) filter (where contact_name is not null) as name
  from public.agent_inbound_events
  where processed_at is null and received_at < now() - interval '30 minutes'
  group by phone
) stale;

with stale as (
  select distinct phone
  from public.agent_inbound_events
  where processed_at is null and received_at < now() - interval '30 minutes'
)
update public.chatbot_wa_contacts contact
set human_mode = true, updated_at = now(), last_activity_at = now()
from stale
where contact.phone = stale.phone;

with stale as (
  select distinct event.phone, coalesce(contact.name, event.contact_name) as name,
    coalesce(contact.assigned_to, null) as assigned_to
  from public.agent_inbound_events event
  left join public.chatbot_wa_contacts contact on contact.phone = event.phone
  where event.processed_at is null and event.received_at < now() - interval '30 minutes'
)
insert into public.crm_tasks (
  titulo, descripcion, estado, prioridad, lead_phone, asignado_a, tipo
)
select
  case when stale.name is null then 'Responder mensaje pendiente' else 'Responder a ' || stale.name end,
  'El bot no pudo responder este mensaje. Revisar la conversación y contestar manualmente.',
  'pendiente', 'alta', stale.phone, stale.assigned_to, 'seguimiento'
from stale
where not exists (
  select 1 from public.crm_tasks task
  where task.lead_phone = stale.phone
    and task.estado in ('pendiente', 'en_progreso', 'revision')
    and lower(task.titulo) like 'responder%'
);

update public.agent_inbound_events
set processed_at = now(),
    disposition = 'human_handoff',
    disposition_at = now(),
    processing_error = 'Mensaje anterior al despliegue derivado para respuesta humana'
where processed_at is null and received_at < now() - interval '30 minutes';

update public.agent_contacts agent
set human_mode = crm.human_mode,
    updated_at = now()
from public.chatbot_wa_contacts crm
where crm.phone = agent.phone;
