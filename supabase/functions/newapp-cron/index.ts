import { db, json } from "../_shared/db.ts";
import { executeNewappTask } from "../_shared/newapp.ts";
import { isRuntimeRequest, runtimeSetting } from "../_shared/runtime.ts";

const INTERVALS: Record<string, number> = {
  poll_fast: 5 * 60_000,
  poll_enphase: 15 * 60_000,
  consolidate_today: 30 * 60_000,
  consolidate_yesterday: 24 * 60 * 60_000,
  aggregate_monthly: 24 * 60 * 60_000,
  discovery: 24 * 60 * 60_000,
  morning_report: 24 * 60 * 60_000,
  uva: 24 * 60 * 60_000,
};

function bucket(task: string, scheduledAt: unknown, force: boolean): string {
  const now = new Date(typeof scheduledAt === "string" ? scheduledAt : Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("Invalid scheduled_at");
  if (force) return now.toISOString();
  const interval = INTERVALS[task];
  if (!interval) throw new Error(`Unknown NEWAPP task: ${task}`);
  return new Date(Math.floor(now.getTime() / interval) * interval).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return json({ status: "ok", service: "newapp-supabase-bot" });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isRuntimeRequest(req, "newapp_bot_settings", "x-newapp-cron-secret"))) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const body = await req.json();
    const task = String(body?.task ?? "");
    const force = body?.force === true;
    if ((await runtimeSetting("newapp_bot_settings", "enabled")) !== "true" && !force) {
      return json({ skipped: true, reason: "newapp_disabled", task });
    }
    const scheduledBucket = bucket(task, body?.scheduled_at, force);
    const inserted = await db().from("newapp_bot_runs").insert({ task, scheduled_bucket: scheduledBucket, status: "processing" })
      .select("id").maybeSingle();
    if (inserted.error) {
      if (inserted.error.code === "23505") return json({ skipped: true, reason: "duplicate_bucket", task, scheduledBucket });
      throw inserted.error;
    }
    const runId = inserted.data!.id;
    try {
      const result = await executeNewappTask(task);
      const updated = await db().from("newapp_bot_runs").update({
        status: "completed", processed: result.processed, succeeded: result.succeeded, failed: result.failed,
        result, completed_at: new Date().toISOString(), last_error: null,
      }).eq("id", runId);
      if (updated.error) throw updated.error;
      return json({ runId, task, ...result });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1200);
      await db().from("newapp_bot_runs").update({ status: "failed", last_error: message, completed_at: new Date().toISOString() }).eq("id", runId);
      throw error;
    }
  } catch (error) {
    console.error("newapp-cron", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
