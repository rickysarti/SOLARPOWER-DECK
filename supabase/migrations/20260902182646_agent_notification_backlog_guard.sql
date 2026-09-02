-- Preserve migrated notifications as history without retrying stale WhatsApp sends.
alter table public.agent_pending_notifications
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

update public.agent_pending_notifications
set archived_at = now(),
    archive_reason = 'migration_backlog_expired'
where sent = false
  and created_at < '2026-09-02 00:00:00+00'
  and archived_at is null;

create index if not exists agent_notifications_sendable_idx
on public.agent_pending_notifications(sent, created_at)
where archived_at is null;
