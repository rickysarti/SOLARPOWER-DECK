export type ControlCommand =
  | { type: "contact_mode"; phone: string; humanMode: boolean; verb: string }
  | { type: "global_mode"; enabled: boolean }
  | { type: "status" };

export function normalizePhoneInput(raw: string): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && !digits.startsWith("00")) digits = digits.slice(1);
  if (!digits.startsWith("54") && digits.length === 10) digits = `549${digits}`;
  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length === 12) {
    digits = `549${digits.slice(2)}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function normalizedCommand(text: string): string {
  return text.trim().toLocaleLowerCase("es-AR").replace(/\s+/g, " ");
}

export function parseControlCommand(text: string): ControlCommand | null {
  const normalized = normalizedCommand(text);
  if (
    /^(?:pausa|pausar|detener|frenar)(?: el)? bot$/.test(normalized) ||
    /^(?:pausa|pausar) todo$/.test(normalized) || normalized === "pausa global"
  ) {
    return { type: "global_mode", enabled: false };
  }
  if (
    /^(?:activar|reactivar|reanudar|iniciar|encender)(?: el)? bot$/.test(normalized) ||
    /^reanudar (?:todo|global)$/.test(normalized)
  ) {
    return { type: "global_mode", enabled: true };
  }
  if (/^estado (?:del? )?bot$/.test(normalized)) return { type: "status" };

  const contact = normalized.match(/^(pausar|tomar|liberar|activar|reactivar)\s+(.+)$/);
  if (!contact) return null;
  const phone = normalizePhoneInput(contact[2]);
  if (!phone) return null;
  const humanMode = contact[1] === "pausar" || contact[1] === "tomar";
  return { type: "contact_mode", phone, humanMode, verb: contact[1] };
}

export function authorizedControlCommand(
  senderPhone: string,
  text: string,
  authorizedPhones: ReadonlySet<string>,
): ControlCommand | null {
  return authorizedPhones.has(senderPhone) ? parseControlCommand(text) : null;
}
