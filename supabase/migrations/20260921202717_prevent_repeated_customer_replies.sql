-- Independent final guard: applies to every worker and retry before provider I/O.
create or replace function public.agent_normalized_reply(p_text text)
returns text language sql immutable strict security invoker set search_path = ''
as $$
  select trim(regexp_replace(translate(lower(p_text), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g'));
$$;
revoke all on function public.agent_normalized_reply(text) from public, anon, authenticated;
grant execute on function public.agent_normalized_reply(text) to service_role;

create or replace function public.agent_guard_customer_reply()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if new.kind <> 'customer_reply' or new.status <> 'sending' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status = 'sending' then return new; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agent-send:' || new.phone, 0));
  if exists (
    select 1 from public.agent_outbound_messages previous
    where previous.phone = new.phone and previous.kind = 'customer_reply'
      and previous.id <> new.id
      and previous.status in ('sending', 'sent', 'delivered', 'read', 'uncertain')
      and previous.created_at >= now() - interval '30 days'
      and coalesce(previous.metadata->>'logical_key', previous.dedupe_key, previous.id::text)
          <> coalesce(new.metadata->>'logical_key', new.dedupe_key, new.id::text)
      and public.agent_normalized_reply(coalesce(previous.metadata->>'logical_content', previous.content))
          = public.agent_normalized_reply(coalesce(new.metadata->>'logical_content', new.content))
  ) then
    raise exception 'customer_reply_duplicate' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.agent_guard_customer_reply() from public, anon, authenticated;
grant execute on function public.agent_guard_customer_reply() to service_role;
create trigger agent_guard_customer_reply_before_send
before insert or update of status on public.agent_outbound_messages
for each row execute function public.agent_guard_customer_reply();
create index if not exists agent_outbound_phone_recent_idx
on public.agent_outbound_messages(phone, created_at desc) where kind = 'customer_reply';
