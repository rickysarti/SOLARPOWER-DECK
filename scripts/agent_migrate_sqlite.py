#!/usr/bin/env python3
"""Migrate the legacy SQLite database into isolated agent_* Supabase tables."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


TABLES = {
    "contacts": ("agent_contacts", {
        "id": "legacy_id", "phone": "phone", "name": "name", "email": "email",
        "label": "label", "stage": "stage", "tipo": "tipo", "otro_count": "otro_count",
        "bill_received": "bill_received", "roof_type": "roof_type",
        "connection_type": "connection_type", "locality": "locality",
        "product_interest": "product_interest", "notes": "notes",
        "notified_ricardo": "notified_ricardo", "human_mode": "human_mode",
        "first_contact": "first_contact", "last_contact": "last_contact",
    }),
    "messages": ("agent_messages", {
        "id": "legacy_id", "contact_phone": "contact_phone", "role": "role",
        "content": "content", "timestamp": "created_at",
    }),
    "pending_actions": ("agent_pending_actions", {
        "id": "legacy_id", "contact_phone": "contact_phone", "action_type": "action_type",
        "description": "description", "created_at": "created_at", "resolved": "resolved",
    }),
    "agenda_events": ("agent_agenda_events", {
        "id": "legacy_id", "google_event_id": "google_event_id", "title": "title",
        "description": "description", "date_time": "date_time", "duration_minutes": "duration_minutes",
        "location": "location", "event_type": "event_type", "contact_name": "contact_name",
        "contact_phone": "contact_phone", "status": "status", "reminder_sent": "reminder_sent",
        "created_at": "created_at",
    }),
    "agenda_messages": ("agent_agenda_messages", {
        "id": "legacy_id", "role": "role", "content": "content", "timestamp": "created_at",
    }),
    "pending_notifications": ("agent_pending_notifications", {
        "id": "legacy_id", "phone": "phone", "message": "message", "created_at": "created_at",
        "sent": "sent", "sent_at": "sent_at",
    }),
    "conversation_logs": ("agent_conversation_logs", {
        "id": "legacy_id", "contact_phone": "contact_phone", "event_type": "event_type",
        "label": "label", "summary": "summary", "metadata": "metadata", "created_at": "created_at",
    }),
}


def load_env(path: Path) -> dict[str, str]:
    values = dict(os.environ)
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


def normalize_value(column: str, value):
    if column in {"bill_received", "notified_ricardo", "human_mode", "resolved", "reminder_sent", "sent"}:
        return bool(value)
    if column == "metadata" and isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {"legacy_text": value}
    return value


def upsert(url: str, key: str, table: str, rows: list[dict]) -> None:
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}?on_conflict=legacy_id"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(rows).encode("utf-8"),
        method="POST",
        headers={
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
            "prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError(f"Unexpected HTTP status {response.status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{table}: HTTP {exc.code}: {body[:500]}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=250)
    args = parser.parse_args()
    env = load_env(args.env_file)
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")

    connection = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    for source, (target, mapping) in TABLES.items():
        source_columns = {row[1] for row in connection.execute(f"pragma table_info({source})")}
        selected = [column for column in mapping if column in source_columns]
        if not selected:
            continue
        cursor = connection.execute(f"select {','.join(selected)} from {source} order by id")
        total = 0
        while True:
            batch = cursor.fetchmany(args.batch_size)
            if not batch:
                break
            rows = []
            for record in batch:
                row = {mapping[column]: normalize_value(mapping[column], record[column]) for column in selected}
                rows.append(row)
            upsert(url, key, target, rows)
            total += len(rows)
        print(f"{source} -> {target}: {total}")
    connection.close()


if __name__ == "__main__":
    main()
