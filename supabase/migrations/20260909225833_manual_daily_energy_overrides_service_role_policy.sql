drop policy if exists "service_role manages daily energy overrides" on private.newapp_daily_energy_overrides;

create policy "service_role manages daily energy overrides"
on private.newapp_daily_energy_overrides
for all
to service_role
using (true)
with check (true);
