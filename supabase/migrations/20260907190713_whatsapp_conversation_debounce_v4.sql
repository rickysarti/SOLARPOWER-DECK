-- Wait for one full minute of silence before answering a WhatsApp contact.
-- Re-enqueueing the same phone moves the pending job forward, so every new
-- inbound message restarts the debounce window.
create or replace function public.agent_enqueue_phone(
  p_phone text,
  p_delay_seconds integer default 60
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  pending_id uuid;
  delay_seconds integer := greatest(0, coalesce(p_delay_seconds, 60));
begin
  if length(normalized) < 8 or length(normalized) > 15 then
    raise exception 'invalid phone';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agent:' || normalized, 0));

  -- A reply that has not reached the provider is obsolete as soon as another
  -- customer message arrives. The Edge Function performs the same check just
  -- before the provider call to cover a response being generated concurrently.
  update public.agent_outbound_messages
  set status = 'cancelled',
      error = 'Superseded by a newer inbound message',
      updated_at = now()
  where phone = normalized
    and kind = 'customer_reply'
    and status in ('pending', 'failed', 'sending');

  select id into pending_id
  from public.agent_jobs
  where job_type = 'process_inbound'
    and payload->>'phone' = normalized
    and status = 'pending'
  order by created_at desc
  limit 1;

  if pending_id is not null then
    update public.agent_jobs
    set available_at = now() + make_interval(secs => delay_seconds),
        attempts = 0,
        last_error = null,
        updated_at = now()
    where job_type = 'process_inbound'
      and payload->>'phone' = normalized
      and status = 'pending';
    return pending_id;
  end if;

  insert into public.agent_jobs (
    dedupe_key, job_type, payload, status, available_at
  ) values (
    'inbound:' || normalized || ':' || gen_random_uuid()::text,
    'process_inbound', jsonb_build_object('phone', normalized), 'pending',
    now() + make_interval(secs => delay_seconds)
  ) returning id into pending_id;
  return pending_id;
end;
$$;

revoke all on function public.agent_enqueue_phone(text, integer) from public, anon, authenticated;
grant execute on function public.agent_enqueue_phone(text, integer) to service_role;

-- Bring any job that was queued by the previous five-second runtime into the
-- same one-minute contract during the rolling deployment.
with latest_pending as (
  select phone, max(received_at) as received_at
  from public.agent_inbound_events
  where processed_at is null
  group by phone
)
update public.agent_jobs as job
set available_at = greatest(job.available_at, latest_pending.received_at + interval '60 seconds'),
    updated_at = now()
from latest_pending
where job.job_type = 'process_inbound'
  and job.status = 'pending'
  and job.payload->>'phone' = latest_pending.phone;

insert into public.agent_settings (key, value, is_secret)
values ('conversation_engine_version', 'v4', false)
on conflict (key) do update
set value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = now();
