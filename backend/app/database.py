from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class ObservatoryDatabase:
    def __init__(
        self,
        path: Path,
        *,
        snapshot_retention_days: int = 30,
        snapshot_max_records: int = 500,
        treatment_retention_days: int = 90,
        treatment_max_records: int = 200,
        life_event_retention_days: int = 60,
        life_event_max_records: int = 5000,
    ) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.snapshot_retention_days = snapshot_retention_days
        self.snapshot_max_records = snapshot_max_records
        self.treatment_retention_days = treatment_retention_days
        self.treatment_max_records = treatment_max_records
        self.life_event_retention_days = life_event_retention_days
        self.life_event_max_records = life_event_max_records

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    captured_at TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    overall_status TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at
                    ON snapshots(captured_at DESC);

                CREATE TABLE IF NOT EXISTS treatment_requests (
                    id TEXT PRIMARY KEY,
                    request_type TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    intent TEXT NOT NULL,
                    operator_prompt TEXT NOT NULL,
                    status TEXT NOT NULL,
                    proposal_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_treatment_updated_at
                    ON treatment_requests(updated_at DESC);

                CREATE TABLE IF NOT EXISTS life_events (
                    id TEXT PRIMARY KEY,
                    occurred_at TEXT NOT NULL,
                    correlation_id TEXT NOT NULL,
                    module_id TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    status TEXT NOT NULL,
                    growth_stage TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_life_events_occurred_at
                    ON life_events(occurred_at DESC);
                CREATE INDEX IF NOT EXISTS idx_life_events_correlation
                    ON life_events(correlation_id, occurred_at DESC);
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)",
                (self._now(),),
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)",
                (self._now(),),
            )
            life_detail_migration = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 3"
            ).fetchone()
            if life_detail_migration is None:
                # life_events is a rebuildable projection. Reimporting is safer
                # than leaving older vague payloads without assistance and
                # verification detail beside the v3 activity contract.
                connection.execute("DELETE FROM life_events")
                connection.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)",
                    (self._now(),),
                )

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _cutoff(self, days: int) -> str:
        return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")

    def _prune_snapshots(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            DELETE FROM snapshots
            WHERE captured_at < ?
              AND id != (SELECT id FROM snapshots ORDER BY id DESC LIMIT 1)
            """,
            (self._cutoff(self.snapshot_retention_days),),
        )
        connection.execute(
            """
            DELETE FROM snapshots
            WHERE id NOT IN (
                SELECT id FROM snapshots ORDER BY id DESC LIMIT ?
            )
            """,
            (self.snapshot_max_records,),
        )

    def _prune_treatments(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            "DELETE FROM treatment_requests WHERE updated_at < ?",
            (self._cutoff(self.treatment_retention_days),),
        )
        connection.execute(
            """
            DELETE FROM treatment_requests
            WHERE id NOT IN (
                SELECT id FROM treatment_requests ORDER BY updated_at DESC LIMIT ?
            )
            """,
            (self.treatment_max_records,),
        )

    def _prune_life_events(self, connection: sqlite3.Connection) -> None:
        connection.execute(
            "DELETE FROM life_events WHERE occurred_at < ?",
            (self._cutoff(self.life_event_retention_days),),
        )
        connection.execute(
            """
            DELETE FROM life_events
            WHERE id NOT IN (
                SELECT id FROM life_events ORDER BY occurred_at DESC LIMIT ?
            )
            """,
            (self.life_event_max_records,),
        )

    def save_snapshot(self, payload: dict[str, Any]) -> bool:
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        stable_payload = {
            key: value for key, value in payload.items() if key != "generated_at"
        }
        stable_serialized = json.dumps(
            stable_payload, ensure_ascii=False, sort_keys=True
        )
        payload_hash = hashlib.sha256(stable_serialized.encode("utf-8")).hexdigest()
        with self._lock, self.connect() as connection:
            self._prune_snapshots(connection)
            latest = connection.execute(
                "SELECT payload_hash FROM snapshots ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if latest and latest["payload_hash"] == payload_hash:
                return False
            connection.execute(
                """
                INSERT INTO snapshots(captured_at, payload_hash, overall_status, payload_json)
                VALUES(?, ?, ?, ?)
                """,
                (
                    str(payload.get("generated_at", self._now())),
                    payload_hash,
                    str((payload.get("overall") or {}).get("status", "unknown")),
                    serialized,
                ),
            )
            self._prune_snapshots(connection)
        return True

    def snapshot_history(self, limit: int = 30) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, captured_at, overall_status, payload_json
                FROM snapshots ORDER BY id DESC LIMIT ?
                """,
                (max(1, min(limit, 100)),),
            ).fetchall()
        history: list[dict[str, Any]] = []
        for row in rows:
            payload = json.loads(row["payload_json"])
            history.append(
                {
                    "id": row["id"],
                    "captured_at": row["captured_at"],
                    "overall_status": row["overall_status"],
                    "scores": (payload.get("overall") or {}).get("scores", {}),
                }
            )
        return history

    def latest_snapshot(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM snapshots ORDER BY id DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def create_treatment(
        self,
        *,
        request_type: str,
        target_type: str,
        target_id: str,
        intent: str,
        operator_prompt: str,
        proposal: dict[str, Any],
    ) -> dict[str, Any]:
        request_id = f"TR-{uuid.uuid4().hex[:12].upper()}"
        now = self._now()
        with self._lock, self.connect() as connection:
            connection.execute(
                """
                INSERT INTO treatment_requests(
                    id, request_type, target_type, target_id, intent,
                    operator_prompt, status, proposal_json, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    request_type,
                    target_type,
                    target_id,
                    intent,
                    operator_prompt,
                    "awaiting_ai_review",
                    json.dumps(proposal, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            self._prune_treatments(connection)
        return self.get_treatment(request_id) or {}

    def get_treatment(self, request_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM treatment_requests WHERE id = ?", (request_id,)
            ).fetchone()
        return self._treatment_row(row) if row else None

    def list_treatments(self, limit: int = 30) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM treatment_requests ORDER BY updated_at DESC LIMIT ?",
                (max(1, min(limit, 100)),),
            ).fetchall()
        return [self._treatment_row(row) for row in rows]

    def _treatment_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "request_type": row["request_type"],
            "target_type": row["target_type"],
            "target_id": row["target_id"],
            "intent": row["intent"],
            "operator_prompt": row["operator_prompt"],
            "status": row["status"],
            "proposal": json.loads(row["proposal_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def import_life_events(self, activity: dict[str, Any]) -> dict[str, int]:
        raw_events = activity.get("events")
        events = raw_events if isinstance(raw_events, list) else []
        accepted = 0
        now = self._now()
        with self._lock, self.connect() as connection:
            for event in events:
                if not isinstance(event, dict):
                    continue
                event_id = str(event.get("id", "")).strip()
                occurred_at = str(event.get("occurred_at", "")).strip()
                if not event_id.startswith("activity:") or not occurred_at:
                    continue
                payload = {
                    **event,
                    "id": event_id,
                    "occurred_at": occurred_at,
                    "correlation_id": str(event.get("correlation_id", "")),
                    "module_id": str(event.get("module_id", "hooks")),
                    "phase": str(event.get("phase", "observed")),
                    "status": str(event.get("status", "observed")),
                    "growth_stage": str(event.get("growth_stage", "")),
                }
                connection.execute(
                    """
                    INSERT INTO life_events(
                        id, occurred_at, correlation_id, module_id, phase,
                        status, growth_stage, payload_json, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        occurred_at=excluded.occurred_at,
                        correlation_id=excluded.correlation_id,
                        module_id=excluded.module_id,
                        phase=excluded.phase,
                        status=excluded.status,
                        growth_stage=excluded.growth_stage,
                        payload_json=excluded.payload_json,
                        updated_at=excluded.updated_at
                    """,
                    (
                        event_id,
                        occurred_at,
                        payload["correlation_id"],
                        payload["module_id"],
                        payload["phase"],
                        payload["status"],
                        payload["growth_stage"],
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                        now,
                    ),
                )
                accepted += 1
            self._prune_life_events(connection)
            persisted = int(
                connection.execute("SELECT COUNT(*) FROM life_events").fetchone()[0]
            )
        return {"accepted": accepted, "persisted": persisted}

    def list_life_events(self, limit: int = 160) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json FROM life_events
                ORDER BY occurred_at DESC LIMIT ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def life_event_cursor(self) -> str:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT occurred_at FROM life_events ORDER BY occurred_at DESC LIMIT 1"
            ).fetchone()
        return str(row["occurred_at"]) if row else ""

    def life_event_stats(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS total, MIN(occurred_at) AS oldest,
                       MAX(occurred_at) AS newest
                FROM life_events
                """
            ).fetchone()
        return {
            "total": int(row["total"] or 0),
            "oldest": str(row["oldest"] or ""),
            "newest": str(row["newest"] or ""),
        }
