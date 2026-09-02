import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.99.2";

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (!client) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Supabase runtime credentials are missing");
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function setting(key: string): Promise<string | null> {
  const { data, error } = await db()
    .from("agent_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function isInternalRequest(req: Request): Promise<boolean> {
  const expected = await setting("cron_secret");
  const supplied = req.headers.get("x-agent-cron-secret");
  if (!expected || !supplied || expected.length !== supplied.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return mismatch === 0;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
