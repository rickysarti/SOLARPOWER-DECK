-- v6 lets Claude interpret the full conversation instead of forcing the next
-- response from a rigid ordered list of CRM fields. CRM fields remain useful
-- for persistence and deterministic quote completeness only.
insert into public.agent_settings (key, value, is_secret)
values ('conversation_engine_version', 'v6', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();
