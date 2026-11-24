begin;
do $$
declare first_id bigint; duplicate_id bigint; other_id bigint; blocked boolean := false;
begin
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,metadata)
 values ('incident-regression-no-send','¿Tenés una factura reciente?', 'sendpulse','customer_reply','sent','incident-sql-first', '{"logical_key":"first"}') returning id into first_id;
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,metadata)
 values ('incident-regression-no-send','TENES UNA FACTURA RECIENTE!', 'sendpulse','customer_reply','pending','incident-sql-duplicate', '{"logical_key":"second"}') returning id into duplicate_id;
 begin
   update public.agent_outbound_messages set status='sending' where id=duplicate_id;
 exception when sqlstate 'P0001' then
   if sqlerrm <> 'customer_reply_duplicate' then raise; end if;
   blocked := true;
 end;
 if not blocked then raise exception 'Duplicate was not blocked'; end if;
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,metadata)
 values ('incident-regression-no-send','Registro tu pedido de llamada.', 'sendpulse','customer_reply','pending','incident-sql-other', '{"logical_key":"third"}') returning id into other_id;
 update public.agent_outbound_messages set status='sending' where id=other_id;
 if not exists(select 1 from public.agent_outbound_messages where id=other_id and status='sending') then raise exception 'Fresh reply blocked'; end if;
 update public.agent_outbound_messages set status='uncertain' where id=first_id;
 blocked := false;
 begin
   update public.agent_outbound_messages set status='sending' where id=duplicate_id;
 exception when sqlstate 'P0001' then blocked := true; end;
 if not blocked then raise exception 'Uncertain duplicate was not blocked'; end if;
end $$;
rollback;
select 'passed: sent duplicate, uncertain duplicate, fresh reply; all fixtures rolled back; no provider calls' as verification;
