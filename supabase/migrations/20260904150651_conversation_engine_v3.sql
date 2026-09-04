-- Keep the deployed runtime version visible to health checks and operators.
insert into public.agent_settings (key, value, is_secret)
values ('conversation_engine_version', 'v3', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();
