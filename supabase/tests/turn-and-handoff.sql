do $$
declare first_id bigint; second_id bigint; blocked boolean := false; active_count integer; phone_a text := '19990000001'; phone_b text := '19990000002';
begin
 if exists(select 1 from public.chatbot_wa_contacts where phone in (phone_a,phone_b)) then raise exception 'Fixture phone already exists'; end if;
 perform public.agent_ensure_contact(phone_a,'Synthetic regression A');
 perform public.agent_ensure_contact(phone_b,'Synthetic regression B');
 insert into public.agent_jobs(dedupe_key,job_type,payload,status,available_at)
 values ('regression-job-a1','process_inbound',jsonb_build_object('phone',phone_a),'pending','1900-01-01'),
 ('regression-job-a2','process_inbound',jsonb_build_object('phone',phone_a),'pending','1900-01-01'),
 ('regression-job-b1','process_inbound',jsonb_build_object('phone',phone_b),'pending','1900-01-01');
 perform public.agent_claim_jobs(100);
 select count(*) into active_count from public.agent_jobs where payload->>'phone'=phone_a and status='processing';
 if active_count<>1 then raise exception 'Two jobs claimed for one phone'; end if;
 perform public.agent_claim_jobs(100);
 select count(*) into active_count from public.agent_jobs where payload->>'phone'=phone_a and status='processing';
 if active_count<>1 then raise exception 'Second claimant bypassed active job'; end if;
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,metadata)
 values(phone_a,'First response','sendpulse','customer_reply','sent','regression-turn-a',
 '{"logical_key":"reply:a","inbound_event_ids":["event-a"]}') returning id into first_id;
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,metadata)
 values(phone_a,'Different response to same event','sendpulse','customer_reply','pending','regression-turn-b',
 '{"logical_key":"reply:b","inbound_event_ids":["event-a"]}') returning id into second_id;
 begin
   update public.agent_outbound_messages set status='sending' where id=second_id;
 exception when sqlstate 'P0001' then
   if sqlerrm<>'customer_turn_already_answered' then raise; end if; blocked:=true;
 end;
 if not blocked then raise exception 'Different text for same turn was not blocked'; end if;
 perform public.agent_apply_contact_state(phone_b,'{"human_mode":false,"agent_state":{"pending_handoff":"reply:close"}}',null,null);
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,chunk_index,chunk_count,metadata)
 values(phone_b,'Closing part 1','sendpulse','customer_reply','pending','regression-close-0',0,2,
 '{"logical_key":"reply:close","handoff_key":"reply:close","inbound_event_ids":[]}') returning id into first_id;
 insert into public.agent_outbound_messages(phone,content,provider,kind,status,dedupe_key,chunk_index,chunk_count,metadata)
 values(phone_b,'Closing part 2','sendpulse','customer_reply','pending','regression-close-1',1,2,
 '{"logical_key":"reply:close","handoff_key":"reply:close","inbound_event_ids":[]}') returning id into second_id;
 update public.agent_outbound_messages set status='sent' where id=first_id;
 if (select human_mode from public.chatbot_wa_contacts where phone=phone_b) then raise exception 'Muted before entire closing reply'; end if;
 update public.agent_outbound_messages set status='sent' where id=second_id;
 if not (select human_mode from public.chatbot_wa_contacts where phone=phone_b) then raise exception 'Handoff missing after complete delivery'; end if;
 perform public.agent_apply_contact_state(phone_b,'{"human_mode":false,"agent_state":{"pending_handoff":"reply:newer"}}',null,null);
 update public.agent_outbound_messages set status='delivered' where id=second_id;
 if (select human_mode from public.chatbot_wa_contacts where phone=phone_b) then raise exception 'Stale closing reply muted newer turn'; end if;
end $$;
