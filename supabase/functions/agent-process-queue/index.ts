import { isInternalRequest, json } from "../_shared/db.ts";
import { modelDecision, processDueJobs, recoverStoredInvoice } from "../_shared/processor.ts";
import { AGENT_CATEGORIES, type AgentCategory } from "../_shared/decision.ts";
import type { AgentMessage } from "../_shared/anthropic.ts";
import { quarantineOutageMessages } from "../_shared/sendpulse-reconcile.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    // Internal-only dry run: exercises the exact model/validation path without
    // touching contacts, queues, or WhatsApp delivery.
    if (body?.task === "preview_decision") {
      const category = body.category as AgentCategory;
      if (
        !AGENT_CATEGORIES.includes(category) || typeof body.incoming !== "string" ||
        !Array.isArray(body.history) || body.history.length > 100 ||
        !body.history.every((m: AgentMessage) =>
          ["user", "assistant"].includes(m.role) && typeof m.content === "string"
        )
      ) {
        return json({ error: "invalid_preview_input" }, 400);
      }
      return json({
        decision: await modelDecision(
          { ...body.contact, phone: "preview-no-send" },
          category,
          body.history,
          body.incoming,
        ),
        dry_run: true,
      });
    }
    if (body?.task === "quarantine_outage") {
      return json(await quarantineOutageMessages(String(body.since), String(body.until), body.apply === true));
    }
    if (body?.task === "recover_stored_invoice") {
      return json(await recoverStoredInvoice(String(body.agentFileId ?? "")));
    }
    return json(await processDueJobs(20));
  } catch (error) {
    console.error("agent-process-queue", error);
    return json({ error: "processing_failed" }, 500);
  }
});
