-- v7 answers Academy inquiries with the current preparation status, without
-- requiring personal data, solar qualification fields, or a human handoff.
insert into public.agent_settings (key, value, is_secret)
values ('conversation_engine_version', 'v7', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();
