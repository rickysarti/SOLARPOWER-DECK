import { isInternalRequest, json } from "../_shared/db.ts";
import { runScheduledTasks } from "../_shared/processor.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
  try {
    return json(await runScheduledTasks());
  } catch (error) {
    console.error("agent-cron", error);
    return json({ error: "cron_failed" }, 500);
  }
});
