import { db, json, runtimeSecret, setting } from "../_shared/db.ts";
import { whatsappProvider } from "../_shared/whatsapp.ts";

function countRows(result: { count: number | null; error: unknown }): number {
  if (result.error) throw result.error;
  return result.count ?? 0;
}

Deno.serve(async () => {
  try {
    const provider = await whatsappProvider();
    const required = provider === "meta"
      ? [
        "ANTHROPIC_API_KEY",
        "META_ACCESS_TOKEN",
        "META_APP_SECRET",
        "META_VERIFY_TOKEN",
        "META_PHONE_NUMBER_ID",
      ]
      : ["ANTHROPIC_API_KEY", "SENDPULSE_API_ID", "SENDPULSE_API_SECRET"];
    if ((await setting("daily_report_enabled")) === "true") required.push("RESEND_API_KEY");
    const values = await Promise.all(required.map((name) => runtimeSecret(name)));
    const missing = required.filter((_, index) => !values[index]);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    const [
      pendingJobs,
      failedJobs,
      oldestJob,
      inboundWithoutDisposition,
      outboundFailures,
      energyPending,
      energyReview,
      energyFailures,
      webhookErrors,
      lastReport,
      crmContacts,
      cacheContacts,
    ] = await Promise.all([
      db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "pending"),
      db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "failed"),
      db().from("agent_jobs").select("created_at,available_at").eq("status", "pending").order("created_at")
        .limit(1).maybeSingle(),
      db().from("agent_inbound_events").select("*", { count: "exact", head: true }).is("processed_at", null)
        .is("disposition", null),
      db().from("agent_outbound_messages").select("*", { count: "exact", head: true }).eq("status", "failed"),
      db().from("energy_analysis_jobs").select("*", { count: "exact", head: true }).in("status", [
        "pending",
        "pending_delivery",
        "processing",
      ]),
      db().from("energy_analysis_jobs").select("*", { count: "exact", head: true }).eq(
        "status",
        "needs_review",
      ),
      db().from("energy_analysis_jobs").select("*", { count: "exact", head: true }).eq("status", "failed"),
      db().from("agent_webhook_receipts").select("*", { count: "exact", head: true }).eq("outcome", "error")
        .gte("received_at", dayAgo),
      db().from("agent_daily_reports").select("report_date,status,sent_at").order("report_date", {
        ascending: false,
      }).limit(1).maybeSingle(),
      db().from("chatbot_wa_contacts").select("phone,stage,human_mode").limit(10000),
      db().from("agent_contacts").select("phone,stage,human_mode").limit(10000),
    ]);

    for (const result of [oldestJob, lastReport, crmContacts, cacheContacts]) {
      if (result.error) throw result.error;
    }
    const cache = new Map((cacheContacts.data ?? []).map((row) => [row.phone, row]));
    let crmDivergences = 0;
    for (const contact of crmContacts.data ?? []) {
      const cached = cache.get(contact.phone);
      if (
        !cached || cached.stage !== (contact.stage ?? "nuevo") ||
        Boolean(cached.human_mode) !== Boolean(contact.human_mode)
      ) {
        crmDivergences += 1;
      }
    }
    const oldestCreatedAt = oldestJob.data?.created_at ? new Date(oldestJob.data.created_at).getTime() : null;
    const queueAgeSeconds = oldestCreatedAt === null
      ? 0
      : Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1000));
    const metrics = {
      pending_jobs: countRows(pendingJobs),
      failed_jobs: countRows(failedJobs),
      queue_oldest_age_seconds: queueAgeSeconds,
      inbound_without_disposition: countRows(inboundWithoutDisposition),
      outbound_failures: countRows(outboundFailures),
      energy_pending: countRows(energyPending),
      energy_needs_review: countRows(energyReview),
      energy_failures: countRows(energyFailures),
      webhook_errors_last_24h: countRows(webhookErrors),
      crm_cache_divergences: crmDivergences,
    };
    const degraded = missing.length > 0 || metrics.failed_jobs > 0 || metrics.outbound_failures > 0 ||
      metrics.energy_failures > 0 || metrics.queue_oldest_age_seconds > 300 ||
      metrics.inbound_without_disposition > 0;
    return json({
      status: missing.length ? "configuration_required" : degraded ? "degraded" : "ok",
      bot_enabled: (await setting("bot_enabled")) === "true",
      conversation_engine_version: await setting("conversation_engine_version"),
      whatsapp_provider: provider,
      missing_secrets: missing,
      metrics,
      last_daily_report: lastReport.data ?? null,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("agent-health", error);
    return json({ status: "error", checked_at: new Date().toISOString() }, 500);
  }
});
