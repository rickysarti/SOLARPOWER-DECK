import { assert, assertEquals } from "./assert.ts";
import { CustomerReplySuppressedError, sendWhatsAppText } from "../functions/_shared/whatsapp.ts";

for (const scenario of ["duplicate", "turn_duplicate", "human_mode", "uncertain", "sent"] as const) {
  Deno.test(`envío: ${scenario} verifica el camino completo con proveedor simulado`, async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = Deno.env.get;
    const updates: string[] = [];
    let providerCalls = 0;
    const row = {
      id: 123,
      phone: "5491100000000",
      content: "Registro tu consulta.",
      provider: "sendpulse",
      kind: "customer_reply",
      status: scenario === "sent" ? "sent" : "pending",
      attempts: 0,
      provider_message_id: scenario === "sent" ? "previous-id" : null,
      chunk_index: 0,
      chunk_count: 1,
      created_at: "2026-09-21T14:15:00Z",
      metadata: {
        inbound_event_ids: ["event-a"],
        logical_key: "test",
        logical_content: "Registro tu consulta.",
      },
    };
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    Deno.env.get = (key: string) =>
      key === "SUPABASE_URL"
        ? "https://incident.invalid"
        : key === "SUPABASE_SERVICE_ROLE_KEY"
        ? "test-key"
        : undefined;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.hostname === "api.sendpulse.com") {
        assert(url.pathname.endsWith("sendByPhone"));
        providerCalls++;
        return json({ error: "simulated server error after acceptance" }, 500);
      }
      assertEquals(url.hostname, "incident.invalid");
      if (url.pathname.endsWith("agent_settings")) {
        return json({ value: url.searchParams.get("key") === "eq.whatsapp_provider" ? "sendpulse" : "true" });
      }
      if (url.pathname.endsWith("chatbot_wa_contacts")) {
        return json({ human_mode: scenario === "human_mode", updated_at: "2026-09-21T14:00:00Z" });
      }
      if (url.pathname.endsWith("agent_inbound_events")) {
        return json([{ id: "event-a", received_at: "2026-09-21T14:14:00Z", processed_at: null }]);
      }
      if (url.pathname.endsWith("agent_outbound_messages")) {
        if (init?.method === "PATCH") {
          updates.push(body.status);
          if (body.status === "sending" && ["duplicate", "turn_duplicate"].includes(scenario)) {
            return json({
              code: "P0001",
              message: scenario === "duplicate"
                ? "customer_reply_duplicate"
                : "customer_turn_already_answered",
            }, 400);
          }
          return json({ id: row.id });
        }
        return json(row);
      }
      if (url.pathname.endsWith("agent_conversation_logs")) return json(null);
      if (url.pathname.endsWith("agent_apply_contact_state")) {
        return json({ phone: row.phone, human_mode: true });
      }
      if (url.pathname.endsWith("agent_get_sendpulse_api_key")) return json("test-sendpulse-key");
      if (url.pathname.endsWith("agent_get_runtime_secret")) return json("test-bot");
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    try {
      let suppressed = false;
      let id: string | null = null;
      try {
        id = await sendWhatsAppText(row.phone, row.content, { dedupeKey: "test", kind: "customer_reply" });
      } catch (error) {
        if (!(error instanceof CustomerReplySuppressedError)) throw error;
        suppressed = true;
      }
      assertEquals(providerCalls, scenario === "uncertain" ? 1 : 0);
      assertEquals(suppressed, scenario !== "sent");
      if (scenario === "sent") assertEquals(id, "previous-id");
      if (scenario === "uncertain") {
        assert(updates.includes("uncertain"));
        assert(!updates.includes("failed"));
      }
      if (scenario === "duplicate" || scenario === "human_mode") assert(updates.includes("cancelled"));
    } finally {
      globalThis.fetch = originalFetch;
      Deno.env.get = originalEnv;
    }
  });
}
