#!/usr/bin/env python3
"""Import legacy agent credentials into Supabase Vault without printing values."""

from __future__ import annotations

import json
import sys
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


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: agent_import_runtime_secrets.py /path/to/.env", file=sys.stderr)
        return 2
    values = read_env(Path(sys.argv[1]))
    supabase_url = values.get("SUPABASE_URL", "").rstrip("/")
    service_key = values.get("SUPABASE_SERVICE_KEY") or values.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("Missing SUPABASE_URL or service role key", file=sys.stderr)
        return 1

    mappings = {
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL": "ANTHROPIC_MODEL",
        "SENDPULSE_API_ID": "SENDPULSE_API_ID",
        "SENDPULSE_API_SECRET": "SENDPULSE_API_SECRET",
        "SENDPULSE_BOT_ID": "SENDPULSE_BOT_ID",
        "AGENT_RICARDO_PHONE": "RICARDO_PHONE",
        "AGENT_AGENDA_PHONE": "AGENDA_PHONE",
        "AGENT_GUILLERMO_PHONE": "RICARDO_GUILLERMO_PHONE",
        "GOOGLE_CLIENT_ID": "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET": "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN": "GOOGLE_REFRESH_TOKEN",
        "GOOGLE_CALENDAR_ID": "GOOGLE_CALENDAR_ID",
    }
    imported: list[str] = []
    for destination, source in mappings.items():
        secret = values.get(source)
        if not secret:
            continue
        request = urllib.request.Request(
            f"{supabase_url}/rest/v1/rpc/agent_set_runtime_secret",
            data=json.dumps({"p_name": destination, "p_value": secret}).encode(),
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
            print(f"Failed to import {destination}: HTTP {error.code}", file=sys.stderr)
            return 1
        imported.append(destination)
        print(f"Imported {destination}")

    print(f"Imported {len(imported)} agent runtime secrets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
