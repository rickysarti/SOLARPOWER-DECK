import type { AgentMessage } from "./anthropic.ts";

export function inboundMessageTime(event: Record<string, any>): number {
  const raw = event.raw_payload ?? {};
  const timestamp = raw.info?.message?.channel_data?.message?.timestamp ??
    raw.message?.data?.timestamp ?? raw.date;
  const epoch = Number(timestamp);
  if (Number.isFinite(epoch) && epoch > 0) return epoch * 1000;
  return new Date(event.received_at).getTime();
}

// Outbox is authoritative even when a retry sent the answer before CRM sync.
export function mergeDeliveredHistory(
  history: Array<AgentMessage & { created_at?: string }>,
  delivered: Array<{ content: string; sent_at?: string; created_at: string; metadata?: Record<string, any> }>,
): AgentMessage[] {
  const merged = [...history];
  const matched = new Set<number>();
  const logicalReplies = new Set<string>();
  for (
    const row of [...delivered].sort((a, b) =>
      new Date(a.sent_at ?? a.created_at).getTime() - new Date(b.sent_at ?? b.created_at).getTime()
    )
  ) {
    const content = String(row.metadata?.logical_content ?? row.content);
    const key = row.metadata?.logical_key ?? `${row.created_at}:${content}`;
    if (logicalReplies.has(key)) continue;
    logicalReplies.add(key);
    const existing = merged.findIndex((m, index) =>
      !matched.has(index) && m.role === "assistant" && m.content === content
    );
    if (existing < 0) {
      merged.push({ role: "assistant", content, created_at: row.sent_at ?? row.created_at });
      matched.add(merged.length - 1);
    } else {
      // A retry can sync to CRM several minutes after the customer answered.
      // Use delivery time, otherwise a name/email answer attaches to the wrong question.
      merged[existing] = { ...merged[existing], created_at: row.sent_at ?? row.created_at };
      matched.add(existing);
    }
  }
  return merged.sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime())
    .map(({ role, content }) => ({ role, content }));
}

function normalizedWords(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, " ").trim();
}

function contentTokens(text: string): Set<string> {
  const stop = new Set(
    "de la el los las un una en con por para tu tus te vos y o que del al se lo es son como cuando vamos apenas todo todos sobre tengo tenes perfecto gracias bien entendido genial excelente dale"
      .split(" "),
  );
  return new Set(
    normalizedWords(text).split(/[^\p{L}\p{N}@]+/u).filter((word) => word.length > 2 && !stop.has(word)),
  );
}

function registrationClosure(text: string): boolean {
  const words = normalizedWords(text);
  return !text.includes("?") && /\b(?:registrad[oa]|anotad[oa]|registro)\b/.test(words) &&
    /\b(?:avis\w*|contact\w*)\b/.test(words) && /\b(?:novedades|email|correo)\b/.test(words);
}

export function conversationResponseViolations(
  reply: string,
  history: AgentMessage[],
  incoming: string,
): string[] {
  const previous = history.filter((m) => m.role === "assistant").slice(-3);
  const violations: string[] = [];
  if (
    previous.length &&
    /(?:soy|me llamo)\s+tom[aá]s|gracias por (?:escribirnos|contactarnos|usar la calculadora)/i.test(reply)
  ) {
    violations.push("vuelve a presentarse o agradecer el contacto en una conversación ya iniciada");
  }
  if (
    /sin (?:invertir|inversi[oó]n|pagar)(?: de entrada| inicial| al inicio)/i.test(reply) &&
    /plan|alquiler/i.test(reply)
  ) {
    violations.push("el alquiler tiene un monto inicial; no prometas ausencia de inversión inicial");
  }
  const opener = normalizedWords(reply).match(/^(perfecto|genial|bien|entendido|excelente|dale)\b/)?.[1];
  if (
    opener && previous.at(-1) && new RegExp(`^${opener}\\b`).test(normalizedWords(previous.at(-1)!.content))
  ) {
    violations.push(
      `repite el comienzo "${opener}"; empezá directamente con la respuesta útil, sin sustituirlo por otra muletilla`,
    );
  }
  const asksToRepeat =
    /\b(?:repet[ií]|repetir|recordame|reenvi\w*|confirm\w*)\b|\b(?:qued[eé]|estoy)\s+(?:registrado|anotado)\b/i
      .test(incoming);
  const suppliedEmails = incoming.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  const confirmsNewEmail = suppliedEmails.some((email) =>
    reply.toLowerCase().includes(email.toLowerCase()) &&
    !previous.some((m) => m.content.toLowerCase().includes(email.toLowerCase()))
  );
  if (!asksToRepeat && !confirmsNewEmail) {
    const candidate = contentTokens(reply);
    for (const message of previous) {
      const old = contentTokens(message.content);
      const intersection = [...candidate].filter((token) => old.has(token)).length;
      const similar = candidate.size >= 8 && old.size >= 8 &&
        intersection / Math.max(candidate.size, old.size) >= 0.7;
      if (similar || (registrationClosure(reply) && registrationClosure(message.content))) {
        violations.push(
          "repite el contenido de una respuesta ya enviada; cambiar palabras o el saludo no agrega información. Respondé sólo a la novedad del último mensaje",
        );
        break;
      }
    }
  }
  if (
    /^(?:(?:muchas|mil)\s+)?gracias(?:\s+por\s+todo)?[\s.!¡]*$/i.test(incoming.trim()) && reply.length > 140
  ) {
    violations.push(
      "el cliente sólo agradeció; cerrá brevemente sin repetir el registro, el email ni las promesas anteriores",
    );
  }
  return violations;
}

export function coveredInboundIds(rows: Array<Record<string, any>>): Set<string> {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const key = row.metadata?.logical_key ?? String(row.id);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ids = new Set<string>();
  for (const group of groups.values()) {
    if (group.length !== Number(group[0].chunk_count ?? 1)) continue;
    if (!group.every((row) => ["sent", "delivered", "read"].includes(row.status))) continue;
    for (const id of group[0].metadata?.inbound_event_ids ?? []) ids.add(String(id));
  }
  return ids;
}
