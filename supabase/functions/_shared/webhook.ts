import { db } from "./db.ts";
import { errorMessage } from "./errors.ts";

export const INBOUND_DEBOUNCE_SECONDS = 60;

export function inboundDebounceRemainingSeconds(
  receivedAt: string,
  now = Date.now(),
): number {
  const receivedAtMs = new Date(receivedAt).getTime();
  if (!Number.isFinite(receivedAtMs)) return INBOUND_DEBOUNCE_SECONDS;
  return Math.max(0, Math.ceil((receivedAtMs + INBOUND_DEBOUNCE_SECONDS * 1000 - now) / 1000));
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function payloadHash(payload: unknown): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))));
}

export async function recordWebhookReceipt(input: {
  provider: string;
  providerEventId: string;
  phone?: string | null;
  outcome: "accepted" | "duplicate" | "ignored" | "rejected" | "error";
  reason?: string | null;
  inboundEventId?: string | null;
  payload: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const inserted = await db().from("agent_webhook_receipts").insert({
    provider: input.provider,
    provider_event_id: input.providerEventId,
    phone: input.phone ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    inbound_event_id: input.inboundEventId ?? null,
    payload_hash: await payloadHash(input.payload),
    metadata: input.metadata ?? {},
  });
  if (inserted.error) throw inserted.error;
}

export async function enqueuePhone(
  phone: string,
  delaySeconds = INBOUND_DEBOUNCE_SECONDS,
): Promise<string> {
  const queued = await db().rpc("agent_enqueue_phone", { p_phone: phone, p_delay_seconds: delaySeconds });
  if (queued.error) throw queued.error;
  return String(queued.data);
}

export async function cancelPendingCustomerReplies(phone: string): Promise<void> {
  const cancelled = await db().from("agent_outbound_messages").update({
    status: "cancelled",
    error: "Superseded by a newer inbound message",
    updated_at: new Date().toISOString(),
  }).eq("phone", phone).eq("kind", "customer_reply").in("status", ["pending", "failed", "sending"]);
  if (cancelled.error) throw cancelled.error;
}

export async function recordWebhookError(
  provider: string,
  providerEventId: string,
  payload: unknown,
  error: unknown,
  phone?: string | null,
): Promise<void> {
  try {
    await recordWebhookReceipt({
      provider,
      providerEventId,
      phone,
      outcome: "error",
      reason: errorMessage(error),
      payload,
    });
  } catch (receiptError) {
    console.error("unable to persist webhook error receipt", errorMessage(receiptError));
  }
}
