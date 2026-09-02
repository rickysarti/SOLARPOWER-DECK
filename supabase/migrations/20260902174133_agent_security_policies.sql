-- Explicit service-only policies. Edge Functions use service_role; browser
-- clients (anon/authenticated) have no grants and no matching policies.

create policy agent_service_role_all on public.agent_contacts
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_messages
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_pending_actions
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_agenda_events
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_agenda_messages
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_pending_notifications
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_conversation_logs
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_inbound_events
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_jobs
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_outbound_messages
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_files
  for all to service_role using (true) with check (true);
create policy agent_service_role_all on public.agent_settings
  for all to service_role using (true) with check (true);

create index agent_files_inbound_event_idx on public.agent_files(inbound_event_id);
