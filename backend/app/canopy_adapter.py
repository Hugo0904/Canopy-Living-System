from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .activity_contract import ActivityContractError, validate_activity_projection
from .evolution_lab import build_evolution_lab_projection


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CanopySnapshotUnavailable(RuntimeError):
    """Raised when the normalized public snapshot cannot be collected."""


def empty_activity() -> dict[str, Any]:
    today = now_iso()
    return {
        "schema_version": 3,
        "contract_id": "canopy.observation.activity",
        "window": {"days": 30, "from": today, "to": today},
        "limits": {},
        "privacy": {
            "raw_prompts_included": False,
            "source_excerpts_included": False,
            "absolute_paths_included": False,
            "sensitive_records_included": False,
            "raw_tool_inputs_included": False,
            "raw_tool_outputs_included": False,
            "hidden_reasoning_included": False,
        },
        "coverage": {},
        "events": [],
        "daily": [],
        "milestones": [],
        "modules": {},
        "source_counts": {},
        "omitted": {},
        "truncated": False,
        "sync_cursor": "",
    }


class CanopyAdapter:
    """Read Canopy's public observation contracts without re-parsing Core state."""

    def __init__(self, canopy_root: Path, *, cache_seconds: int = 20) -> None:
        self.canopy_root = canopy_root.resolve()
        self.cache_seconds = cache_seconds
        self._cached: dict[str, Any] | None = None
        self._cached_at = 0.0
        self._lock = threading.Lock()
        self._activity_lock = threading.Lock()
        self._evolution_lab_lock = threading.Lock()
        self._evolution_lab_cached: dict[str, Any] | None = None
        self._evolution_lab_cached_at = 0.0

    def collect(self, *, refresh: bool = False) -> dict[str, Any]:
        with self._lock:
            if (
                not refresh
                and self._cached is not None
                and time.monotonic() - self._cached_at < self.cache_seconds
            ):
                return self._cached
            snapshot = self._collect_public_contract()
            self._cached = snapshot
            self._cached_at = time.monotonic()
            return snapshot

    def _public_error(self, detail: str) -> str:
        bounded = " ".join(str(detail or "").split())[:300]
        return bounded.replace(str(self.canopy_root), "Canopy")

    def _run_json(self, arguments: list[str], *, timeout: int = 60) -> tuple[dict[str, Any], str]:
        command = [sys.executable, str(self.canopy_root / "canopy"), *arguments]
        try:
            result = subprocess.run(
                command,
                cwd=self.canopy_root,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {}, f"Canopy command timed out after {timeout}s"
        except (OSError, RuntimeError) as exc:
            detail = getattr(exc, "strerror", "") or exc.__class__.__name__
            return {}, f"Canopy command unavailable: {detail}"
        if result.returncode:
            return {}, self._public_error(
                (result.stderr or result.stdout).strip() or f"exit {result.returncode}"
            )
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            return {}, f"invalid JSON from {' '.join(arguments)}: {exc}"
        return (payload if isinstance(payload, dict) else {}), ""

    def collect_evolution_lab(self) -> dict[str, Any]:
        """Collect a bounded, read-only evolution projection only when requested."""
        with self._evolution_lab_lock:
            if (
                self._evolution_lab_cached is not None
                and time.monotonic() - self._evolution_lab_cached_at < self.cache_seconds
            ):
                return self._evolution_lab_cached
            observation, observation_error = self._run_json(
                ["observe", "evolution", "--json"],
                timeout=30,
            )
            projection = build_evolution_lab_projection(
                observation=observation,
                observation_error=observation_error,
                generated_at=now_iso(),
            )
            self._evolution_lab_cached = projection
            self._evolution_lab_cached_at = time.monotonic()
            return projection

    def collect_activity(
        self,
        *,
        since: str = "",
        days: int = 60,
        max_events: int = 500,
    ) -> tuple[dict[str, Any], str]:
        with self._activity_lock:
            arguments = [
                "observe",
                "activity",
                "--json",
                "--days",
                str(max(1, min(days, 60))),
                "--max-events",
                str(max(1, min(max_events, 600))),
            ]
            if since.strip():
                arguments.extend(["--since", since.strip()])
            payload, error = self._run_json(arguments, timeout=30)
            contract_error = ""
            if payload:
                try:
                    return validate_activity_projection(payload), ""
                except ActivityContractError as exc:
                    contract_error = f"invalid activity contract: {exc}"
            try:
                snapshot = self.collect(refresh=True)
            except CanopySnapshotUnavailable:
                snapshot = {}
            fallback = snapshot.get("activity")
            if isinstance(fallback, dict):
                try:
                    sanitized = validate_activity_projection(fallback)
                except ActivityContractError as exc:
                    fallback_error = f"invalid snapshot activity contract: {exc}"
                else:
                    warning = error or contract_error or "activity CLI unavailable"
                    return sanitized, f"{warning}; using snapshot activity"
            else:
                fallback_error = "snapshot activity contract unavailable"
            warning = error or contract_error or fallback_error
            if fallback_error and fallback_error not in warning:
                warning = f"{warning}; {fallback_error}"
            return empty_activity(), warning or "Canopy activity contract unavailable"

    def _collect_public_contract(self) -> dict[str, Any]:
        if not (self.canopy_root / "canopy").is_file():
            raise CanopySnapshotUnavailable("Canopy public snapshot command is unavailable")
        payload, error = self._run_json(["observe", "snapshot", "--json"], timeout=120)
        if error:
            raise CanopySnapshotUnavailable(
                f"Canopy public snapshot unavailable: {self._public_error(error)}"
            )
        if not payload:
            raise CanopySnapshotUnavailable("Canopy public snapshot returned no data")
        return payload
