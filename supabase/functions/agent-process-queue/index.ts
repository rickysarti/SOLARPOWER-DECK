import { isInternalRequest, json } from "../_shared/db.ts";
import { processDueJobs } from "../_shared/processor.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
  try {
    return json(await processDueJobs(20));
  } catch (error) {
    console.error("agent-process-queue", error);
    return json({ error: "processing_failed" }, 500);
  }
});
