// Deye collectionTime is the measurement timestamp, in Unix seconds.
// Keep this validation independent of the API client so replacements and stale
// devices can be tested without credentials or production requests.
export function deyeCollectionTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : (typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function localDate(timestamp: number): string {
  return new Date(timestamp - 3 * 3600000).toISOString().slice(0, 10);
}

export function selectFreshDeyeInverter(
  candidates: any[],
  latestBySn: Map<string, any>,
  preferredSn?: string | null,
  now = Date.now(),
): { device: any; collectedAt: number } {
  const eligible = candidates.flatMap((candidate) => {
    if (String(candidate.deviceType ?? "").toUpperCase() !== "INVERTER") return [];
    const device = latestBySn.get(String(candidate.deviceSn));
    if (!device || !Array.isArray(device.dataList) || !device.dataList.length) return [];
    const collectedAt = deyeCollectionTime(device.collectionTime);
    // Missing, yesterday's and frozen measurements must never become today's data.
    if (collectedAt === null || now - collectedAt > 20 * 60000 || collectedAt - now > 5 * 60000) return [];
    if (localDate(collectedAt) !== localDate(now)) return [];
    const status = device.deviceState ?? candidate.connectStatus;
    if (status !== null && status !== undefined && String(status) === "0") return [];
    return [{ device, collectedAt }];
  });
  eligible.sort((a, b) => b.collectedAt - a.collectedAt ||
    Number(b.device.deviceSn === preferredSn) - Number(a.device.deviceSn === preferredSn) ||
    String(a.device.deviceSn).localeCompare(String(b.device.deviceSn)));
  if (!eligible.length) throw new Error("DEYE: no fresh inverter measurement; stale data was not recorded");
  return eligible[0];
}

export function deyeDailyCounter(dataList: any[], ...keys: string[]): number | null {
  for (const key of keys) {
    const item = dataList.find((value) => String(value?.key ?? "").toLowerCase() === key.toLowerCase());
    if (item?.value === null || item?.value === undefined || item?.value === "") continue;
    const value = Number(item.value);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
