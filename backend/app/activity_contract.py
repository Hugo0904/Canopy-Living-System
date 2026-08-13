from __future__ import annotations

from datetime import datetime
from typing import Any


ACTIVITY_CONTRACT_ID = "canopy.observation.activity"
MIN_ACTIVITY_SCHEMA_VERSION = 3
MAX_ACTIVITY_EVENTS = 600

PRIVACY_FLAGS = (
    "raw_prompts_included",
    "source_excerpts_included",
    "absolute_paths_included",
    "sensitive_records_included",
    "raw_tool_inputs_included",
    "raw_tool_outputs_included",
    "hidden_reasoning_included",
)

EVENT_TEXT_FIELDS = (
    "local_date",
    "correlation_id",
    "module_id",
    "kind",
    "phase",
    "status",
    "actor",
    "action",
    "summary",
    "assistance",
    "request_effect",
    "verification",
    "learning",
    "growth_stage",
    "next_benefit",
    "source",
)

# Facts are a deliberately small public vocabulary. New Core facts stay hidden
# until this consumer explicitly reviews them instead of being persisted by
# accident together with a future private/internal field.
PUBLIC_FACT_FIELDS = frozenset(
    {
        "action",
        "classification",
        "context_chars",
        "coverage",
        "evolution",
        "intent_status",
        "matched_cards",
        "missing_obligations",
        "model",
        "outcome",
        "permission_mode",
        "prior_context_used",
        "required_obligations",
        "resolver_status",
        "role",
        "role_status",
        "root_cause",
        "task_id",
        "task_mode",
        "task_status",
    }
)


class ActivityContractError(ValueError):
    """Raised when Canopy's public activity projection is unsafe or malformed."""


def _bounded_text(value: Any, field: str, *, limit: int, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ActivityContractError(f"{field} must be a string")
    normalized = " ".join(value.split())
    if not allow_empty and not normalized:
        raise ActivityContractError(f"{field} is required")
    if len(normalized) > limit:
        raise ActivityContractError(f"{field} exceeds the public contract limit")
    return normalized


def _timestamp(value: Any, field: str) -> str:
    normalized = _bounded_text(value, field, limit=64, allow_empty=False)
    try:
        datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ActivityContractError(f"{field} must be an ISO-8601 timestamp") from exc
    return normalized


def _safe_scalar(value: Any, field: str) -> str | int | float | bool:
    if isinstance(value, str):
        return _bounded_text(value, field, limit=300)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    raise ActivityContractError(f"{field} must be a public scalar")


def _sanitize_event(event: Any, index: int) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise ActivityContractError(f"events[{index}] must be an object")

    event_id = _bounded_text(
        event.get("id"), f"events[{index}].id", limit=240, allow_empty=False
    )
    if not event_id.startswith("activity:"):
        raise ActivityContractError(f"events[{index}].id must use the activity namespace")

    sanitized: dict[str, Any] = {
        "id": event_id,
        "occurred_at": _timestamp(
            event.get("occurred_at"), f"events[{index}].occurred_at"
        ),
        "importance": _safe_scalar(
            event.get("importance"), f"events[{index}].importance"
        ),
    }
    required_nonempty = {"correlation_id", "module_id", "kind", "phase", "status", "summary"}
    for field in EVENT_TEXT_FIELDS:
        if field not in event:
            raise ActivityContractError(f"events[{index}].{field} is required")
        limit = 600 if field in {
            "summary",
            "assistance",
            "request_effect",
            "verification",
            "learning",
            "next_benefit",
        } else 240
        sanitized[field] = _bounded_text(
            event[field],
            f"events[{index}].{field}",
            limit=limit,
            allow_empty=field not in required_nonempty,
        )

    facts = event.get("facts")
    if not isinstance(facts, dict):
        raise ActivityContractError(f"events[{index}].facts must be an object")
    sanitized["facts"] = {
        key: _safe_scalar(value, f"events[{index}].facts.{key}")
        for key, value in facts.items()
        if key in PUBLIC_FACT_FIELDS
    }
    return sanitized


def _sanitize_window(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityContractError("window must be an object")
    days = value.get("days")
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 60:
        raise ActivityContractError("window.days must be between 1 and 60")
    result: dict[str, Any] = {
        "days": days,
        "from": _timestamp(value.get("from"), "window.from"),
        "to": _timestamp(value.get("to"), "window.to"),
    }
    if "timezone" in value:
        result["timezone"] = _bounded_text(value["timezone"], "window.timezone", limit=48)
    return result


def _sanitize_named_scalars(value: Any, field: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityContractError(f"{field} must be an object")
    return {
        key: _safe_scalar(item, f"{field}.{key}")
        for key, item in value.items()
        if key in allowed
    }


def _sanitize_limits(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityContractError("limits must be an object")
    allowed = {
        "max_events",
        "default_events",
        "max_window_days",
        "max_events_per_module",
        "max_milestones",
        "max_task_files",
        "max_receipt_lines_per_source",
        "max_summary_chars",
    }
    sanitized = {
        key: _safe_scalar(item, f"limits.{key}")
        for key, item in value.items()
        if key in allowed
    }
    source_limits = value.get("source_event_limits")
    if source_limits is not None:
        if not isinstance(source_limits, dict):
            raise ActivityContractError("limits.source_event_limits must be an object")
        sanitized["source_event_limits"] = {
            _bounded_text(key, "limits.source_event_limits key", limit=80, allow_empty=False):
            _safe_scalar(item, f"limits.source_event_limits.{key}")
            for key, item in source_limits.items()
            if isinstance(key, str)
        }
    return sanitized


def _sanitize_omitted(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityContractError("omitted must be an object")
    sanitized = {
        key: _safe_scalar(value[key], f"omitted.{key}")
        for key in ("malformed", "over_limit", "sensitive")
        if key in value
    }
    source_quota = value.get("source_quota")
    if source_quota is not None:
        sanitized["source_quota"] = _sanitize_named_scalars(
            source_quota,
            "omitted.source_quota",
            {
                "execution_receipt",
                "hook_activity",
                "seed_action",
                "seed_intake",
                "miss_analysis",
                "task_log",
            },
        )
    return sanitized


def _sanitize_daily(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ActivityContractError("daily must be an array")
    sanitized: list[dict[str, Any]] = []
    for index, item in enumerate(value[:60]):
        if not isinstance(item, dict):
            raise ActivityContractError(f"daily[{index}] must be an object")
        module_counts = item.get("module_counts", {})
        if not isinstance(module_counts, dict):
            raise ActivityContractError(f"daily[{index}].module_counts must be an object")
        active_modules = item.get("active_modules", [])
        if not isinstance(active_modules, list):
            raise ActivityContractError(f"daily[{index}].active_modules must be an array")
        sanitized.append(
            {
                "date": _bounded_text(item.get("date", ""), f"daily[{index}].date", limit=32),
                "total": _safe_scalar(item.get("total", 0), f"daily[{index}].total"),
                "importance": _safe_scalar(
                    item.get("importance", ""), f"daily[{index}].importance"
                ),
                "module_counts": {
                    _bounded_text(key, f"daily[{index}].module_counts key", limit=120, allow_empty=False):
                    _safe_scalar(count, f"daily[{index}].module_counts.{key}")
                    for key, count in module_counts.items()
                    if isinstance(key, str)
                },
                "active_modules": [
                    _bounded_text(module, f"daily[{index}].active_modules", limit=120, allow_empty=False)
                    for module in active_modules[:40]
                    if isinstance(module, str)
                ],
            }
        )
    return sanitized


def _sanitize_milestones(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ActivityContractError("milestones must be an array")
    allowed = {
        "event_id",
        "id",
        "importance",
        "kind",
        "local_date",
        "module_id",
        "occurred_at",
        "summary",
    }
    sanitized: list[dict[str, Any]] = []
    for index, item in enumerate(value[:24]):
        if not isinstance(item, dict):
            raise ActivityContractError(f"milestones[{index}] must be an object")
        milestone: dict[str, Any] = {}
        for key in allowed:
            if key in item:
                milestone[key] = (
                    _timestamp(item[key], f"milestones[{index}].occurred_at")
                    if key == "occurred_at"
                    else _safe_scalar(item[key], f"milestones[{index}].importance")
                    if key == "importance"
                    else _bounded_text(item[key], f"milestones[{index}].{key}", limit=600)
                )
        sanitized.append(milestone)
    return sanitized


def _sanitize_modules(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ActivityContractError("modules must be an object")
    sanitized: dict[str, Any] = {}
    for raw_module_id, raw_module in list(value.items())[:80]:
        if not isinstance(raw_module_id, str) or not isinstance(raw_module, dict):
            continue
        module_id = _bounded_text(raw_module_id, "modules key", limit=120, allow_empty=False)
        event_ids = raw_module.get("event_ids", [])
        if not isinstance(event_ids, list):
            raise ActivityContractError(f"modules.{module_id}.event_ids must be an array")
        sanitized[module_id] = {
            "event_ids": [
                _bounded_text(event_id, f"modules.{module_id}.event_ids", limit=240, allow_empty=False)
                for event_id in event_ids[:24]
                if isinstance(event_id, str)
            ],
            "last_activity_at": _bounded_text(
                raw_module.get("last_activity_at", ""),
                f"modules.{module_id}.last_activity_at",
                limit=64,
            ),
            "total_in_window": _safe_scalar(
                raw_module.get("total_in_window", 0),
                f"modules.{module_id}.total_in_window",
            ),
        }
    return sanitized


def validate_activity_projection(payload: Any) -> dict[str, Any]:
    """Validate and reduce a Core projection to Living System public fields."""
    if not isinstance(payload, dict):
        raise ActivityContractError("activity projection must be an object")
    schema_version = payload.get("schema_version")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version < MIN_ACTIVITY_SCHEMA_VERSION
    ):
        raise ActivityContractError("activity schema_version must be 3 or newer")
    if payload.get("contract_id") != ACTIVITY_CONTRACT_ID:
        raise ActivityContractError("activity contract_id is not supported")

    privacy = payload.get("privacy")
    if not isinstance(privacy, dict):
        raise ActivityContractError("privacy must be an object")
    for flag in PRIVACY_FLAGS:
        if privacy.get(flag) is not False:
            raise ActivityContractError(f"privacy.{flag} must be false")
    for flag, value in privacy.items():
        if flag not in PRIVACY_FLAGS and isinstance(value, bool) and value:
            raise ActivityContractError(f"privacy.{flag} must not enable private data")

    raw_events = payload.get("events")
    if not isinstance(raw_events, list):
        raise ActivityContractError("events must be an array")
    if len(raw_events) > MAX_ACTIVITY_EVENTS:
        raise ActivityContractError("events exceeds the public contract limit")

    for field in (
        "window",
        "limits",
        "coverage",
        "daily",
        "milestones",
        "modules",
        "source_counts",
        "omitted",
        "truncated",
        "sync_cursor",
    ):
        if field not in payload:
            raise ActivityContractError(f"{field} is required")

    if not isinstance(payload["truncated"], bool):
        raise ActivityContractError("truncated must be a boolean")

    return {
        "schema_version": schema_version,
        "contract_id": ACTIVITY_CONTRACT_ID,
        "window": _sanitize_window(payload["window"]),
        "limits": _sanitize_limits(payload["limits"]),
        "privacy": {flag: False for flag in PRIVACY_FLAGS},
        "coverage": _sanitize_named_scalars(
            payload["coverage"],
            "coverage",
            {
                "local_tool_hooks",
                "hosted_tools",
                "stop_result_summary",
                "transcript_is_primary_source",
            },
        ),
        "events": [_sanitize_event(event, index) for index, event in enumerate(raw_events)],
        "daily": _sanitize_daily(payload["daily"]),
        "milestones": _sanitize_milestones(payload["milestones"]),
        "modules": _sanitize_modules(payload["modules"]),
        "source_counts": _sanitize_named_scalars(
            payload["source_counts"],
            "source_counts",
            {
                "execution_receipt",
                "hook_activity",
                "seed_action",
                "seed_intake",
                "miss_analysis",
                "task_log",
            },
        ),
        "omitted": _sanitize_omitted(payload["omitted"]),
        "truncated": payload["truncated"],
        "sync_cursor": _bounded_text(
            payload["sync_cursor"], "sync_cursor", limit=240
        ),
    }
