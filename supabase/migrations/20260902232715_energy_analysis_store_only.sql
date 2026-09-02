-- Energy analyses are persisted on the matching CRM lead. They are not
-- delivered through SendPulse or any other messaging provider.
update public.energy_analysis_settings
set value = 'supabase_lead', updated_at = now()
where key = 'delivery_provider';

-- Finish jobs that had already persisted their result and were only waiting
-- for the now-removed delivery step.
update public.energy_analysis_jobs
set status = 'completed',
    completed_at = coalesce(completed_at, now()),
    sendpulse_status = 'not_required',
    provider_message_id = null,
    last_error = null,
    updated_at = now()
where status = 'pending_delivery'
  and result is not null;
