// Transcribe los audios de WhatsApp antes de que los procese el bot (agent-cron).
//
// Un trigger en agent_inbound_events llama a esta función con cada audio nuevo. El bot
// espera 60 s antes de contestar, así que cuando lee el evento el contenido ya es texto.
// Si algo falla (o no hay clave cargada) el evento queda como estaba y el bot responde
// igual que siempre. Nunca manda mensajes.
//
// Clave: secret GROQ_API_KEY (u OPENAI_API_KEY) en Supabase > Edge Functions > Secrets.
import { createClient } from "npm:@supabase/supabase-js@2.99.2";

const BUCKET = "agent-files";
const MAX_BYTES = 24 * 1024 * 1024;
const AUDIO_TYPES = new Set(["audio", "voice"]);
export const VOICE_PREFIX = "Mensaje de voz: ";
// Sesga el reconocimiento hacia el vocabulario del rubro.
const VOCABULARY =
  "Consulta a SolarPower, Argentina: paneles solares, batería, inversor, kWh, factura de luz, Edenor, Edesur, Edelap, monofásica, trifásica, techo de chapa, losa, tejas.";

type InboundEvent = {
  id: string;
  phone: string;
  provider: string | null;
  message_type: string | null;
  content: string | null;
  media_id: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  raw_payload: Record<string, any> | null;
};

function serviceRoleKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (typeof parsed?.default === "string") return parsed.default;
    } catch {
      // Sigue con la clave legacy.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceRoleKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function isInternalRequest(req: Request): Promise<boolean> {
  const { data, error } = await db.from("agent_settings").select("value").eq("key", "cron_secret").maybeSingle();
  if (error) throw error;
  const expected = String(data?.value ?? "");
  const supplied = req.headers.get("x-agent-cron-secret") ?? "";
  if (!expected || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return mismatch === 0;
}

function transcriptionProvider() {
  const groq = Deno.env.get("GROQ_API_KEY");
  if (groq) {
    return {
      name: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      key: groq,
      model: "whisper-large-v3",
    };
  }
  const openai = Deno.env.get("OPENAI_API_KEY");
  if (openai) {
    return {
      name: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      key: openai,
      model: "whisper-1",
    };
  }
  return null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const delay of [0, 2_000, 6_000]) {
    if (delay) await wait(delay);
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sourceUrl(event: InboundEvent): string {
  return String(
    event.media_url ??
      event.raw_payload?.info?.message?.channel_data?.message?.audio?.url ??
      event.raw_payload?.message?.data?.audio?.url ?? "",
  );
}

async function metaSecret(name: string): Promise<string> {
  const environment = Deno.env.get(name);
  if (environment) return environment;
  const { data, error } = await db.rpc("agent_get_runtime_secret", { p_name: name });
  if (error) throw error;
  return typeof data === "string" ? data : "";
}

// El token de Meta sólo viaja a hosts de Meta.
async function downloadMetaAudio(mediaId: string): Promise<Uint8Array> {
  const token = await metaSecret("META_ACCESS_TOKEN");
  const version = await metaSecret("META_GRAPH_API_VERSION") || "v25.0";
  if (!token) throw new Error("Meta token is not configured");
  if (!/^\d+$/.test(mediaId)) throw new Error("Invalid Meta media id");
  return await withRetries(async () => {
    const headers = { authorization: `Bearer ${token}` };
    const info = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const metadata = await info.json().catch(() => ({}));
    const url = String(metadata?.url ?? "");
    if (!info.ok || !/^https:\/\/(?:[a-z0-9-]+\.)*(?:facebook|fbcdn|fbsbx|whatsapp)\.(?:com|net)\//i.test(url)) {
      throw new Error(`Unable to resolve Meta media (${info.status})`);
    }
    const media = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!media.ok) throw new Error(`Unable to download Meta media (${media.status})`);
    return new Uint8Array(await media.arrayBuffer());
  });
}

async function downloadAudio(event: InboundEvent, path: string): Promise<Uint8Array> {
  const stored = await db.storage.from(BUCKET).download(path);
  if (!stored.error && stored.data) return new Uint8Array(await stored.data.arrayBuffer());
  if (event.provider === "meta") return await downloadMetaAudio(String(event.media_id ?? ""));

  const url = sourceUrl(event);
  // El token de SendPulse sólo puede viajar a SendPulse.
  if (!/^https:\/\/(?:[a-z0-9-]+\.)*sendpulse\.com\//i.test(url)) throw new Error("Audio without a SendPulse URL");
  const token = await db.rpc("agent_get_sendpulse_api_key");
  if (token.error) throw token.error;
  if (!token.data) throw new Error("SendPulse API key is not configured");
  return await withRetries(async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token.data}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Unable to download SendPulse media (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  });
}

// Whisper inventa frases cuando el audio está vacío o es puro ruido.
export function cleanTranscript(result: Record<string, any>): string | null {
  const text = String(result?.text ?? "").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\d]/u.test(text)) return null;
  const segments: Array<Record<string, any>> = Array.isArray(result?.segments) ? result.segments : [];
  if (segments.length && segments.every((segment) => Number(segment.no_speech_prob ?? 0) > 0.8)) return null;
  if (/amara\.org|subt[ií]tulos (?:por|realizados)|gracias por ver (?:el|este) v[ií]deo/i.test(text)) return null;
  if (VOCABULARY.toLowerCase().includes(text.toLowerCase().replace(/\.$/, "")) && text.length > 20) return null;
  return text.slice(0, 6000);
}

async function transcribe(bytes: Uint8Array, provider: NonNullable<ReturnType<typeof transcriptionProvider>>) {
  return await withRetries(async () => {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "audio/ogg" }), "audio.ogg");
    form.append("model", provider.model);
    form.append("language", "es");
    form.append("temperature", "0");
    form.append("response_format", "verbose_json");
    form.append("prompt", VOCABULARY);
    const response = await fetch(provider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.key}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${provider.name} ${response.status}: ${raw.slice(0, 300)}`);
    return JSON.parse(raw) as Record<string, any>;
  });
}

async function handleEvent(eventId: string) {
  const provider = transcriptionProvider();
  if (!provider) return { skipped: "no_transcription_key" };
  const found = await db.from("agent_inbound_events")
    .select("id,phone,provider,message_type,content,media_id,media_url,media_mime_type,raw_payload")
    .eq("id", eventId).maybeSingle();
  if (found.error) throw found.error;
  const event = found.data as InboundEvent | null;
  if (!event || !AUDIO_TYPES.has(String(event.message_type))) return { skipped: "not_an_audio" };
  if (String(event.content ?? "").startsWith(VOICE_PREFIX)) return { skipped: "already_transcribed" };

  const path = `${event.phone}/${event.id}.ogg`;
  const bytes = await downloadAudio(event, path);
  if (bytes.byteLength > MAX_BYTES) return { skipped: "too_large" };
  const transcript = cleanTranscript(await transcribe(bytes, provider));
  if (!transcript) return { skipped: "no_speech" };

  const uploaded = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "audio/ogg", upsert: false });
  if (uploaded.error && !uploaded.error.message.toLowerCase().includes("already exists")) throw uploaded.error;
  const file = await db.from("agent_files").upsert({
    contact_phone: event.phone,
    inbound_event_id: event.id,
    storage_path: path,
    file_name: `audio_${event.id}.ogg`,
    mime_type: "audio/ogg",
    provider_media_id: event.media_id || sourceUrl(event) || null,
    analysis: JSON.stringify({
      kind: "other",
      confidence: "high",
      description: transcript,
      evidence: "",
      transcribed_by: `${provider.name}/${provider.model}`,
    }),
  }, { onConflict: "storage_path" });
  if (file.error) throw file.error;

  // Sin media_url ni media_id el bot lo trata como un mensaje de texto más. El original queda en raw_payload.
  const updated = await db.from("agent_inbound_events")
    .update({ content: `${VOICE_PREFIX}${transcript}`, media_url: null, media_id: null })
    .eq("id", event.id);
  if (updated.error) throw updated.error;
  return { transcribed: true, characters: transcript.length, provider: provider.name };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (!(await isInternalRequest(req))) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body?.task === "status") return json({ provider: transcriptionProvider()?.name ?? null });
    const eventId = String(body?.event_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) return json({ error: "invalid_event_id" }, 400);
    const result = await handleEvent(eventId);
    console.log("agent-transcribe-audio", eventId, JSON.stringify(result));
    return json(result);
  } catch (error) {
    console.error("agent-transcribe-audio", error instanceof Error ? error.message : JSON.stringify(error));
    return json({ error: "transcription_failed" }, 500);
  }
});
