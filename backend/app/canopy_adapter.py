from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evolution_lab import build_evolution_lab_projection


STATUS_ORDER = {"healthy": 0, "attention": 1, "critical": 2, "unknown": 3}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalized_status(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if value in {"pass", "passed", "healthy", "normal", "sufficient", "stable", "active"}:
        return "healthy"
    if value in {"warn", "warning", "attention", "degraded", "pressure", "collecting"}:
        return "attention"
    if value in {"fail", "failed", "critical", "blocked", "error"}:
        return "critical"
    return "unknown"


def worst_status(values: list[str]) -> str:
    usable = [value for value in values if value != "unknown"]
    if not usable:
        return "unknown"
    return max(usable, key=lambda value: STATUS_ORDER.get(value, 3))


def empty_activity() -> dict[str, Any]:
    today = now_iso()
    return {
        "schema_version": 2,
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
            return {}, (result.stderr or result.stdout).strip() or f"exit {result.returncode}"
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
            if payload and payload.get("contract_id") == "canopy.observation.activity":
                return payload, ""
            snapshot = self.collect(refresh=True)
            fallback = snapshot.get("activity")
            if isinstance(fallback, dict):
                return fallback, error or "activity CLI unavailable; using snapshot activity"
            return empty_activity(), error or "Canopy activity contract unavailable"

    def _collect_public_contract(self) -> dict[str, Any]:
        if not (self.canopy_root / "canopy").is_file():
            return self._disconnected_snapshot("Canopy CLI is missing")
        payload, error = self._run_json(["observe", "snapshot", "--json"], timeout=120)
        if payload and not error:
            payload["source_mode"] = "canopy_public_contract"
            return payload
        snapshot = self._collect_compatibility_snapshot()
        snapshot["source_mode"] = "compatibility_adapter"
        snapshot.setdefault("issues", []).append(
            {
                "severity": "attention",
                "title": "Canopy observation contract unavailable",
                "detail": error or "falling back to bounded compatibility commands",
            }
        )
        return snapshot

    def _collect_compatibility_snapshot(self) -> dict[str, Any]:
        doctor, doctor_error = self._run_json(["doctor", "--json"], timeout=120)
        resources, resource_error = self._run_json(["resource", "status", "--json"])
        roles, role_error = self._run_json(["role", "list", "--json"])
        evolution, evolution_error = self._run_json(["evolution", "validate", "--json"])
        seed_health, seed_error = self._seed_health()
        cards = self._read_cards()
        runtime = seed_health.get("runtime_observations", {}) if seed_health else {}

        doctor_checks = doctor.get("checks", []) if isinstance(doctor.get("checks"), list) else []
        hook_check = next(
            (item for item in doctor_checks if isinstance(item, dict) and item.get("name") == "Codex hooks"),
            {},
        )
        seed_behavior = normalized_status(seed_health.get("behavioral_status"))
        resource_pressure = normalized_status((resources.get("pressure") or {}).get("id"))
        role_status = normalized_status(roles.get("status"))
        evolution_status = normalized_status(evolution.get("status"))
        modules = [
            self._module(
                "seed-memory",
                "Seed Memory",
                "roots",
                seed_behavior,
                "蒸餾操作者文化、偏好、教導與工具映射。",
                {
                    "active_cards": seed_health.get("active_cards", len(cards)),
                    "candidate_cards": seed_health.get("candidate_cards", 0),
                    "structural_score": seed_health.get("structural_score"),
                },
                confidence="high" if seed_health else "low",
            ),
            self._module(
                "brain",
                "Seed Brain",
                "nervous-system",
                "attention" if int(seed_health.get("open_miss_receipts", 0) or 0) else seed_behavior,
                "負責語氣、intake、未命中分析、行動回條與學習閉環。",
                {
                    "miss_receipts": seed_health.get("miss_receipts", 0),
                    "open_misses": seed_health.get("open_miss_receipts", 0),
                    "required_resolution_rate": (seed_health.get("execution") or {}).get("required_resolution_rate"),
                },
            ),
            self._module(
                "hooks",
                "Preflight / Postflight",
                "gate",
                normalized_status(hook_check.get("status")),
                "每回合合成角色、Seed、意圖與閉環義務。",
                {
                    "observed_preflights": runtime.get("observed_preflights", 0),
                    "average_context_chars": runtime.get("average_total_bundle_chars", 0),
                },
            ),
            self._module(
                "evolution",
                "Evolution",
                "growth-ring",
                evolution_status,
                "把觀察轉為可逆、可驗證、可監測的 Canopy 改良。",
                {
                    "contract_version": evolution.get("contract_version", ""),
                    "routing_cases": evolution.get("routing_case_count", 0),
                    "runtime_chars": evolution.get("contract_bundle_chars", 0),
                },
            ),
            self._module(
                "roles",
                "Agent Roles",
                "pavilions",
                role_status,
                "在領域文化、工具或驗證契約確實有增益時採用一個 bounded 角色。",
                {
                    "active": roles.get("active_count", 0),
                    "deprecated": roles.get("deprecated_count", 0),
                    "recent_selections": sum((runtime.get("role_statuses") or {}).values()) if isinstance(runtime.get("role_statuses"), dict) else 0,
                },
            ),
            self._module(
                "resources",
                "Resource Lifecycle",
                "circulation",
                resource_pressure,
                "管理本機資料成長、壓力、蒸餾、保留與可重建清理。",
                {
                    "managed_bytes": resources.get("managed_bytes", 0),
                    "budget_bytes": resources.get("effective_budget_bytes", 0),
                    "pressure": (resources.get("pressure") or {}).get("id", "unknown"),
                },
            ),
            self._module(
                "receipts",
                "Receipts & Monitoring",
                "immune-system",
                "critical"
                if int((seed_health.get("execution") or {}).get("unclosed_required", 0) or 0)
                else seed_behavior,
                "保存命中、未命中、intake 與完成閉環的可查證證據。",
                {
                    "action_receipts": seed_health.get("action_receipts", 0),
                    "intake_receipts": seed_health.get("intake_receipts", 0),
                    "required_failures": (seed_health.get("execution") or {}).get("unclosed_required", 0),
                },
            ),
        ]
        issues: list[dict[str, str]] = []
        for label, error in (
            ("doctor", doctor_error),
            ("resource", resource_error),
            ("roles", role_error),
            ("evolution", evolution_error),
            ("seed", seed_error),
        ):
            if error:
                issues.append({"severity": "attention", "title": f"{label} evidence unavailable", "detail": error[:300]})

        statuses = [str(module["health"]["status"]) for module in modules]
        overall_status = worst_status(statuses)
        return {
            "schema_version": 1,
            "generated_at": now_iso(),
            "canopy": {
                "name": "Canopy",
                "root": str(self.canopy_root),
                "doctor_status": normalized_status(doctor.get("status")),
                "version": evolution.get("contract_version", "unreported"),
            },
            "runtime": self._runtime_identity(),
            "overall": {
                "status": overall_status,
                "scores": {
                    "structural": seed_health.get("structural_score"),
                    "behavioral": seed_health.get("behavioral_score"),
                    "resource_pressure": resources.get("usage_ratio"),
                },
                "summary": self._overall_summary(overall_status),
            },
            "modules": modules,
            "activity": empty_activity(),
            "seed_memory": {
                "cards": cards,
                "active_count": sum(1 for card in cards if card.get("lifecycle") == "active"),
                "candidate_count": sum(1 for card in cards if card.get("lifecycle") == "candidate"),
                "archived_count": sum(1 for card in cards if card.get("lifecycle") == "archived"),
            },
            "roles": roles.get("roles", []),
            "resources": resources,
            "issues": issues,
            "capabilities": {
                "card_proposals": True,
                "direct_card_mutation": False,
                "codex_bridge": "not_connected",
                "core_mutation": False,
            },
        }

    def _seed_health(self) -> tuple[dict[str, Any], str]:
        with tempfile.TemporaryDirectory(prefix="canopy-living-system-") as temp_dir:
            output_path = Path(temp_dir) / "seed-health.json"
            command = [
                sys.executable,
                str(self.canopy_root / "canopy"),
                "seed",
                "health",
                "--memory-dir",
                str(self.canopy_root / "seed" / "state" / "memory"),
                "--json-output",
                str(output_path),
            ]
            result = subprocess.run(
                command,
                cwd=self.canopy_root,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode or not output_path.is_file():
                return {}, (result.stderr or result.stdout).strip()[-500:]
            try:
                payload = json.loads(output_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                return {}, f"invalid Seed health JSON: {exc}"
            return (payload if isinstance(payload, dict) else {}), ""

    def _read_cards(self) -> list[dict[str, Any]]:
        memory_root = self.canopy_root / "seed" / "state" / "memory"
        locations = (
            ("lessons", "active", memory_root / "lessons" / "active.jsonl"),
            ("lessons", "candidate", memory_root / "lessons" / "candidates.jsonl"),
            ("lessons", "archived", memory_root / "lessons" / "archived.jsonl"),
            ("preferences", "active", memory_root / "preferences" / "active.jsonl"),
            ("preferences", "candidate", memory_root / "preferences" / "candidates.jsonl"),
            ("preferences", "archived", memory_root / "preferences" / "archived.jsonl"),
            ("capability_maps", "active", memory_root / "capability_maps" / "tools.jsonl"),
        )
        cards: list[dict[str, Any]] = []
        for category, lifecycle, path in locations:
            if not path.is_file():
                continue
            for line_number, raw_line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), start=1):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    card = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(card, dict):
                    continue
                cards.append(self._public_card(card, category, lifecycle, line_number))
        cards.sort(key=lambda item: (item["lifecycle"] != "active", item["category"], item["id"]))
        return cards

    def _public_card(self, card: dict[str, Any], category: str, lifecycle: str, line_number: int) -> dict[str, Any]:
        card_id = str(card.get("id", f"{category}:{line_number}"))
        summary = str(card.get("lesson") or card.get("preference") or card.get("capability") or "")
        title = card_id.replace("_", " ").replace(".", " · ")
        return {
            "id": card_id,
            "title": title,
            "category": category,
            "lifecycle": lifecycle,
            "status": str(card.get("status", lifecycle)),
            "scope": str(card.get("scope", "")),
            "summary": summary,
            "source_type": str(card.get("source_type", "unknown")),
            "source_summary": str(card.get("source_summary", "")),
            "encouragement": str(card.get("encouragement", "")),
            "reflection_question": str(card.get("reflection_question", "")),
            "triggers": [str(value) for value in card.get("triggers", []) if str(value).strip()][:20],
            "review_after": str(card.get("review_after", "")),
            "created_at": str(card.get("created_at", "")),
            "health": {
                "status": "attention" if lifecycle == "candidate" else "healthy" if lifecycle == "active" else "unknown",
                "reason": "awaiting review" if lifecycle == "candidate" else "available for bounded retrieval",
            },
        }

    def _module(
        self,
        module_id: str,
        name: str,
        zone: str,
        status: str,
        summary: str,
        metrics: dict[str, Any],
        *,
        confidence: str = "medium",
    ) -> dict[str, Any]:
        return {
            "id": module_id,
            "name": name,
            "zone": zone,
            "summary": summary,
            "health": {"status": status, "label": status, "reason": summary},
            "activity": {"status": "observed", "label": "有近期證據"},
            "impact": {"status": "observed", "label": "等待長期比較"},
            "confidence": {"level": confidence, "label": f"{confidence} evidence"},
            "metrics": metrics,
        }

    def _runtime_identity(self) -> dict[str, str]:
        model = os.getenv("CANOPY_MODEL", "").strip() or os.getenv("CODEX_MODEL", "").strip()
        reasoning = os.getenv("CANOPY_REASONING_EFFORT", "").strip() or os.getenv("CODEX_REASONING_EFFORT", "").strip()
        return {
            "engine": "Codex" if os.getenv("CODEX_HOME") else "unreported",
            "model": model or "unreported",
            "reasoning_effort": reasoning or "unreported",
            "identity_source": "runtime_environment" if model or reasoning else "not_reported",
        }

    def _overall_summary(self, status: str) -> str:
        return {
            "healthy": "Canopy 的主要生命單元皆有可用證據，適合繼續觀察長期效益。",
            "attention": "Canopy 正常運作，但有壓力或待複查項目需要留意。",
            "critical": "至少一個閉環或必要契約失敗，應先診斷再宣稱穩定。",
            "unknown": "目前證據不足，不能判斷 Canopy 是否正在發揮作用。",
        }[status]

    def _disconnected_snapshot(self, detail: str) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "generated_at": now_iso(),
            "source_mode": "disconnected",
            "canopy": {"name": "Canopy", "root": str(self.canopy_root), "doctor_status": "critical", "version": "unknown"},
            "runtime": self._runtime_identity(),
            "overall": {"status": "critical", "scores": {}, "summary": detail},
            "modules": [],
            "activity": empty_activity(),
            "seed_memory": {"cards": [], "active_count": 0, "candidate_count": 0, "archived_count": 0},
            "roles": [],
            "resources": {},
            "issues": [{"severity": "critical", "title": "Canopy disconnected", "detail": detail}],
            "capabilities": {"card_proposals": False, "direct_card_mutation": False, "codex_bridge": "not_connected", "core_mutation": False},
        }
