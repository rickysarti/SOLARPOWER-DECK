create schema if not exists private;

create table if not exists private.newapp_daily_energy_overrides (
  system_id uuid not null references public.newapp_systems(id) on delete cascade,
  date date not null,
  total_kwh numeric,
  consumption_kwh numeric,
  export_kwh numeric,
  import_kwh numeric,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (system_id, date),
  constraint newapp_daily_energy_overrides_has_value check (
    total_kwh is not null
    or consumption_kwh is not null
    or export_kwh is not null
    or import_kwh is not null
  )
);

alter table private.newapp_daily_energy_overrides enable row level security;

revoke all on table private.newapp_daily_energy_overrides from public, anon, authenticated;
grant select, insert, update, delete on table private.newapp_daily_energy_overrides to service_role;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_newapp_daily_energy_overrides_updated_at on private.newapp_daily_energy_overrides;
create trigger trg_newapp_daily_energy_overrides_updated_at
before update on private.newapp_daily_energy_overrides
for each row execute function private.set_updated_at();

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
      a.system_id,
      p_date,
      coalesce(o.total_kwh, a.total_kwh),
      coalesce(o.consumption_kwh, a.raw_consumption, a.integrated_consumption),
      coalesce(o.export_kwh, a.daily_export, a.raw_export, a.integrated_export),
      coalesce(o.import_kwh, a.daily_import, a.raw_import, a.integrated_import),
      a.peak_power_w,
      p.peak_at,
      a.avg_power_w,
      a.reading_count,
      now()
    from aggregates a
    left join peaks p using (system_id)
    left join private.newapp_daily_energy_overrides o
      on o.system_id = a.system_id
     and o.date = p_date
    where coalesce(o.total_kwh, a.total_kwh) is not null
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

revoke all on function public.newapp_consolidate_daily(date) from public, anon, authenticated;
grant execute on function public.newapp_consolidate_daily(date) to service_role;

insert into private.newapp_daily_energy_overrides (system_id, date, total_kwh, reason)
select id, date '2026-09-07', 15.34, 'Correccion manual: Enphase station 5914713 devolvio energy_today=0 para todo el dia, valor real informado 15.34 kWh.'
from public.newapp_systems
where api_brand = 'ENPHASE'
  and api_station_id = '5914713'
on conflict (system_id, date) do update set
  total_kwh = excluded.total_kwh,
  reason = excluded.reason;
