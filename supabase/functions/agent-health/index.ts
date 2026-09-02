import { db, json, runtimeSecret, setting } from "../_shared/db.ts";
import { whatsappProvider } from "../_shared/whatsapp.ts";

Deno.serve(async () => {
  const provider = await whatsappProvider();
  const required = provider === "meta"
    ? ["ANTHROPIC_API_KEY", "META_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_PHONE_NUMBER_ID"]
    : ["ANTHROPIC_API_KEY", "SENDPULSE_API_ID", "SENDPULSE_API_SECRET"];
  const values = await Promise.all(required.map((name) => runtimeSecret(name)));
  const missing = required.filter((_, index) => !values[index]);
  const { count: pendingJobs } = await db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "pending");
  const { count: failedJobs } = await db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "failed");
  return json({
    status: missing.length ? "configuration_required" : "ok",
    bot_enabled: (await setting("bot_enabled")) === "true",
    whatsapp_provider: provider,
    missing_secrets: missing,
    pending_jobs: pendingJobs ?? 0,
    failed_jobs: failedJobs ?? 0,
    checked_at: new Date().toISOString(),
  });
});
