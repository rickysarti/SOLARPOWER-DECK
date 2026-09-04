-- Cover the webhook receipt foreign key used by cleanup and audit queries.
create index if not exists agent_webhook_receipts_inbound_event_idx
  on public.agent_webhook_receipts (inbound_event_id)
  where inbound_event_id is not null;
