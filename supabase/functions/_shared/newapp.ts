import { db } from "./db.ts";
import {
  argentinaDate,
  argentinaHour,
  fetchJson,
  newappSecret,
  runtimeSetting,
  sendPulseText,
} from "./runtime.ts";

type SystemConfig = {
  id: string;
  name: string;
  brand: string;
  inverter_brand?: string | null;
  capacity_kw?: number | null;
  api_brand: string;
  api_station_id?: string | null;
  api_device_sn?: string | null;
  api_credentials?: Record<string, any> | null;
  has_consumption_meter?: boolean;
  has_battery?: boolean;
};

type Reading = {
  power_w?: number | null;
  energy_kwh?: number | null;
  voltage_v?: number | null;
  current_a?: number | null;
  temperature_c?: number | null;
  frequency_hz?: number | null;
  consumption_w?: number | null;
  grid_export_w?: number | null;
  grid_import_w?: number | null;
  soc_pct?: number | null;
  battery_power_w?: number | null;
  daily_export_kwh?: number | null;
  daily_import_kwh?: number | null;
  _raw?: unknown;
};

type TaskResult = {
  processed: number;
  succeeded: number;
  failed: number;
  [key: string]: unknown;
};

const SYSTEM_COLUMNS =
  "id,name,brand,inverter_brand,capacity_kw,api_brand,api_station_id,api_device_sn,api_credentials,has_consumption_meter,has_battery";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", ".").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toWatts(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  return Math.round(Math.abs(number) <= 80 ? number * 1000 : number);
}

function normalizeKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findValue(source: unknown, aliases: string[]): { key: string; value: unknown } | null {
  if (!source || typeof source !== "object") return null;
  const wanted = new Set(aliases.map(normalizeKey));
  const seen = new Set<object>();
  const visit = (value: unknown): { key: string; value: unknown } | null => {
    if (!value || typeof value !== "object" || seen.has(value as object)) return null;
    seen.add(value as object);
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (wanted.has(normalizeKey(key)) && nested !== null && nested !== undefined && nested !== "") {
        return { key, value: nested };
      }
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(source);
}

function pickNumber(sources: unknown[], aliases: string[]): number | null {
  for (const source of sources) {
    const found = findValue(source, aliases);
    const value = toNumber(found?.value);
    if (value !== null) return value;
  }
  return null;
}

function pickWatts(sources: unknown[], aliases: string[]): number | null {
  for (const source of sources) {
    const found = findValue(source, aliases);
    if (!found) continue;
    const value = toNumber(found.value);
    if (value === null) continue;
    const key = normalizeKey(found.key);
    if (key.endsWith("w") || key.includes("watt")) return Math.round(value);
    if (key.includes("kw")) return Math.round(value * 1000);
    return toWatts(value);
  }
  return null;
}

function positiveWatts(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  return Math.abs(number) < 0.5 ? 0 : Math.abs(Math.round(number));
}

function signedWatts(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  return Math.abs(number) < 0.5 ? 0 : Math.round(number);
}

function normalizeEnergy(reading: Reading, system: SystemConfig): Reading {
  const output: Reading = { ...reading };
  output.power_w = positiveWatts(output.power_w);
  output.energy_kwh = toNumber(output.energy_kwh);
  output.voltage_v = toNumber(output.voltage_v);
  output.current_a = toNumber(output.current_a);
  output.temperature_c = toNumber(output.temperature_c);
  output.frequency_hz = toNumber(output.frequency_hz);
  output.consumption_w = positiveWatts(output.consumption_w);
  output.soc_pct = output.soc_pct === null || output.soc_pct === undefined
    ? null
    : Math.max(0, Math.min(100, toNumber(output.soc_pct) ?? 0));
  output.battery_power_w = signedWatts(output.battery_power_w);
  output.daily_export_kwh = toNumber(output.daily_export_kwh);
  output.daily_import_kwh = toNumber(output.daily_import_kwh);

  let gridImport = signedWatts(output.grid_import_w);
  let gridExport = signedWatts(output.grid_export_w);
  if (gridImport !== null && gridImport < 0) {
    gridExport = Math.max(gridExport ?? 0, Math.abs(gridImport));
    gridImport = 0;
  }
  if (gridExport !== null && gridExport < 0) {
    gridImport = Math.max(gridImport ?? 0, Math.abs(gridExport));
    gridExport = 0;
  }
  if (gridImport !== null && gridImport < 150) gridImport = 0;
  if (gridExport !== null && gridExport < 150) gridExport = 0;
  output.grid_import_w = gridImport;
  output.grid_export_w = gridExport;

  const solar = output.power_w ?? 0;
  const gridKnown = gridImport !== null || gridExport !== null;
  const gridNet = gridKnown ? (gridImport ?? 0) - (gridExport ?? 0) : null;
  const hasBattery = Boolean(
    system.has_battery || output.soc_pct !== null || output.battery_power_w !== null,
  );
  if (hasBattery && output.consumption_w !== null && output.consumption_w !== undefined && gridNet !== null) {
    output.battery_power_w = Math.round(solar + gridNet - output.consumption_w);
  } else if (
    output.consumption_w !== null && output.consumption_w !== undefined && output.battery_power_w !== null &&
    output.battery_power_w !== undefined && gridNet === null
  ) {
    const inferred = output.consumption_w + output.battery_power_w - solar;
    output.grid_import_w = inferred >= 0 ? Math.round(inferred) : 0;
    output.grid_export_w = inferred < 0 ? Math.round(Math.abs(inferred)) : 0;
  } else if (
    !hasBattery && output.consumption_w !== null && output.consumption_w !== undefined && gridNet === null
  ) {
    const inferred = output.consumption_w - solar;
    output.grid_import_w = inferred >= 0 ? Math.round(inferred) : 0;
    output.grid_export_w = inferred < 0 ? Math.round(Math.abs(inferred)) : 0;
  }
  output._raw = {
    ...(output._raw && typeof output._raw === "object" && !Array.isArray(output._raw)
      ? output._raw as Record<string, unknown>
      : { value: output._raw ?? null }),
    _edge_runtime: true,
  };
  return output;
}

async function logUsage(
  system: SystemConfig,
  status: number,
  durationMs: number,
  error?: unknown,
  requestsCount = 1,
): Promise<void> {
  await db().from("newapp_api_token_usage").insert({
    api_brand: system.api_brand,
    system_id: system.id,
    endpoint: "supabase-edge-poll",
    requests_count: requestsCount,
    response_status: status,
    duration_ms: durationMs,
    error_message: error ? (error instanceof Error ? error.message : String(error)).slice(0, 1000) : null,
    called_at: new Date().toISOString(),
  });
}

async function recordFailure(
  system: SystemConfig,
  error: unknown,
  startedAt: number,
  requestsCount = 1,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 800);
  const existing = await db().from("newapp_alarms").select("id").eq("system_id", system.id)
    .eq("alarm_type", "api_error").eq("is_active", true).limit(1).maybeSingle();
  if (!existing.data) {
    await db().from("newapp_alarms").insert({
      system_id: system.id,
      alarm_type: "api_error",
      severity: "warning",
      message: `Error API ${system.api_brand}: ${message}`,
      details: { brand: system.api_brand, error: message, runtime: "supabase-edge" },
    });
  }
  await logUsage(system, 0, Date.now() - startedAt, error, requestsCount);
}

async function persistReading(
  system: SystemConfig,
  reading: Reading,
  startedAt: number,
  requestsCount = 1,
): Promise<void> {
  const normalized = normalizeEnergy(reading, system);
  const { _raw, ...columns } = normalized;
  const insert = await db().from("newapp_energy_readings").insert({
    system_id: system.id,
    read_at: new Date().toISOString(),
    ...columns,
    source: "bot",
    raw_response: _raw,
  });
  if (insert.error) throw insert.error;
  await db().from("newapp_alarms").update({ is_active: false, resolved_at: new Date().toISOString() })
    .eq("system_id", system.id).eq("alarm_type", "api_error").eq("is_active", true);
  const updates: Record<string, unknown> = {};
  if (
    normalized.consumption_w !== null && normalized.consumption_w !== undefined &&
    !system.has_consumption_meter
  ) updates.has_consumption_meter = true;
  if (
    (normalized.soc_pct !== null && normalized.soc_pct !== undefined) ||
    (normalized.battery_power_w !== null && normalized.battery_power_w !== undefined)
  ) {
    if (!system.has_battery) updates.has_battery = true;
  }
  if (Object.keys(updates).length) {
    await db().from("newapp_systems").update({ ...updates, updated_at: new Date().toISOString() }).eq(
      "id",
      system.id,
    );
  }
  await logUsage(system, 200, Date.now() - startedAt, undefined, requestsCount);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deyePost(path: string, body: unknown, token?: string): Promise<any> {
  const [baseUrl, appId] = await Promise.all([
    newappSecret("DEYE_API_URL"),
    newappSecret("DEYE_APP_ID"),
  ]);
  if (!baseUrl || !appId) throw new Error("DEYE API URL/app id missing");
  const { data } = await fetchJson<any>(
    `${baseUrl.replace(/\/$/, "")}${path}?appId=${encodeURIComponent(appId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
    `DEYE ${path}`,
  );
  if (data?.success === false) throw new Error(`DEYE ${path}: ${data.code ?? "error"} ${data.msg ?? ""}`);
  return data;
}

async function deyeToken(): Promise<string> {
  const [appSecret, email, password] = await Promise.all([
    newappSecret("DEYE_APP_SECRET"),
    newappSecret("DEYE_EMAIL"),
    newappSecret("DEYE_PASSWORD"),
  ]);
  if (!appSecret || !email || !password) throw new Error("DEYE credentials missing");
  const auth = { appSecret, email, password: await sha256Hex(password) };
  const personal = await deyePost("/account/token", auth);
  if (!personal?.accessToken) throw new Error(`DEYE authentication failed: ${personal?.msg ?? "no token"}`);
  const info = await deyePost("/account/info", {}, personal.accessToken);
  const organizations = Array.isArray(info?.orgInfoList) ? info.orgInfoList : [];
  const organization =
    organizations.find((item: any) => String(item.companyName ?? "").toLowerCase().includes("solar")) ??
      organizations[0];
  if (!organization?.companyId) return String(personal.accessToken);
  const business = await deyePost("/account/token", { ...auth, companyId: String(organization.companyId) });
  return String(business?.accessToken ?? personal.accessToken);
}

function deyeValue(list: any[], ...keys: string[]): number | null {
  for (const key of keys) {
    const found = list.find((item) =>
      typeof item?.key === "string" && item.key.toLowerCase() === key.toLowerCase()
    );
    const value = toNumber(found?.value);
    if (value !== null) return value;
  }
  return null;
}

function mapDeye(dataList: any[], stationId: string, sn: string): Reading {
  const gridPower = deyeValue(dataList, "TotalGridPower", "TotalExternalCTPower", "GridPower");
  const batteryItem = dataList.find((item) =>
    ["batterypower", "batterychargepower"].includes(String(item?.key ?? "").toLowerCase())
  );
  const batteryValue = toNumber(batteryItem?.value);
  const batteryPower = batteryValue === null
    ? null
    : (batteryItem.key === "batteryPower" ? -batteryValue : batteryValue);
  return {
    power_w: deyeValue(
      dataList,
      "TotalSolarPower",
      "TotalActiveACOutputPower",
      "SolarPower",
      "totalDcInputPower",
    ),
    energy_kwh: deyeValue(
      dataList,
      "DailyActiveProduction",
      "DailyEnergy",
      "TodayEnergy",
      "dailyProductionActive",
    ),
    voltage_v: deyeValue(dataList, "ACVoltageRUA", "GridVoltageL1", "ACVoltage", "AC_Voltage_R"),
    current_a: deyeValue(dataList, "ACCurrentRUA", "GridCurrentL1", "ACCurrent", "AC_Current_R"),
    temperature_c: deyeValue(
      dataList,
      "AC Temperature",
      "DeviceTemperature",
      "Device_Temperature",
      "Temperature_Box",
      "acTemperature",
      "Temperature- Battery",
      "BatteryTemperature",
      "temperatureBattery",
    ),
    frequency_hz: deyeValue(
      dataList,
      "ACOutputFrequencyR",
      "GridFrequency",
      "AC_Frequency",
      "Grid_Frequency",
    ),
    consumption_w: deyeValue(dataList, "TotalConsumptionPower", "UPSLoadPower", "LoadPower"),
    grid_export_w: gridPower !== null && gridPower < 0 ? Math.abs(gridPower) : null,
    grid_import_w: gridPower !== null && gridPower > 0 ? gridPower : null,
    soc_pct: deyeValue(dataList, "SOC", "BMSSOC", "BatterySoc"),
    battery_power_w: batteryPower,
    daily_export_kwh: deyeValue(dataList, "DailyGridFeedIn", "TotalGridFeedIn"),
    daily_import_kwh: deyeValue(dataList, "DailyEnergyPurchased", "TotalEnergyBuy"),
    _raw: { stationId, sn, dataList },
  };
}

async function pollDeye(systems: SystemConfig[]): Promise<Map<string, Reading | Error>> {
  const results = new Map<string, Reading | Error>();
  try {
    const token = await deyeToken();
    const stationIds = systems.map((system) => String(system.api_station_id ?? "")).filter(Boolean);
    const snByStation = new Map<string, string>();
    for (const system of systems) {
      if (system.api_device_sn) snByStation.set(String(system.api_station_id), system.api_device_sn);
    }
    for (let index = 0; index < stationIds.length; index += 10) {
      const chunk = stationIds.slice(index, index + 10);
      try {
        const data = await deyePost("/station/device", { stationIds: chunk, page: 1, size: 200 }, token);
        const devices = data?.deviceListItems ?? data?.list ?? data?.data ?? [];
        for (const stationId of chunk) {
          const matching = devices.filter((device: any) => String(device.stationId) === stationId);
          const inverter = matching.find((device: any) =>
            device.deviceSn && String(device.deviceType ?? "").toUpperCase() === "INVERTER"
          ) ?? matching.find((device: any) =>
            device.deviceSn
          );
          if (inverter?.deviceSn) snByStation.set(stationId, String(inverter.deviceSn));
        }
      } catch (error) {
        console.warn("DEYE station/device", error);
      }
    }
    const sns = [...new Set(snByStation.values())];
    const dataBySn = new Map<string, any[]>();
    for (let index = 0; index < sns.length; index += 10) {
      const chunk = sns.slice(index, index + 10);
      const data = await deyePost("/device/latest", { deviceList: chunk }, token);
      for (const device of data?.deviceDataList ?? []) {
        dataBySn.set(String(device.deviceSn), device.dataList ?? []);
      }
    }
    let stations: any[] = [];
    if (systems.some((system) => !snByStation.has(String(system.api_station_id)))) {
      const data = await deyePost("/station/list", { page: 1, size: 100 }, token);
      stations = data?.stationList ?? data?.list ?? data?.data ?? [];
    }
    for (const system of systems) {
      const stationId = String(system.api_station_id ?? "");
      const sn = snByStation.get(stationId);
      const dataList = sn ? dataBySn.get(sn) : null;
      if (sn && dataList?.length) {
        results.set(system.id, mapDeye(dataList, stationId, sn));
      } else {
        const station = stations.find((item) => String(item.id ?? item.stationId ?? "") === stationId);
        if (station) {
          results.set(system.id, {
            power_w: toNumber(station.generationPower),
            soc_pct: toNumber(station.batterySOC),
            _raw: { fallback_source: "station_list", stationId, station },
          });
        } else {
          results.set(system.id, new Error(`DEYE: no current data for station ${stationId}`));
        }
      }
    }
  } catch (error) {
    for (const system of systems) {
      results.set(system.id, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return results;
}

async function enphaseToken(): Promise<string> {
  const [clientId, clientSecret, email, password] = await Promise.all([
    newappSecret("ENPHASE_CLIENT_ID"),
    newappSecret("ENPHASE_CLIENT_SECRET"),
    newappSecret("ENPHASE_EMAIL"),
    newappSecret("ENPHASE_PASSWORD"),
  ]);
  if (!clientId || !clientSecret || !email || !password) throw new Error("ENPHASE credentials missing");
  const params = new URLSearchParams({ grant_type: "password", username: email, password });
  const { data } = await fetchJson<any>(`https://api.enphaseenergy.com/oauth/token?${params}`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
  }, "ENPHASE OAuth");
  if (!data?.access_token) throw new Error("ENPHASE authentication returned no token");
  return String(data.access_token);
}

function extractIntervals(data: any): any[] {
  if (Array.isArray(data?.intervals)) return data.intervals;
  if (Array.isArray(data?.data?.intervals)) return data.data.intervals;
  if (Array.isArray(data?.data)) return data.data;
  return Array.isArray(data) ? data : [];
}

function intervalKwh(data: any, aliases: string[]): number | null {
  const intervals = extractIntervals(data);
  if (!intervals.length) return null;
  let wh = 0;
  for (const interval of intervals) wh += pickNumber([interval], aliases) ?? 0;
  return wh / 1000;
}

function intervalWatts(data: any, aliases: string[]): number | null {
  const intervals = extractIntervals(data);
  const latest = intervals[intervals.length - 1];
  if (!latest) return null;
  const wh = pickNumber([latest], aliases);
  const duration = pickNumber([latest], ["duration", "duration_sec", "interval_seconds"]) ?? 900;
  return wh === null ? null : Math.round(wh * 3600 / duration);
}

async function enphaseGet(
  path: string,
  token: string,
  params: Record<string, string | number> = {},
): Promise<any> {
  const [baseUrl, apiKey] = await Promise.all([
    newappSecret("ENPHASE_API_URL"),
    newappSecret("ENPHASE_API_KEY"),
  ]);
  if (!baseUrl || !apiKey) throw new Error("ENPHASE API URL/key missing");
  const query = new URLSearchParams({
    key: apiKey,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  return (await fetchJson<any>(`${baseUrl.replace(/\/$/, "")}${path}?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }, `ENPHASE ${path}`)).data;
}

async function lastReadingBySystem(systemIds: string[], since: string): Promise<Map<string, string>> {
  if (!systemIds.length) return new Map();
  const { data, error } = await db().from("newapp_energy_readings").select("system_id,read_at")
    .in("system_id", systemIds).gte("read_at", since).order("read_at", { ascending: false }).limit(2000);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) if (!map.has(row.system_id)) map.set(row.system_id, row.read_at);
  return map;
}

async function fetchEnphase(
  system: SystemConfig,
  token: string,
  closing: boolean,
): Promise<{ reading: Reading; requests: number }> {
  const systemId = String(system.api_station_id ?? "");
  if (!systemId) throw new Error("ENPHASE system id missing");
  let requests = 1;
  const summary = await enphaseGet(`/systems/${systemId}/summary`, token);
  let consumption: any = null;
  let imported: any = null;
  let exported: any = null;
  if (closing && system.has_consumption_meter) {
    const start = Math.floor(new Date(`${argentinaDate()}T03:00:00.000Z`).getTime() / 1000);
    const end = Math.floor(Date.now() / 1000);
    const safe = async (endpoint: string) => {
      try {
        requests += 1;
        return await enphaseGet(`/systems/${systemId}/telemetry/${endpoint}`, token, {
          start_at: start,
          end_at: end,
        });
      } catch (error) {
        console.warn(`ENPHASE ${endpoint} unavailable`, error);
        return null;
      }
    };
    [consumption, imported, exported] = await Promise.all([
      safe("consumption_meter"),
      safe("energy_import_telemetry"),
      safe("energy_export_telemetry"),
    ]);
  }
  const aliases = ["enwh", "energy_wh", "wh", "value"];
  return {
    requests,
    reading: {
      power_w: toNumber(summary.current_power),
      energy_kwh: toNumber(summary.energy_today) === null ? null : (toNumber(summary.energy_today)! / 1000),
      consumption_w: intervalWatts(consumption, ["enwh", "consumption_wh", ...aliases]),
      grid_import_w: intervalWatts(imported, ["enwh", "import_wh", ...aliases]),
      grid_export_w: intervalWatts(exported, ["enwh", "export_wh", ...aliases]),
      _raw: {
        summary,
        telemetry: {
          consumption_meter: consumption,
          energy_import_telemetry: imported,
          energy_export_telemetry: exported,
        },
        ...(closing
          ? {
            _daily: {
              day_consumption_kwh: intervalKwh(consumption, ["enwh", "consumption_wh", ...aliases]),
              day_grid_import_kwh: intervalKwh(imported, ["enwh", "import_wh", ...aliases]),
              day_grid_export_kwh: intervalKwh(exported, ["enwh", "export_wh", ...aliases]),
            },
          }
          : {}),
      },
    },
  };
}

async function fusionSession(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, userName, systemCode] = await Promise.all([
    newappSecret("FUSION_SOLAR_API_URL"),
    newappSecret("FUSION_SOLAR_USER"),
    newappSecret("FUSION_SOLAR_PASSWORD"),
  ]);
  if (!baseUrl || !userName || !systemCode) throw new Error("FusionSolar credentials missing");
  const response = await fetchJson<any>(`${baseUrl.replace(/\/$/, "")}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userName, systemCode }),
  }, "FusionSolar login");
  if (response.data?.failCode !== 0) {
    throw new Error(`FusionSolar login: ${response.data?.message ?? response.data?.failCode}`);
  }
  const token = response.response.headers.get("xsrf-token") ?? response.data?.data?.xsrfToken;
  if (!token) throw new Error("FusionSolar login returned no xsrf token");
  return { baseUrl: baseUrl.replace(/\/$/, ""), token: String(token) };
}

async function fusionPost(
  session: { baseUrl: string; token: string },
  endpoint: string,
  body: unknown,
): Promise<any> {
  const { data } = await fetchJson<any>(`${session.baseUrl}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xsrf-token": session.token },
    body: JSON.stringify(body),
  }, `FusionSolar ${endpoint}`);
  if (data?.failCode !== 0) throw new Error(`FusionSolar ${endpoint}: ${data?.message ?? data?.failCode}`);
  return data;
}

async function deriveFusionPower(
  systemId: string,
  daily: Record<string, number | null>,
): Promise<Record<string, number | null>> {
  const start = `${argentinaDate()}T03:00:00.000Z`;
  const previous = await db().from("newapp_energy_readings")
    .select("read_at,energy_kwh,daily_export_kwh,daily_import_kwh,raw_response")
    .eq("system_id", systemId).eq("source", "bot").gte("read_at", start)
    .order("read_at", { ascending: false }).limit(1).maybeSingle();
  if (previous.error || !previous.data) return {};
  const elapsed = Date.now() - new Date(previous.data.read_at).getTime();
  const watts = (current: number | null, old: unknown) => {
    const before = toNumber(old);
    if (current === null || before === null || elapsed < 60_000 || elapsed > 7_200_000) return null;
    const delta = current - before;
    if (delta < -0.05 || delta > 1000) return null;
    return Math.round(delta * 1000 / (elapsed / 3_600_000));
  };
  return {
    power_w: watts(daily.production, previous.data.energy_kwh),
    consumption_w: watts(daily.consumption, previous.data.raw_response?._daily?.day_consumption_kwh),
    grid_export_w: watts(
      daily.export,
      previous.data.daily_export_kwh ?? previous.data.raw_response?._daily?.day_grid_export_kwh,
    ),
    grid_import_w: watts(
      daily.import,
      previous.data.daily_import_kwh ?? previous.data.raw_response?._daily?.day_grid_import_kwh,
    ),
  };
}

async function fetchFusion(
  system: SystemConfig,
  session: { baseUrl: string; token: string },
): Promise<Reading> {
  const stationCode = String(system.api_station_id ?? "");
  if (!stationCode) throw new Error("FusionSolar station code missing");
  const response = await fusionPost(session, "getStationRealKpi", { stationCodes: stationCode });
  const kpi = response?.data?.[0]?.dataItemMap ?? {};
  const daily = {
    production: toNumber(kpi.day_power),
    consumption: toNumber(kpi.day_use_energy),
    export: toNumber(kpi.day_on_grid_energy),
    import: toNumber(kpi.day_buy_energy ?? kpi.day_grid_purchase_energy ?? kpi.day_grid_import_energy),
  };
  const derived = await deriveFusionPower(system.id, daily);
  return {
    power_w: toWatts(kpi.real_power ?? kpi.current_power ?? kpi.active_power) ?? derived.power_w,
    energy_kwh: daily.production,
    consumption_w: derived.consumption_w,
    grid_export_w: derived.grid_export_w,
    grid_import_w: derived.grid_import_w,
    daily_export_kwh: daily.export,
    daily_import_kwh: daily.import,
    _raw: {
      _station: kpi,
      _daily: {
        day_production_kwh: daily.production,
        day_consumption_kwh: daily.consumption,
        day_grid_export_kwh: daily.export,
        day_grid_import_kwh: daily.import,
        month_production_kwh: toNumber(kpi.month_power),
        total_production_kwh: toNumber(kpi.total_power),
      },
      _derived_power: derived,
    },
  };
}

async function fetchShine(system: SystemConfig): Promise<Reading> {
  const credentials = system.api_credentials ?? {};
  const [secretAccount, secretPassword, configuredUrl] = await Promise.all([
    newappSecret("SEMS_ACCOUNT"),
    newappSecret("SEMS_PASSWORD"),
    newappSecret("SHINE_API_URL"),
  ]);
  const account = credentials.account ?? credentials.email ?? credentials.username ?? secretAccount;
  const password = credentials.pwd ?? credentials.password ?? secretPassword;
  if (!account || !password) throw new Error("SHINE credentials missing");
  const login = await fetchJson<any>("https://hk.semsportal.com/api/v2/Common/CrossLogin", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Token: JSON.stringify({
        version: "v2.1.0",
        client: "ios",
        language: "en",
        timestamp: String(Math.floor(Date.now() / 1000)),
        uid: "",
        token: "",
      }),
    },
    body: JSON.stringify({ account, pwd: password, agreement_agreement: 1 }),
  }, "SHINE login");
  if (login.data?.code !== 0) throw new Error(`SHINE login: ${login.data?.msg ?? "unknown"}`);
  const session = login.data.data;
  const baseUrl = (configuredUrl ?? "https://www.semsportal.com/api").replace(/\/$/, "");
  const monitor = await fetchJson<any>(`${baseUrl}/v3/PowerStation/GetMonitorDetailByPowerstationId`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Token: JSON.stringify({
        version: "",
        client: "ios",
        language: "en",
        timestamp: String(Math.floor(Date.now() / 1000)),
        uid: session.uid,
        token: session.token,
      }),
    },
    body: JSON.stringify({ powerstation_id: system.api_station_id }),
  }, "SHINE monitor");
  if (monitor.data?.code !== 0) throw new Error(`SHINE monitor: ${monitor.data?.msg ?? "unknown"}`);
  const root = monitor.data?.data ?? {};
  const wrapper = root.inverter?.[0] ?? root.inverterList?.[0] ?? root.inverters?.[0] ?? {};
  const inverter = wrapper.invert_full ?? wrapper.invertFull ?? wrapper;
  const sources = [root, root.detail, inverter, wrapper, root.battery, root.batteries?.[0]].filter(Boolean);
  const signedGrid = pickWatts(sources, ["pgrid_w", "pgrid", "grid_power", "meter_power", "p_to_user"]);
  return {
    power_w: pickWatts(sources, ["pac", "out_pac", "total_pac", "current_power", "power", "ppv", "pv_power"]),
    energy_kwh: pickNumber(sources, ["eday", "e_day", "today_energy", "daily_energy"]),
    voltage_v: pickNumber(sources, ["vac1", "vac", "grid_voltage", "voltage"]),
    current_a: pickNumber(sources, ["iac1", "iac", "grid_current", "current"]),
    temperature_c: pickNumber(sources, ["tempperature", "temperature", "temp"]),
    frequency_hz: pickNumber(sources, ["fac1", "fac", "grid_frequency", "frequency"]),
    consumption_w: pickWatts(sources, [
      "load_power",
      "load",
      "pload",
      "p_to_load",
      "home_load_power",
      "consumption_power",
    ]),
    grid_import_w: pickWatts(sources, [
      "grid_in_power",
      "grid_import_power",
      "import_power",
      "buy_power",
      "p_from_grid",
    ]) ?? (signedGrid !== null && signedGrid > 0 ? signedGrid : null),
    grid_export_w: pickWatts(sources, [
      "grid_out_power",
      "grid_export_power",
      "export_power",
      "sell_power",
      "p_to_grid",
    ]) ?? (signedGrid !== null && signedGrid < 0 ? Math.abs(signedGrid) : null),
    soc_pct: pickNumber(sources, ["soc", "soc_text", "battery_soc"]),
    battery_power_w: pickWatts(sources, [
      "b_total_charge_power",
      "battery_power",
      "pbat_w",
      "pbat",
      "battery_charge_power",
    ]),
    _raw: monitor.data,
  };
}

async function growattGet(path: string, params: Record<string, string>, token: string): Promise<any> {
  const baseUrl = (await newappSecret("GROWATT_API_URL") ?? "https://openapi.growatt.com").replace(/\/$/, "");
  const { data } = await fetchJson<any>(`${baseUrl}${path}?${new URLSearchParams(params)}`, {
    headers: { token, "content-type": "application/json" },
  }, `GROWATT ${path}`);
  if (data?.error_code && data.error_code !== 0) {
    throw new Error(`GROWATT ${path}: ${data.error_msg ?? data.error_code}`);
  }
  return data?.data ?? null;
}

async function fetchGrowatt(system: SystemConfig): Promise<Reading> {
  const token = system.api_credentials?.token ?? await newappSecret("GROWATT_API_TOKEN");
  if (!token) throw new Error("GROWATT token missing");
  const plantId = String(system.api_station_id ?? "");
  const [list, plant, devices] = await Promise.all([
    growattGet("/v1/plant/list", { page: "1", limit: "100" }, token),
    growattGet("/v1/plant/data", { plant_id: plantId }, token),
    growattGet("/v1/device/list", { plant_id: plantId, page: "1", limit: "100" }, token).catch(() => null),
  ]);
  const plants = Array.isArray(list?.plants) ? list.plants : Array.isArray(list) ? list : [];
  const selected = plants.find((item: any) => String(item.plant_id ?? item.plantId ?? item.id) === plantId) ??
    {};
  const deviceRows = Array.isArray(devices?.devices)
    ? devices.devices
    : Array.isArray(devices)
    ? devices
    : [];
  const device =
    deviceRows.find((item: any) =>
      String(item.device_sn ?? item.deviceSn ?? item.sn) === String(system.api_device_sn)
    ) ?? deviceRows[0] ?? {};
  const sources = [plant, device, selected];
  return {
    power_w: toNumber(selected.current_power) ??
      (toNumber(plant?.current_power) === null ? null : toNumber(plant.current_power)! * 1000),
    energy_kwh: toNumber(plant?.today_energy) ??
      pickNumber(sources, ["today_energy", "daily_energy", "eToday", "eday"]),
    voltage_v: pickNumber(sources, ["voltage", "vac", "grid_voltage"]),
    current_a: pickNumber(sources, ["current", "iac", "grid_current"]),
    temperature_c: pickNumber(sources, ["temperature", "device_temperature", "temp"]),
    frequency_hz: pickNumber(sources, ["frequency", "fac", "grid_frequency"]),
    consumption_w: pickWatts(sources, ["load_power", "loadPower", "consumption_power", "house_load_power"]),
    grid_import_w: pickWatts(sources, ["grid_import_power", "import_power", "buy_power"]),
    grid_export_w: pickWatts(sources, ["grid_export_power", "export_power", "sell_power"]),
    soc_pct: pickNumber(sources, ["soc", "battery_soc", "battery_percentage"]),
    battery_power_w: pickWatts(sources, ["battery_power", "charge_power", "discharge_power"]),
    _raw: { plant: selected, plant_data: plant, device, devices: deviceRows },
  };
}

function isGrowatt(system: SystemConfig): boolean {
  return system.api_brand === "GROWATT" || system.api_credentials?.provider === "growatt" ||
    String(system.brand ?? "").toUpperCase() === "GROWATT" ||
    String(system.inverter_brand ?? "").toUpperCase() === "GROWATT";
}

async function activeSystems(brands: string[]): Promise<SystemConfig[]> {
  const query = await db().from("newapp_systems").select(SYSTEM_COLUMNS)
    .eq("is_active", true).eq("polling_enabled", true).in("api_brand", brands).order("name");
  if (query.error) throw query.error;
  return (query.data ?? []) as SystemConfig[];
}

async function throttleNight(systems: SystemConfig[]): Promise<SystemConfig[]> {
  const hour = argentinaHour();
  if (hour >= 7 && hour < 19) return systems;
  const latest = await lastReadingBySystem(
    systems.map((system) => system.id),
    new Date(Date.now() - 70 * 60_000).toISOString(),
  );
  return systems.filter((system) => {
    const value = latest.get(system.id);
    return !value || Date.now() - new Date(value).getTime() >= 55 * 60_000;
  });
}

export async function pollFast(): Promise<TaskResult> {
  const selected = await throttleNight(await activeSystems(["DEYE", "FUSION_SOLAR", "SHINE", "GROWATT"]));
  let succeeded = 0;
  let failed = 0;
  const deyeSystems = selected.filter((system) => system.api_brand === "DEYE" && !isGrowatt(system));
  const deyeResults = await pollDeye(deyeSystems);
  for (const system of deyeSystems) {
    const started = Date.now();
    const result = deyeResults.get(system.id) ?? new Error("DEYE returned no result");
    try {
      if (result instanceof Error) throw result;
      await persistReading(system, result, started);
      succeeded += 1;
    } catch (error) {
      await recordFailure(system, error, started);
      failed += 1;
    }
  }
  let fusion: { baseUrl: string; token: string } | null = null;
  const fusionSystems = selected.filter((system) => system.api_brand === "FUSION_SOLAR");
  if (fusionSystems.length) {
    try {
      fusion = await fusionSession();
    } catch (error) {
      for (const system of fusionSystems) await recordFailure(system, error, Date.now());
      failed += fusionSystems.length;
    }
  }
  for (
    const system of selected.filter((item) => item.api_brand !== "DEYE" && item.api_brand !== "FUSION_SOLAR")
  ) {
    const started = Date.now();
    try {
      const reading = isGrowatt(system) ? await fetchGrowatt(system) : await fetchShine(system);
      await persistReading(system, reading, started, isGrowatt(system) ? 3 : 2);
      succeeded += 1;
    } catch (error) {
      await recordFailure(system, error, started);
      failed += 1;
    }
  }
  if (fusion) {
    for (const system of fusionSystems) {
      const started = Date.now();
      try {
        await persistReading(system, await fetchFusion(system, fusion), started, 1);
        succeeded += 1;
      } catch (error) {
        await recordFailure(system, error, started);
        failed += 1;
      }
    }
  }
  await db().from("newapp_live_sessions").update({ status: "expired", ended_at: new Date().toISOString() })
    .eq("status", "active").lt("expires_at", new Date().toISOString());
  return {
    processed: selected.length,
    succeeded,
    failed,
    nighttime: argentinaHour() >= 19 || argentinaHour() < 7,
  };
}

export async function pollEnphase(): Promise<TaskResult> {
  const systems = await activeSystems(["ENPHASE"]);
  const hour = argentinaHour();
  const now = Date.now();
  const closing = hour >= 21 && hour < 22;
  const scheduled = [10, 12, 13, 14, 16, 18].includes(hour);
  const dayStart = `${argentinaDate()}T03:00:00.000Z`;
  const latest = await lastReadingBySystem(systems.map((system) => system.id), dayStart);
  const due = systems.filter((system) => {
    const last = latest.get(system.id);
    if (system.has_consumption_meter) return !last || now - new Date(last).getTime() >= 25 * 60_000;
    if (!scheduled) return false;
    const hourStart = new Date();
    hourStart.setUTCMinutes(0, 0, 0);
    return !last || new Date(last).getTime() < hourStart.getTime();
  });
  const usage = await db().from("newapp_api_token_usage").select("requests_count")
    .eq("api_brand", "ENPHASE").gte("called_at", dayStart);
  if (usage.error) throw usage.error;
  let requestsUsed = (usage.data ?? []).reduce((sum, row) => sum + Number(row.requests_count ?? 1), 0);
  const limit = Number(await runtimeSetting("newapp_bot_settings", "enphase_daily_request_limit") ?? "450");
  if (requestsUsed >= limit) {
    return { processed: 0, succeeded: 0, failed: 0, skipped_limit: due.length, requestsUsed };
  }
  let succeeded = 0;
  let failed = 0;
  let token: string;
  try {
    token = await enphaseToken();
  } catch (error) {
    for (const system of due) await recordFailure(system, error, Date.now());
    return { processed: due.length, succeeded: 0, failed: due.length };
  }
  for (const system of due) {
    const started = Date.now();
    try {
      const result = await fetchEnphase(system, token, closing);
      if (requestsUsed + result.requests > limit) {
        throw new Error(`ENPHASE daily request limit ${limit} reached`);
      }
      requestsUsed += result.requests;
      await persistReading(system, result.reading, started, result.requests);
      succeeded += 1;
    } catch (error) {
      await recordFailure(system, error, started);
      failed += 1;
    }
  }
  return { processed: due.length, succeeded, failed, requestsUsed, closing };
}

export async function consolidate(date: "today" | "yesterday"): Promise<TaskResult> {
  const target = argentinaDate(date === "today" ? 0 : -1);
  const result = await db().rpc("newapp_consolidate_daily", { p_date: target });
  if (result.error) throw result.error;
  if (date === "yesterday") {
    await db().from("newapp_rental_payments").update({
      status: "overdue",
      updated_at: new Date().toISOString(),
    })
      .eq("status", "pending").lt("due_date", argentinaDate());
    await disableFailingSystems();
  }
  const count = Number(result.data ?? 0);
  return { processed: count, succeeded: count, failed: 0, date: target };
}

async function disableFailingSystems(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const systems = await activeSystems(["DEYE", "ENPHASE", "FUSION_SOLAR", "SHINE", "GROWATT"]);
  for (const system of systems) {
    const success = await db().from("newapp_energy_readings").select("id", { count: "exact", head: true })
      .eq("system_id", system.id).gte("read_at", cutoff);
    if ((success.count ?? 0) > 0) continue;
    const alarm = await db().from("newapp_alarms").select("created_at").eq("system_id", system.id)
      .eq("alarm_type", "api_error").eq("is_active", true).lt("created_at", cutoff).limit(1).maybeSingle();
    if (alarm.data) {
      await db().from("newapp_systems").update({
        polling_enabled: false,
        updated_at: new Date().toISOString(),
      }).eq("id", system.id);
    }
  }
}

export async function aggregateMonthly(): Promise<TaskResult> {
  const current = new Date(`${argentinaDate()}T03:00:00.000Z`);
  current.setUTCMonth(current.getUTCMonth() - 1, 1);
  const from = current.toISOString().slice(0, 10);
  const result = await db().rpc("newapp_aggregate_monthly", { p_from_date: from });
  if (result.error) throw result.error;
  const count = Number(result.data ?? 0);
  return { processed: count, succeeded: count, failed: 0, from };
}

export async function updateUva(): Promise<TaskResult> {
  const baseUrl = (await newappSecret("BCRA_API_URL") ?? "https://api.bcra.gob.ar/estadisticas/v4.0").replace(
    /\/$/,
    "",
  );
  const variable = await newappSecret("BCRA_UVA_VARIABLE_ID") ?? "4";
  const today = argentinaDate();
  for (let offset = 0; offset >= -7; offset -= 1) {
    const date = argentinaDate(offset);
    const existing = await db().from("newapp_uva_values").select("id").eq("date", date).maybeSingle();
    if (existing.data) return { processed: 0, succeeded: 0, failed: 0, date, cached: true };
    try {
      const { data } = await fetchJson<any>(
        `${baseUrl}/Monetarias/${variable}?desde=${date}&hasta=${date}`,
        {},
        "BCRA UVA",
      );
      const detail = data?.results?.[0]?.detalle;
      if (!Array.isArray(detail) || !detail.length) continue;
      const row = detail[0];
      const value = toNumber(row.valor);
      if (value === null) continue;
      const stored = await db().from("newapp_uva_values").upsert({
        date: row.fecha ?? date,
        value_ars: value,
        source: offset === 0 ? "bcra" : "bcra_fallback",
        fetched_at: new Date().toISOString(),
      }, { onConflict: "date" });
      if (stored.error) throw stored.error;
      return { processed: 1, succeeded: 1, failed: 0, date: row.fecha ?? date, requested: today };
    } catch (error) {
      if (offset === -7) throw error;
    }
  }
  return { processed: 0, succeeded: 0, failed: 1, error: "No UVA value found in previous 7 days" };
}

function minutesSince(value: string | null | undefined): number {
  return value ? Math.round((Date.now() - new Date(value).getTime()) / 60_000) : Infinity;
}

export async function sendMorningReport(): Promise<TaskResult> {
  const systems = await activeSystems(["DEYE", "ENPHASE", "FUSION_SOLAR", "SHINE", "GROWATT"]);
  if (!systems.length) return { processed: 0, succeeded: 0, failed: 0 };
  const ids = systems.map((system) => system.id);
  const yesterday = argentinaDate(-1);
  const [daily, readings, alarms, uva] = await Promise.all([
    db().from("newapp_daily_energy").select("system_id,total_kwh").eq("date", yesterday).in("system_id", ids),
    db().from("newapp_energy_readings").select("system_id,read_at").in("system_id", ids)
      .gte("read_at", new Date(Date.now() - 2 * 3_600_000).toISOString()).order("read_at", {
        ascending: false,
      }).limit(2000),
    db().from("newapp_alarms").select("alarm_type,severity,message").eq("is_active", true).order(
      "created_at",
      { ascending: false },
    ).limit(20),
    db().from("newapp_uva_values").select("date,value_ars").order("date", { ascending: false }).limit(1)
      .maybeSingle(),
  ]);
  for (const query of [daily, readings, alarms, uva]) if (query.error) throw query.error;
  const production = new Map((daily.data ?? []).map((row) => [row.system_id, row.total_kwh]));
  const latest = new Map<string, string>();
  for (const row of readings.data ?? []) {
    if (!latest.has(row.system_id)) latest.set(row.system_id, row.read_at);
  }
  const total = [...production.values()].reduce((sum, value) => sum + Number(value ?? 0), 0);
  const lines = [
    `☀️ *SolarPower — Reporte matutino ${argentinaDate()}*`,
    `Producción ${yesterday}: *${total.toFixed(1)} kWh* en ${production.size}/${systems.length} sistemas`,
    "",
    "*Sistemas:*",
  ];
  for (const system of systems) {
    const minutes = minutesSince(latest.get(system.id));
    const icon = minutes <= 20 ? "🟢" : minutes <= 60 ? "🟡" : "🔴";
    lines.push(
      `${icon} ${system.name}: ${Number(production.get(system.id) ?? 0).toFixed(1)} kWh; ${
        Number.isFinite(minutes) ? `lectura hace ${minutes} min` : "sin lectura 2h"
      }`,
    );
  }
  const alarmRows = alarms.data ?? [];
  lines.push("", alarmRows.length ? `🚨 *Alarmas activas: ${alarmRows.length}*` : "✅ Sin alarmas activas");
  for (const alarm of alarmRows.slice(0, 5)) {
    lines.push(`${alarm.severity === "critical" ? "🚨" : "⚠️"} ${alarm.message}`);
  }
  if (uva.data) {
    lines.push(
      "",
      `UVA: $${
        Number(uva.data.value_ars).toLocaleString("es-AR", { maximumFractionDigits: 2 })
      } al ${uva.data.date}`,
    );
  }
  const phones = String(await newappSecret("MORNING_REPORT_PHONES") ?? "").split(",").map((value) =>
    value.replace(/[^0-9]/g, "")
  ).filter(Boolean);
  if (!phones.length) throw new Error("MORNING_REPORT_PHONES is not configured");
  let succeeded = 0;
  let failed = 0;
  for (const phone of phones) {
    try {
      await sendPulseText("newapp", newappSecret, phone, lines.join("\n"));
      succeeded += 1;
    } catch (error) {
      console.error("NEWAPP morning report", error);
      failed += 1;
    }
  }
  return { processed: phones.length, succeeded, failed, systems: systems.length };
}

type Discovered = {
  name: string;
  brand: string;
  inverter_brand: string;
  api_brand: string;
  api_station_id: string;
  api_device_sn?: string | null;
  capacity_kw: number;
  api_credentials?: Record<string, unknown> | null;
};

async function discoverDeye(): Promise<Discovered[]> {
  const token = await deyeToken();
  const response = await deyePost("/station/list", { page: 1, size: 100 }, token);
  const stations = response?.stationList ?? response?.list ?? response?.data ?? [];
  return stations.map((station: any) => ({
    name: station.name ?? station.stationName ?? `DEYE ${station.id ?? station.stationId}`,
    brand: "DEYE",
    inverter_brand: "DEYE",
    api_brand: "DEYE",
    api_station_id: String(station.id ?? station.stationId),
    api_device_sn: null,
    capacity_kw: toNumber(station.installedCapacity ?? station.generatingCapacity) ?? 0,
  }));
}

async function discoverEnphase(): Promise<Discovered[]> {
  const token = await enphaseToken();
  const response = await enphaseGet("/systems", token, { size: 100 });
  const systems = response?.systems ?? (Array.isArray(response) ? response : []);
  return systems.map((system: any) => ({
    name: system.name ?? `Enphase ${system.system_id}`,
    brand: "ENPHASE",
    inverter_brand: "Enphase",
    api_brand: "ENPHASE",
    api_station_id: String(system.system_id),
    api_device_sn: null,
    capacity_kw: Math.max(0, (toNumber(system.system_size) ?? 0) / 1000),
  }));
}

async function discoverFusion(session: { baseUrl: string; token: string }): Promise<Discovered[]> {
  const response = await fusionPost(session, "getStationList", { pageNo: 1, pageSize: 100 });
  const stations = response?.data?.list ?? response?.data ?? [];
  return stations.map((station: any) => {
    let capacity = toNumber(station.capacity ?? station.installedCapacity ?? station.plantCapacity) ?? 0;
    if (capacity > 0 && capacity < 1) capacity *= 1000;
    return {
      name: station.stationName ?? `FusionSolar ${station.stationCode}`,
      brand: "FUSION_SOLAR",
      inverter_brand: "Huawei",
      api_brand: "FUSION_SOLAR",
      api_station_id: String(station.stationCode),
      api_device_sn: null,
      capacity_kw: capacity,
    };
  });
}

async function discoverGrowatt(): Promise<Discovered[]> {
  const token = await newappSecret("GROWATT_API_TOKEN");
  if (!token) return [];
  const response = await growattGet("/v1/plant/list", { page: "1", limit: "100" }, token);
  const plants = response?.plants ?? (Array.isArray(response) ? response : []);
  return plants.map((plant: any) => ({
    name: plant.name ?? plant.plantName ?? `Growatt ${plant.plant_id ?? plant.id}`,
    brand: "GROWATT",
    inverter_brand: "Growatt",
    api_brand: "SHINE",
    api_station_id: String(plant.plant_id ?? plant.plantId ?? plant.id),
    api_device_sn: null,
    capacity_kw: toNumber(plant.peak_power ?? plant.capacity) ?? 0,
    api_credentials: { provider: "growatt" },
  }));
}

export async function discoverSystems(): Promise<TaskResult> {
  const tasks = await Promise.allSettled([
    discoverDeye(),
    discoverEnphase(),
    fusionSession().then(discoverFusion),
    discoverGrowatt(),
  ]);
  const discovered: Discovered[] = [];
  let failed = 0;
  for (const result of tasks) {
    if (result.status === "fulfilled") discovered.push(...result.value);
    else {
      failed += 1;
      console.error("NEWAPP discovery", result.reason);
    }
  }
  const current = await db().from("newapp_systems").select("id,api_brand,api_station_id,api_device_sn");
  if (current.error) throw current.error;
  const existing = new Map(
    (current.data ?? []).map((row) => [`${row.api_brand}:${row.api_station_id}`, row]),
  );
  let inserted = 0;
  for (const system of discovered) {
    const key = `${system.api_brand}:${system.api_station_id}`;
    const row = existing.get(key);
    if (!row) {
      const result = await db().from("newapp_systems").insert({
        ...system,
        is_active: true,
        polling_enabled: true,
        polling_interval_min: system.api_brand === "ENPHASE" ? 15 : 5,
      });
      if (!result.error) inserted += 1;
    } else if (!row.api_device_sn && system.api_device_sn) {
      await db().from("newapp_systems").update({
        api_device_sn: system.api_device_sn,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }
  return {
    processed: tasks.length,
    succeeded: tasks.length - failed,
    failed,
    discovered: discovered.length,
    inserted,
  };
}

export async function executeNewappTask(task: string): Promise<TaskResult> {
  switch (task) {
    case "poll_fast":
      return await pollFast();
    case "poll_enphase":
      return await pollEnphase();
    case "consolidate_today":
      return await consolidate("today");
    case "consolidate_yesterday":
      return await consolidate("yesterday");
    case "aggregate_monthly":
      return await aggregateMonthly();
    case "uva":
      return await updateUva();
    case "morning_report":
      return await sendMorningReport();
    case "discovery":
      return await discoverSystems();
    default:
      throw new Error(`Unknown NEWAPP task: ${task}`);
  }
}
