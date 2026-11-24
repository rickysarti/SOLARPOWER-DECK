create index if not exists agent_conversation_logs_phone_event_idx on public.agent_conversation_logs (contact_phone, event_type, created_at desc);

insert into public.agent_settings (key, value) values ('lead_analyzer_mode', 'off'), ('lead_analyzer_since', now()::text)
on conflict (key) do nothing;

-- Chats handled by a person with messages newer than the last analysis, never older than the activation.
create or replace function public.agent_due_lead_analysis(p_quiet_before timestamptz, p_limit integer)
returns table (phone text, last_message_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with recent as (
    select c.contact_phone as phone, max(m.created_at) as last_message_at
      from public.chatbot_messages m
      join public.chatbot_conversations c on c.id = m.conversation_id
     where c.channel = 'whatsapp' and m.role in ('user', 'assistant')
       and m.created_at > greatest(
         now() - interval '3 days',
         (select s.value::timestamptz from public.agent_settings s where s.key = 'lead_analyzer_since'))
     group by 1
  )
  select r.phone, r.last_message_at
    from recent r
    join public.chatbot_wa_contacts w on w.phone = r.phone
   where w.human_mode
     and coalesce(w.label, '') <> 'Contacto personal'
     and r.last_message_at <= p_quiet_before
     and not exists (
       select 1 from public.agent_conversation_logs l
        where l.contact_phone = r.phone
          and l.event_type in ('lead_analysis', 'lead_analysis_dry_run', 'lead_analysis_error')
          and (l.metadata->>'last_message_at')::timestamptz >= r.last_message_at)
   order by r.last_message_at
   limit greatest(1, least(p_limit, 20));
$$;

create or replace function public.agent_apply_lead_analysis(
  p_phone text, p_patch jsonb, p_summary text, p_last_message_at timestamptz,
  p_expected_stage text, p_task_title text default null, p_task_description text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare crm public.chatbot_wa_contacts%rowtype;
begin
  update public.chatbot_wa_contacts as w set
    name = coalesce(nullif(btrim(w.name), ''), nullif(btrim(p_patch->>'name'), '')),
    email = coalesce(nullif(btrim(w.email), ''), nullif(btrim(p_patch->>'email'), '')),
    locality = coalesce(nullif(btrim(w.locality), ''), nullif(btrim(p_patch->>'locality'), '')),
    province = coalesce(nullif(btrim(w.province), ''), nullif(btrim(p_patch->>'province'), '')),
    roof_type = coalesce(nullif(btrim(w.roof_type), ''), nullif(btrim(p_patch->>'roof_type'), '')),
    connection_type = coalesce(nullif(btrim(w.connection_type), ''), nullif(btrim(p_patch->>'connection_type'), '')),
    product_interest = coalesce(nullif(btrim(w.product_interest), ''), nullif(btrim(p_patch->>'product_interest'), '')),
    consumo_mensual = case when coalesce(w.consumo_mensual, 0) = 0 and (p_patch->>'consumo_mensual') ~ '^[0-9]+([.][0-9]+)?$'
      then (p_patch->>'consumo_mensual')::numeric else w.consumo_mensual end,
    label = case when p_patch->>'label' = 'Contacto personal' and w.stage is not distinct from p_expected_stage
      then 'Contacto personal' else w.label end,
    bandeja = case when p_patch ? 'bandeja' and coalesce(w.bandeja_source, 'auto') = 'auto'
      then p_patch->>'bandeja' else w.bandeja end,
    bandeja_source = case when p_patch ? 'bandeja' and coalesce(w.bandeja_source, 'auto') = 'auto'
      then 'ai' else w.bandeja_source end,
    -- A stage changed by a person meanwhile always wins.
    stage = case when p_patch ? 'stage' and w.stage is not distinct from p_expected_stage
      and coalesce(w.stage, '') not in ('cerrado_ganado', 'cerrado_perdido')
      and p_patch->>'stage' not in ('cerrado_ganado', 'cerrado_perdido')
      then p_patch->>'stage' else w.stage end,
    ai_summary = coalesce(nullif(btrim(p_summary), ''), w.ai_summary),
    ai_processed_at = now(),
    agent_state = coalesce(w.agent_state, '{}'::jsonb) || jsonb_build_object('lead_analysis_at', p_last_message_at)
  where w.phone = p_phone
  returning * into crm;
  if not found then return null; end if;

  update public.agent_contacts a set
    name = crm.name, email = crm.email, label = crm.label, stage = coalesce(crm.stage, 'nuevo'),
    locality = crm.locality, province = crm.province, roof_type = crm.roof_type,
    connection_type = crm.connection_type, product_interest = crm.product_interest,
    agent_state = crm.agent_state, updated_at = now()
  where a.phone = crm.phone;

  if nullif(btrim(p_task_title), '') is not null and not exists (
    select 1 from public.crm_tasks t where t.lead_phone = p_phone
      and t.estado in ('pendiente', 'en_progreso', 'revision') and lower(t.titulo) = lower(btrim(p_task_title))
  ) then
    insert into public.crm_tasks (titulo, descripcion, estado, prioridad, lead_phone, asignado_a, tipo)
    values (btrim(p_task_title), nullif(btrim(p_task_description), ''), 'pendiente', 'alta', p_phone, crm.assigned_to, 'seguimiento');
  end if;
  return jsonb_build_object('stage', crm.stage, 'bandeja', crm.bandeja);
end;
$$;

revoke all on function public.agent_due_lead_analysis(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.agent_apply_lead_analysis(text, jsonb, text, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.agent_due_lead_analysis(timestamptz, integer) to service_role;
grant execute on function public.agent_apply_lead_analysis(text, jsonb, text, timestamptz, text, text, text) to service_role;

-- Scheduled separately on 2026-11-24; every 5 minutes.
select cron.schedule('lead-analyzer-every-5-minutes', '2-59/5 * * * *', $$
  select net.http_post(
    url := 'https://ddocohkgabfhsolfarvr.supabase.co/functions/v1/agent-lead-analyzer',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-agent-cron-secret', (select value from public.agent_settings where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 110000);
$$);
