-- The v5 runtime reads the canonical CRM conversation history across all
-- WhatsApp conversations and respects pending quote state before qualifying.
insert into public.agent_settings (key, value, is_secret)
values ('conversation_engine_version', 'v5', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();
