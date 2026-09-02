-- SendPulse channel support and isolated runtime secrets for the SolarPower agent.
create extension if not exists supabase_vault with schema vault;

alter table public.agent_inbound_events
  add column if not exists provider text not null default 'meta',
  add column if not exists provider_contact_id text,
  add column if not exists media_url text;

alter table public.agent_outbound_messages
  add column if not exists provider text not null default 'sendpulse';

insert into public.agent_settings (key, value, is_secret)
values
  ('whatsapp_provider', 'sendpulse', false),
  ('sendpulse_webhook_secret', encode(gen_random_bytes(32), 'hex'), true)
on conflict (key) do update
set value = case when excluded.key = 'whatsapp_provider' then excluded.value else public.agent_settings.value end,
    updated_at = now();

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
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
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
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'SENDPULSE_API_ID', 'SENDPULSE_API_SECRET', 'SENDPULSE_BOT_ID',
    'META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN',
    'META_PHONE_NUMBER_ID', 'META_GRAPH_API_VERSION',
    'AGENT_RICARDO_PHONE', 'AGENT_AGENDA_PHONE', 'AGENT_GUILLERMO_PHONE',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'
  ) then
    raise exception 'Runtime secret is not allowed';
  end if;

  select id into secret_id from vault.decrypted_secrets where name = 'agent_' || p_name limit 1;
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
