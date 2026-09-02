-- SolarPower energy-analysis and NEWAPP automation runtimes.
-- Both runtimes are isolated from the existing agent_* deployment and keep
-- their credentials encrypted in Vault.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.energy_analysis_settings (
  key text primary key,
  value text not null,
  is_secret boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.energy_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text unique,
  phone text not null,
  source_file_id uuid,
  input jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'pending_delivery', 'processing', 'completed', 'failed', 'skipped')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  triage jsonb,
  result jsonb,
  model_used text,
  sendpulse_status text,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists energy_analysis_jobs_due_idx
  on public.energy_analysis_jobs(status, available_at);
create index if not exists energy_analysis_jobs_phone_idx
  on public.energy_analysis_jobs(phone, created_at desc);

create table if not exists public.newapp_bot_settings (
  key text primary key,
  value text not null,
  is_secret boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.newapp_bot_runs (
  id uuid primary key default gen_random_uuid(),
  task text not null,
  scheduled_bucket timestamptz not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed', 'skipped')),
  processed integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  last_error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (task, scheduled_bucket)
);

create index if not exists newapp_bot_runs_recent_idx
  on public.newapp_bot_runs(task, started_at desc);

create table if not exists public.newapp_bot_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.energy_analysis_settings (key, value, is_secret)
values
  ('enabled', 'false', false),
  ('auto_queue_enabled', 'true', false),
  ('cron_secret', encode(gen_random_bytes(32), 'hex'), true),
  ('delivery_provider', 'sendpulse', false)
on conflict (key) do nothing;

insert into public.newapp_bot_settings (key, value, is_secret)
values
  ('enabled', 'false', false),
  ('cron_secret', encode(gen_random_bytes(32), 'hex'), true),
  ('night_start_hour_ar', '19', false),
  ('night_end_hour_ar', '7', false),
  ('enphase_daily_request_limit', '450', false)
on conflict (key) do nothing;

alter table public.energy_analysis_settings enable row level security;
alter table public.energy_analysis_jobs enable row level security;
alter table public.newapp_bot_settings enable row level security;
alter table public.newapp_bot_runs enable row level security;
alter table public.newapp_bot_state enable row level security;

create policy energy_analysis_settings_service on public.energy_analysis_settings
  for all to service_role using (true) with check (true);
create policy energy_analysis_jobs_service on public.energy_analysis_jobs
  for all to service_role using (true) with check (true);
create policy newapp_bot_settings_service on public.newapp_bot_settings
  for all to service_role using (true) with check (true);
create policy newapp_bot_runs_service on public.newapp_bot_runs
  for all to service_role using (true) with check (true);
create policy newapp_bot_state_service on public.newapp_bot_state
  for all to service_role using (true) with check (true);

revoke all on public.energy_analysis_settings, public.energy_analysis_jobs,
  public.newapp_bot_settings, public.newapp_bot_runs, public.newapp_bot_state
  from public, anon, authenticated;
grant all on public.energy_analysis_settings, public.energy_analysis_jobs,
  public.newapp_bot_settings, public.newapp_bot_runs, public.newapp_bot_state
  to service_role;

create or replace function public.energy_get_runtime_secret(p_name text)
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
    'ANTHROPIC_API_KEY', 'ENERGY_TRIAGE_MODEL', 'ENERGY_ANALYSIS_MODEL',
    'ANALYSIS_REPORT_PHONES', 'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET',
    'SENDPULSE_BOT_ID'
  ) then
    raise exception 'Energy runtime secret is not allowed';
  end if;
  select decrypted_secret into result
  from vault.decrypted_secrets
  where name = 'energy_' || p_name
  limit 1;
  return result;
end;
$$;

create or replace function public.energy_set_runtime_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if p_name not in (
    'ANTHROPIC_API_KEY', 'ENERGY_TRIAGE_MODEL', 'ENERGY_ANALYSIS_MODEL',
    'ANALYSIS_REPORT_PHONES', 'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET',
    'SENDPULSE_BOT_ID'
  ) then
    raise exception 'Energy runtime secret is not allowed';
  end if;
  select id into secret_id from vault.decrypted_secrets
  where name = 'energy_' || p_name limit 1;
  if secret_id is null then
    perform vault.create_secret(p_value, 'energy_' || p_name, 'SolarPower energy analysis runtime secret');
  else
    perform vault.update_secret(secret_id, p_value, 'energy_' || p_name, 'SolarPower energy analysis runtime secret');
  end if;
end;
$$;

create or replace function public.newapp_get_runtime_secret(p_name text)
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
    'DEYE_API_URL', 'DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD',
    'ENPHASE_API_URL', 'ENPHASE_CLIENT_ID', 'ENPHASE_CLIENT_SECRET', 'ENPHASE_API_KEY',
    'ENPHASE_EMAIL', 'ENPHASE_PASSWORD',
    'FUSION_SOLAR_API_URL', 'FUSION_SOLAR_USER', 'FUSION_SOLAR_PASSWORD',
    'SHINE_API_URL', 'SEMS_ACCOUNT', 'SEMS_PASSWORD',
    'GROWATT_API_URL', 'GROWATT_API_TOKEN', 'GROWATT_ACCOUNT', 'GROWATT_PASSWORD',
    'BCRA_API_URL', 'BCRA_UVA_VARIABLE_ID',
    'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET', 'SENDPULSE_BOT_ID',
    'MORNING_REPORT_PHONES'
  ) then
    raise exception 'NEWAPP runtime secret is not allowed';
  end if;
  select decrypted_secret into result
  from vault.decrypted_secrets
  where name = 'newapp_' || p_name
  limit 1;
  return result;
end;
$$;

create or replace function public.newapp_set_runtime_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if p_name not in (
    'DEYE_API_URL', 'DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD',
    'ENPHASE_API_URL', 'ENPHASE_CLIENT_ID', 'ENPHASE_CLIENT_SECRET', 'ENPHASE_API_KEY',
    'ENPHASE_EMAIL', 'ENPHASE_PASSWORD',
    'FUSION_SOLAR_API_URL', 'FUSION_SOLAR_USER', 'FUSION_SOLAR_PASSWORD',
    'SHINE_API_URL', 'SEMS_ACCOUNT', 'SEMS_PASSWORD',
    'GROWATT_API_URL', 'GROWATT_API_TOKEN', 'GROWATT_ACCOUNT', 'GROWATT_PASSWORD',
    'BCRA_API_URL', 'BCRA_UVA_VARIABLE_ID',
    'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET', 'SENDPULSE_BOT_ID',
    'MORNING_REPORT_PHONES'
  ) then
    raise exception 'NEWAPP runtime secret is not allowed';
  end if;
  select id into secret_id from vault.decrypted_secrets
  where name = 'newapp_' || p_name limit 1;
  if secret_id is null then
    perform vault.create_secret(p_value, 'newapp_' || p_name, 'SolarPower NEWAPP runtime secret');
  else
    perform vault.update_secret(secret_id, p_value, 'newapp_' || p_name, 'SolarPower NEWAPP runtime secret');
  end if;
end;
$$;

revoke all on function public.energy_get_runtime_secret(text) from public, anon, authenticated;
revoke all on function public.energy_set_runtime_secret(text, text) from public, anon, authenticated;
revoke all on function public.newapp_get_runtime_secret(text) from public, anon, authenticated;
revoke all on function public.newapp_set_runtime_secret(text, text) from public, anon, authenticated;
grant execute on function public.energy_get_runtime_secret(text) to service_role;
grant execute on function public.energy_set_runtime_secret(text, text) to service_role;
grant execute on function public.newapp_get_runtime_secret(text) to service_role;
grant execute on function public.newapp_set_runtime_secret(text, text) to service_role;

create or replace function private.energy_queue_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_phone is not null and lower(coalesce(new.kind, '')) = 'invoice' then
    insert into public.energy_analysis_jobs (dedupe_key, phone, source_file_id, input)
    values (
      'crm_lead_file:' || new.id::text,
      regexp_replace(new.contact_phone, '[^0-9]', '', 'g'),
      new.id,
      jsonb_build_object('source', 'crm_lead_files')
    )
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.energy_queue_invoice() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.crm_lead_files') is not null then
    execute 'drop trigger if exists energy_queue_invoice on public.crm_lead_files';
    execute 'create trigger energy_queue_invoice after insert on public.crm_lead_files
      for each row execute function private.energy_queue_invoice()';
  end if;
end;
$$;

create or replace function public.newapp_consolidate_daily(p_date date)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  with ranged as (
    select r.*,
      lead(r.read_at) over (partition by r.system_id order by r.read_at) as next_at
    from public.newapp_energy_readings r
    join public.newapp_systems s on s.id = r.system_id
    where s.is_active = true
      and r.source = 'bot'
      and r.read_at >= (p_date::timestamp + interval '3 hours') at time zone 'UTC'
      and r.read_at < ((p_date + 1)::timestamp + interval '3 hours') at time zone 'UTC'
  ), aggregates as (
    select
      system_id,
      max(energy_kwh) filter (where energy_kwh >= 0) as total_kwh,
      max(power_w) as peak_power_w,
      avg(power_w) filter (where power_w is not null) as avg_power_w,
      count(*)::integer as reading_count,
      sum(consumption_w * least(greatest(extract(epoch from coalesce(next_at - read_at, interval '15 minutes')), 0), 3600) / 3600000.0)
        filter (where consumption_w is not null) as integrated_consumption,
      sum(grid_export_w * least(greatest(extract(epoch from coalesce(next_at - read_at, interval '15 minutes')), 0), 3600) / 3600000.0)
        filter (where grid_export_w is not null) as integrated_export,
      sum(grid_import_w * least(greatest(extract(epoch from coalesce(next_at - read_at, interval '15 minutes')), 0), 3600) / 3600000.0)
        filter (where grid_import_w is not null) as integrated_import,
      max(daily_export_kwh) filter (where daily_export_kwh >= 0) as daily_export,
      max(daily_import_kwh) filter (where daily_import_kwh >= 0) as daily_import,
      max(case when (raw_response #>> '{_daily,day_consumption_kwh}') ~ '^[0-9]+([.][0-9]+)?$'
        then (raw_response #>> '{_daily,day_consumption_kwh}')::numeric end) as raw_consumption,
      max(case when (raw_response #>> '{_daily,day_grid_export_kwh}') ~ '^[0-9]+([.][0-9]+)?$'
        then (raw_response #>> '{_daily,day_grid_export_kwh}')::numeric end) as raw_export,
      max(case when (raw_response #>> '{_daily,day_grid_import_kwh}') ~ '^[0-9]+([.][0-9]+)?$'
        then (raw_response #>> '{_daily,day_grid_import_kwh}')::numeric end) as raw_import
    from ranged
    group by system_id
  ), peaks as (
    select distinct on (system_id) system_id, read_at as peak_at
    from ranged where power_w is not null
    order by system_id, power_w desc, read_at asc
  ), upserted as (
    insert into public.newapp_daily_energy (
      system_id, date, total_kwh, consumption_kwh, export_kwh, import_kwh,
      peak_power_w, peak_at, avg_power_w, reading_count, updated_at
    )
    select
      a.system_id, p_date, a.total_kwh,
      coalesce(a.raw_consumption, a.integrated_consumption),
      coalesce(a.daily_export, a.raw_export, a.integrated_export),
      coalesce(a.daily_import, a.raw_import, a.integrated_import),
      a.peak_power_w, p.peak_at, a.avg_power_w, a.reading_count, now()
    from aggregates a
    left join peaks p using (system_id)
    where a.total_kwh is not null
    on conflict (system_id, date) do update set
      total_kwh = excluded.total_kwh,
      consumption_kwh = excluded.consumption_kwh,
      export_kwh = excluded.export_kwh,
      import_kwh = excluded.import_kwh,
      peak_power_w = excluded.peak_power_w,
      peak_at = excluded.peak_at,
      avg_power_w = excluded.avg_power_w,
      reading_count = excluded.reading_count,
      updated_at = now()
    returning 1
  )
  select count(*) into affected from upserted;
  return affected;
end;
$$;

create or replace function public.newapp_aggregate_monthly(p_from_date date)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  with monthly as (
    select
      system_id,
      extract(year from date)::integer as year,
      extract(month from date)::integer as month,
      sum(total_kwh) as total_kwh,
      sum(consumption_kwh) as consumption_kwh,
      sum(export_kwh) as export_kwh,
      sum(import_kwh) as import_kwh,
      max(total_kwh) as peak_day_kwh,
      count(*)::numeric as days_with_data
    from public.newapp_daily_energy
    where date >= date_trunc('month', p_from_date)::date
    group by system_id, extract(year from date), extract(month from date)
  ), rows_with_peak as (
    select m.*,
      (select d.date from public.newapp_daily_energy d
       where d.system_id = m.system_id
         and extract(year from d.date)::integer = m.year
         and extract(month from d.date)::integer = m.month
       order by d.total_kwh desc, d.date asc limit 1) as peak_date
    from monthly m
  ), upserted as (
    insert into public.newapp_monthly_energy (
      system_id, year, month, total_kwh, consumption_kwh, export_kwh, import_kwh,
      peak_day_kwh, peak_date, avg_daily_kwh, updated_at
    )
    select system_id, year, month, total_kwh, consumption_kwh, export_kwh, import_kwh,
      peak_day_kwh, peak_date, total_kwh / nullif(days_with_data, 0), now()
    from rows_with_peak
    on conflict (system_id, year, month) do update set
      total_kwh = excluded.total_kwh,
      consumption_kwh = excluded.consumption_kwh,
      export_kwh = excluded.export_kwh,
      import_kwh = excluded.import_kwh,
      peak_day_kwh = excluded.peak_day_kwh,
      peak_date = excluded.peak_date,
      avg_daily_kwh = excluded.avg_daily_kwh,
      updated_at = now()
    returning 1
  )
  select count(*) into affected from upserted;
  return affected;
end;
$$;

revoke all on function public.newapp_consolidate_daily(date) from public, anon, authenticated;
revoke all on function public.newapp_aggregate_monthly(date) from public, anon, authenticated;
grant execute on function public.newapp_consolidate_daily(date) to service_role;
grant execute on function public.newapp_aggregate_monthly(date) to service_role;

do $$
declare
  existing record;
begin
  for existing in select jobid from cron.job where jobname in (
    'energy-analysis-every-2-minutes',
    'newapp-poll-fast', 'newapp-poll-enphase', 'newapp-consolidate-today',
    'newapp-consolidate-yesterday', 'newapp-aggregate-monthly',
    'newapp-discovery', 'newapp-morning-report', 'newapp-uva'
  ) loop
    perform cron.unschedule(existing.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'energy-analysis-every-2-minutes', '*/2 * * * *',
  $energy_cron$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/energy-analyze',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-energy-cron-secret', (select value from public.energy_analysis_settings where key = 'cron_secret')
    ),
    body := jsonb_build_object('task', 'process_queue', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $energy_cron$
);

select cron.schedule(
  'newapp-poll-fast', '*/5 * * * *',
  $newapp_fast$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'poll_fast', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_fast$
);

select cron.schedule(
  'newapp-poll-enphase', '2,17,32,47 * * * *',
  $newapp_enphase$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'poll_enphase', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_enphase$
);

select cron.schedule(
  'newapp-consolidate-today', '7,37 * * * *',
  $newapp_today$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'consolidate_today', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_today$
);

select cron.schedule(
  'newapp-consolidate-yesterday', '50 2 * * *',
  $newapp_yesterday$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'consolidate_yesterday', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_yesterday$
);

select cron.schedule(
  'newapp-aggregate-monthly', '0 3 * * *',
  $newapp_monthly$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'aggregate_monthly', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_monthly$
);

select cron.schedule(
  'newapp-discovery', '0 9 * * *',
  $newapp_discovery$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'discovery', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_discovery$
);

select cron.schedule(
  'newapp-morning-report', '0 11 * * *',
  $newapp_report$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'morning_report', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_report$
);

select cron.schedule(
  'newapp-uva', '0 12 * * *',
  $newapp_uva$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/newapp-cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-newapp-cron-secret', (select value from public.newapp_bot_settings where key = 'cron_secret')),
    body := jsonb_build_object('task', 'uva', 'scheduled_at', now()),
    timeout_milliseconds := 120000
  );
  $newapp_uva$
);
