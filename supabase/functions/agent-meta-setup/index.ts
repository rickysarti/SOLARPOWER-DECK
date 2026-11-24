import { db, isInternalRequest, json, runtimeSecret } from "../_shared/db.ts";

// Internal-only Meta configuration. Credentials are read from Vault and used
// server-side; no response ever includes them.
const APP_ID = "1441467804178054";
const WABA_ID = "1413639696868906";
const FIELDS = "messages,smb_message_echoes";

type GraphResult = { ok: boolean; status: number; body: any };

async function graph(
  path: string,
  token: string,
  init: { method?: string; params?: Record<string, string> } = {},
): Promise<GraphResult> {
  const version = await runtimeSecret("META_GRAPH_API_VERSION") ?? "v25.0";
  const method = init.method ?? "GET";
  const params = new URLSearchParams(init.params ?? {});
  const url = `https://graph.facebook.com/${version}/${path}`;
  const response = await fetch(method === "GET" && params.size ? `${url}?${params}` : url, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(method === "GET" ? {} : { body: params }),
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
}

// Meta error messages can echo request values, so only stable fields are returned.
function failure(result: GraphResult) {
  const error = result.body?.error ?? {};
  return { status: result.status, code: error.code ?? null, subcode: error.error_subcode ?? null, type: error.type ?? null };
}

function view<T>(result: GraphResult, pick: (body: any) => T) {
  return result.ok ? { ok: true, data: pick(result.body) } : { ok: false, error: failure(result) };
}

async function inspect(token: string, appToken: string) {
  const [debug, numbers, subscribed, subscriptions, templates] = await Promise.all([
    graph("debug_token", appToken, { params: { input_token: token } }),
    graph(`${WABA_ID}/phone_numbers`, token, {
      params: { fields: "id,display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app" },
    }),
    graph(`${WABA_ID}/subscribed_apps`, token),
    graph(`${APP_ID}/subscriptions`, appToken),
    graph(`${WABA_ID}/message_templates`, token, {
      params: { fields: "name,status,category,language,components", limit: "50" },
    }),
  ]);
  return {
    templates: view(templates, (body) =>
      (body.data ?? []).map((row: any) => ({
        name: row.name,
        status: row.status,
        category: row.category,
        language: row.language,
        components: (row.components ?? []).map((part: any) => ({
          type: part.type,
          format: part.format,
          text: part.text,
        })),
      }))),
    token: view(debug, (body) => ({
      valid: body.data?.is_valid,
      app_id: body.data?.app_id,
      type: body.data?.type,
      expires_at: body.data?.expires_at,
      scopes: body.data?.scopes,
      granular_scopes: body.data?.granular_scopes,
    })),
    phone_numbers: view(numbers, (body) => body.data),
    waba_subscribed_apps: view(
      subscribed,
      (body) =>
        (body.data ?? []).map((row: any) => ({
          id: row.whatsapp_business_api_data?.id,
          name: row.whatsapp_business_api_data?.name,
        })),
    ),
    app_subscriptions: view(
      subscriptions,
      (body) =>
        (body.data ?? []).map((row: any) => ({
          object: row.object,
          callback_url: row.callback_url,
          active: row.active,
          fields: (row.fields ?? []).map((field: any) => field.name),
        })),
    ),
  };
}

// Read-only.
async function diagnose(token: string) {
  const phoneId = await runtimeSecret("META_PHONE_NUMBER_ID") ?? "";
  const [me, phoneHealth, wabaHealth, waba, funding, testNumbers, businessWabas] = await Promise.all([
    graph("me", token, { params: { fields: "id,name" } }),
    graph(phoneId, token, {
      params: { fields: "id,display_phone_number,status,account_mode,platform_type,is_on_biz_app,health_status" },
    }),
    graph(WABA_ID, token, { params: { fields: "health_status" } }),
    graph(WABA_ID, token, {
      params: { fields: "id,name,ownership_type,owner_business_info,on_behalf_of_business_info,account_review_status,status" },
    }),
    graph(WABA_ID, token, { params: { fields: "primary_funding_id" } }),
    graph(`${WABA_ID}/assigned_users`, token, { params: { business: "1654265481911793", fields: "id,name,tasks" } }),
    graph("1654265481911793/owned_whatsapp_business_accounts", token, { params: { fields: "id,name" } }),
  ]);
  const accounts = [];
  for (const id of ["2267047993704746", "933869515679131", "1647098746462946"]) {
    const numbers = await graph(`${id}/phone_numbers`, token, {
      params: { fields: "id,display_phone_number,status,platform_type,is_on_biz_app" },
    });
    const apps = await graph(`${id}/subscribed_apps`, token);
    accounts.push({ id, numbers: numbers.body?.data ?? numbers.body?.error?.message, apps: apps.body?.data ?? null });
  }
  const raw = (result: GraphResult) => result.ok ? result.body : { failed: failure(result), message: result.body?.error?.message };
  return {
    me: raw(me),
    phone: raw(phoneHealth),
    waba_health: raw(wabaHealth),
    waba: raw(waba),
    funding: raw(funding),
    assigned_users: raw(testNumbers),
    owned_wabas: raw(businessWabas),
    accounts,
  };
}

function samplePdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 62 >>\nstream\nBT /F1 20 Tf 60 760 Td (Presupuesto SolarPower - Ejemplo) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

// Meta needs a sample of the header file to review a document template.
async function uploadSample(token: string): Promise<string> {
  const version = await runtimeSecret("META_GRAPH_API_VERSION") ?? "v25.0";
  const bytes = samplePdf();
  const session = await graph(`${APP_ID}/uploads`, token, {
    method: "POST",
    params: { file_name: "presupuesto.pdf", file_length: String(bytes.byteLength), file_type: "application/pdf" },
  });
  if (!session.ok || !session.body?.id) throw new Error(`upload session ${JSON.stringify(failure(session))}`);
  const response = await fetch(`https://graph.facebook.com/${version}/${session.body.id}`, {
    method: "POST",
    headers: { authorization: `OAuth ${token}`, file_offset: "0" },
    body: bytes as BodyInit,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.h) throw new Error(`upload ${response.status}`);
  return result.h;
}

async function createTemplates(token: string) {
  const existing = await graph(`${WABA_ID}/message_templates`, token, { params: { fields: "name,status", limit: "100" } });
  if (!existing.ok) return { error: failure(existing) };
  const names = new Set((existing.body?.data ?? []).map((row: any) => row.name));
  const definitions: Array<{ name: string; category: string; components: unknown[] }> = [];
  if (!names.has("presupuesto_solarpower")) {
    definitions.push({
      name: "presupuesto_solarpower",
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "DOCUMENT", example: { header_handle: [await uploadSample(token)] } },
        {
          type: "BODY",
          text:
            "Hola {{1}}, te enviamos en el archivo adjunto el presupuesto que nos pediste. Si tenés dudas o querés modificar algo, respondé este mensaje.",
          example: { body_text: [["Juan"]] },
        },
        { type: "FOOTER", text: "SolarPower" },
      ],
    });
  }
  if (!names.has("seguimiento_solarpower")) {
    definitions.push({
      name: "seguimiento_solarpower",
      category: "UTILITY",
      components: [{
        type: "BODY",
        text:
          "Hola, te escribimos de SolarPower por la consulta que nos hiciste. {{1}} Podés responder este mensaje para continuar.",
        example: { body_text: [["Ya está listo el estudio de tu factura de luz."]] },
      }],
    });
  }
  if (!names.has("aviso_interno_solarpower")) {
    definitions.push({
      name: "aviso_interno_solarpower",
      category: "UTILITY",
      components: [{
        type: "BODY",
        text: "Aviso automático de tu agenda y tus sistemas en SolarPower: {{1}} Respondé este mensaje si necesitás más detalle.",
        example: { body_text: [["Recordatorio: llamada con el cliente a las 10:00."]] },
      }],
    });
  }
  const version = await runtimeSecret("META_GRAPH_API_VERSION") ?? "v25.0";
  const results = [];
  for (const definition of definitions) {
    const response = await fetch(`https://graph.facebook.com/${version}/${WABA_ID}/message_templates`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...definition, language: "es_AR" }),
    });
    const result = await response.json().catch(() => ({}));
    results.push({
      name: definition.name,
      ok: response.ok,
      status: result?.status ?? null,
      category: result?.category ?? null,
      error: response.ok ? null : result?.error?.error_user_msg ?? result?.error?.message ?? null,
    });
  }
  return { created: results, already: [...names] };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const token = await runtimeSecret("META_ACCESS_TOKEN");
    const appSecret = await runtimeSecret("META_APP_SECRET");
    const verifyToken = await runtimeSecret("META_VERIFY_TOKEN");
    const missing = Object.entries({
      META_ACCESS_TOKEN: token,
      META_APP_SECRET: appSecret,
      META_VERIFY_TOKEN: verifyToken,
    }).filter(([, value]) => !value).map(([name]) => name);
    if (!token || !appSecret || !verifyToken) return json({ error: "missing_secrets", missing }, 409);
    const appToken = `${APP_ID}|${appSecret}`;

    if (body.action === "create_templates") return json(await createTemplates(token));
    if (body.action === "diagnose") return json(await diagnose(token));
    if (body.action === "connect") {
      const provider = await db().from("agent_settings").select("value").eq("key", "whatsapp_provider").single();
      if (provider.error) throw provider.error;
      // Connecting only starts shadow receipts; the cutover is a separate, explicit step.
      if (provider.data.value !== "sendpulse") return json({ error: "provider_is_not_sendpulse" }, 409);
      const callback = `${Deno.env.get("SUPABASE_URL")}/functions/v1/agent-whatsapp-webhook`;
      const webhook = await graph(`${APP_ID}/subscriptions`, appToken, {
        method: "POST",
        params: {
          object: "whatsapp_business_account",
          callback_url: callback,
          verify_token: verifyToken,
          fields: FIELDS,
        },
      });
      if (!webhook.ok) return json({ step: "app_webhook", error: failure(webhook) }, 502);
      const subscribe = await graph(`${WABA_ID}/subscribed_apps`, token, { method: "POST" });
      if (!subscribe.ok) return json({ step: "waba_subscription", error: failure(subscribe) }, 502);
    }
    return json({ action: body.action === "connect" ? "connect" : "inspect", ...await inspect(token, appToken) });
  } catch (error) {
    console.error("agent-meta-setup", error instanceof Error ? error.name : "unknown");
    return json({ error: "meta_setup_failed" }, 500);
  }
});
