#!/usr/bin/env python3
"""Import energy-analysis and NEWAPP credentials into Supabase Vault.

Secret values are never printed or written inside the repository.
"""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def first(values: dict[str, str], *keys: str, default: str = "") -> str:
    for key in keys:
        value = values.get(key, "").strip()
        if value:
            return value
    return default


def call_rpc(url: str, service_key: str, function: str, name: str, value: str) -> None:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/rpc/{function}",
        data=json.dumps({"p_name": name, "p_value": value}).encode("utf-8"),
        method="POST",
        headers={
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status not in (200, 204):
                raise RuntimeError(f"unexpected HTTP {response.status}")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{function}({name}) failed: HTTP {error.code}: {body[:300]}") from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--energy-env", type=Path, required=True)
    parser.add_argument("--newapp-env", type=Path, required=True)
    args = parser.parse_args()

    energy = read_env(args.energy_env)
    newapp = read_env(args.newapp_env)
    url = first(newapp, "SUPABASE_URL") or first(energy, "SUPABASE_URL")
    service_key = first(newapp, "SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY") or first(
        energy, "SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY"
    )
    if not url or not service_key:
        raise SystemExit("SUPABASE_URL and a service role key are required")

    energy_values = {
        "ANTHROPIC_API_KEY": first(energy, "ANTHROPIC_API_KEY"),
        "ENERGY_TRIAGE_MODEL": first(energy, "ENERGY_TRIAGE_MODEL", default="claude-haiku-4-5-20251001"),
        "ENERGY_ANALYSIS_MODEL": first(energy, "ENERGY_ANALYSIS_MODEL", default="claude-sonnet-4-5"),
    }
    newapp_values = {
        "DEYE_API_URL": first(newapp, "DEYE_API_URL", default="https://us1-developer.deyecloud.com/v1.0"),
        "DEYE_APP_ID": first(newapp, "DEYE_APP_ID"),
        "DEYE_APP_SECRET": first(newapp, "DEYE_APP_SECRET"),
        "DEYE_EMAIL": first(newapp, "DEYE_EMAIL"),
        "DEYE_PASSWORD": first(newapp, "DEYE_PASSWORD"),
        "ENPHASE_API_URL": first(newapp, "ENPHASE_API_URL", default="https://api.enphaseenergy.com/api/v4"),
        "ENPHASE_CLIENT_ID": first(newapp, "ENPHASE_CLIENT_ID"),
        "ENPHASE_CLIENT_SECRET": first(newapp, "ENPHASE_CLIENT_SECRET"),
        "ENPHASE_API_KEY": first(newapp, "ENPHASE_API_KEY"),
        "ENPHASE_EMAIL": first(newapp, "ENPHASE_EMAIL"),
        "ENPHASE_PASSWORD": first(newapp, "ENPHASE_PASSWORD"),
        "FUSION_SOLAR_API_URL": first(newapp, "FUSION_SOLAR_API_URL", default="https://eu5.fusionsolar.huawei.com/thirdData"),
        "FUSION_SOLAR_USER": first(newapp, "FUSION_SOLAR_USER"),
        "FUSION_SOLAR_PASSWORD": first(newapp, "FUSION_SOLAR_PASSWORD"),
        "SHINE_API_URL": first(newapp, "SHINE_API_URL", default="https://www.semsportal.com/api"),
        "SEMS_ACCOUNT": first(newapp, "SEMS_ACCOUNT", "SHINE_ACCOUNT"),
        "SEMS_PASSWORD": first(newapp, "SEMS_PASSWORD", "SHINE_PASSWORD"),
        "GROWATT_API_URL": first(newapp, "GROWATT_API_URL", default="https://openapi.growatt.com"),
        "GROWATT_API_TOKEN": first(newapp, "GROWATT_API_TOKEN", "SHINOPHONE_API_TOKEN"),
        "GROWATT_ACCOUNT": first(newapp, "GROWATT_ACCOUNT", "SHINOPHONE_ACCOUNT"),
        "GROWATT_PASSWORD": first(newapp, "GROWATT_PASSWORD", "SHINOPHONE_PASSWORD"),
        "BCRA_API_URL": first(newapp, "BCRA_API_URL", default="https://api.bcra.gob.ar/estadisticas/v4.0"),
        "BCRA_UVA_VARIABLE_ID": first(newapp, "BCRA_UVA_VARIABLE_ID", default="4"),
        "SENDPULSE_API_ID": first(newapp, "SENDPULSE_API_ID"),
        "SENDPULSE_API_SECRET": first(newapp, "SENDPULSE_API_SECRET"),
        "SENDPULSE_BOT_ID": first(newapp, "SENDPULSE_BOT_ID"),
        "MORNING_REPORT_PHONES": first(newapp, "MORNING_REPORT_PHONES", "RICARDO_PHONE"),
    }

    imported = 0
    for name, value in energy_values.items():
        if value:
            call_rpc(url, service_key, "energy_set_runtime_secret", name, value)
            print(f"Imported energy secret {name}")
            imported += 1
    for name, value in newapp_values.items():
        if value:
            call_rpc(url, service_key, "newapp_set_runtime_secret", name, value)
            print(f"Imported NEWAPP secret {name}")
            imported += 1
    print(f"Imported {imported} encrypted runtime secrets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
