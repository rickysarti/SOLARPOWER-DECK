-- Serialize claims across queue/cron invocations, one active job per phone.
create or replace function public.agent_claim_jobs(p_limit integer default 10)
returns setof public.agent_jobs language plpgsql security invoker set search_path = '' as $$
declare candidate public.agent_jobs; claimed public.agent_jobs; total integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('agent-claim-jobs', 0));
  for candidate in
    select * from public.agent_jobs
    where status = 'pending' and available_at <= now()
    order by available_at, created_at for update skip locked
  loop
    if exists (select 1 from public.agent_jobs j where j.status = 'processing'
      and j.payload->>'phone' = candidate.payload->>'phone') then continue; end if;
    update public.agent_jobs set status = 'processing', locked_at = now(), updated_at = now()
      where id = candidate.id returning * into claimed;
    return next claimed;
    total := total + 1;
    exit when total >= greatest(1, least(coalesce(p_limit, 10), 100));
  end loop;
end;
$$;
revoke all on function public.agent_claim_jobs(integer) from public, anon, authenticated;
grant execute on function public.agent_claim_jobs(integer) to service_role;

-- Do not cancel an in-flight provider call: its delivery result is not known yet.
create or replace function public.agent_enqueue_phone(p_phone text, p_delay_seconds integer default 60)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  normalized text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  pending_id uuid;
  delay_seconds integer := greatest(0, coalesce(p_delay_seconds, 60));
begin
  if length(normalized) < 8 or length(normalized) > 15 then raise exception 'invalid phone'; end if;
  perform pg_advisory_xact_lock(hashtextextended('agent:' || normalized, 0));
  update public.agent_outbound_messages set status='cancelled',
    error='Superseded by a newer inbound message', updated_at=now()
    where phone=normalized and kind='customer_reply' and status in ('pending','failed');
  select id into pending_id from public.agent_jobs
    where job_type='process_inbound' and payload->>'phone'=normalized and status='pending'
    order by created_at desc limit 1;
  if pending_id is not null then
    update public.agent_jobs set available_at=now()+make_interval(secs=>delay_seconds),
      updated_at=now() where id=pending_id;
    return pending_id;
  end if;
  insert into public.agent_jobs(dedupe_key,job_type,payload,status,available_at)
    values ('inbound:'||normalized||':'||gen_random_uuid()::text,'process_inbound',
      jsonb_build_object('phone',normalized),'pending',now()+make_interval(secs=>delay_seconds))
    returning id into pending_id;
  return pending_id;
end;
$$;
revoke all on function public.agent_enqueue_phone(text,integer) from public,anon,authenticated;
grant execute on function public.agent_enqueue_phone(text,integer) to service_role;

-- Independent barrier against different texts responding to the same inbound event.
create or replace function public.agent_guard_customer_reply()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.kind <> 'customer_reply' or new.status <> 'sending' then return new; end if;
  if tg_op='UPDATE' then if old.status='sending' then return new; end if; end if;
  perform pg_advisory_xact_lock(hashtextextended('agent-send:' || new.phone,0));
  if exists (
    select 1 from public.agent_outbound_messages previous
    where previous.phone=new.phone and previous.kind='customer_reply' and previous.id<>new.id
      and previous.status in ('sending','sent','delivered','read','uncertain')
      and coalesce(previous.metadata->>'logical_key',previous.dedupe_key,previous.id::text)
        <> coalesce(new.metadata->>'logical_key',new.dedupe_key,new.id::text)
      and exists (select 1 from jsonb_array_elements_text(coalesce(new.metadata->'inbound_event_ids','[]'::jsonb)) i
        where coalesce(previous.metadata->'inbound_event_ids','[]'::jsonb) ? i.value)
  ) then raise exception 'customer_turn_already_answered' using errcode='P0001'; end if;
  if exists (
    select 1 from public.agent_outbound_messages previous
    where previous.phone=new.phone and previous.kind='customer_reply' and previous.id<>new.id
      and previous.status in ('sending','sent','delivered','read','uncertain')
      and previous.created_at >= now()-interval '30 days'
      and coalesce(previous.metadata->>'logical_key',previous.dedupe_key,previous.id::text)
        <> coalesce(new.metadata->>'logical_key',new.dedupe_key,new.id::text)
      and public.agent_normalized_reply(coalesce(previous.metadata->>'logical_content',previous.content))
        = public.agent_normalized_reply(coalesce(new.metadata->>'logical_content',new.content))
  ) then raise exception 'customer_reply_duplicate' using errcode='P0001'; end if;
  return new;
end;
$$;
revoke all on function public.agent_guard_customer_reply() from public,anon,authenticated;
grant execute on function public.agent_guard_customer_reply() to service_role;

-- Handoff and provider receipt commit together. Never activate on partial delivery,
-- superseded turns, cancelled messages, or old outbox rows lacking the new token.
create or replace function public.agent_finalize_sent_handoff()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare handoff text := new.metadata->>'handoff_key'; current_state jsonb;
begin
  if new.kind <> 'customer_reply' or new.status not in ('sent','delivered','read')
    or nullif(handoff,'') is null then return new; end if;
  if (select count(*) from public.agent_outbound_messages o
      where o.phone=new.phone and o.metadata->>'logical_key'=handoff
        and o.status in ('sent','delivered','read')) <> new.chunk_count then return new; end if;
  select agent_state into current_state from public.chatbot_wa_contacts
    where phone=new.phone for update;
  if current_state->>'pending_handoff' <> handoff or current_state->>'pending_handoff' is null then return new; end if;
  if exists (select 1 from public.agent_inbound_events e where e.phone=new.phone
    and e.processed_at is null and not (coalesce(new.metadata->'inbound_event_ids','[]'::jsonb) ? e.id::text)) then
    return new;
  end if;
  perform public.agent_apply_contact_state(new.phone,
    jsonb_build_object('human_mode',true,'agent_state',jsonb_build_object('pending_handoff',null)),null,null);
  return new;
end;
$$;
revoke all on function public.agent_finalize_sent_handoff() from public,anon,authenticated;
grant execute on function public.agent_finalize_sent_handoff() to service_role;
create trigger agent_finalize_sent_handoff_after_delivery
  after update of status on public.agent_outbound_messages
  for each row execute function public.agent_finalize_sent_handoff();
