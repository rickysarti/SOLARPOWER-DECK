import { db, json, setting } from "../_shared/db.ts";

Deno.serve(async () => {
  const required = ["ANTHROPIC_API_KEY", "META_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_PHONE_NUMBER_ID"];
  const missing = required.filter((name) => !Deno.env.get(name));
  const { count: pendingJobs } = await db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "pending");
  const { count: failedJobs } = await db().from("agent_jobs").select("*", { count: "exact", head: true }).eq("status", "failed");
  return json({
    status: missing.length ? "configuration_required" : "ok",
    bot_enabled: (await setting("bot_enabled")) === "true",
    missing_secrets: missing,
    pending_jobs: pendingJobs ?? 0,
    failed_jobs: failedJobs ?? 0,
    checked_at: new Date().toISOString(),
  });
});
