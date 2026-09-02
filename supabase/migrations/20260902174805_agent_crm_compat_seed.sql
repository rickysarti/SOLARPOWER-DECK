-- Import the current CRM-editable state into the isolated runtime copy.
-- This reads chatbot_* but only writes agent_*.
do $$
begin
  if to_regclass('public.chatbot_wa_contacts') is not null then
    update public.agent_contacts as agent
    set
      name = coalesce(crm.name, agent.name),
      email = coalesce(crm.email, agent.email),
      label = coalesce(crm.label, agent.label),
      stage = coalesce(crm.stage, agent.stage),
      tipo = coalesce(crm.tipo, agent.tipo),
      bill_received = coalesce(crm.bill_received, agent.bill_received),
      roof_type = coalesce(crm.roof_type, agent.roof_type),
      connection_type = coalesce(crm.connection_type, agent.connection_type),
      locality = coalesce(crm.locality, agent.locality),
      product_interest = coalesce(crm.product_interest, agent.product_interest),
      notes = coalesce(crm.notes, agent.notes),
      notified_ricardo = coalesce(crm.notified_ricardo, agent.notified_ricardo),
      human_mode = coalesce(crm.human_mode, agent.human_mode),
      updated_at = now()
    from public.chatbot_wa_contacts as crm
    where crm.phone = agent.phone;
  end if;
end;
$$;
