from __future__ import annotations

from datetime import datetime
from typing import Any


MIN_SCHEMA_VERSION = 4
HEALTH_STATUSES = {"healthy", "attention", "critical", "unknown"}
REQUIRED_OBSERVATION_METRICS = {
    "hooks": ("observed_preflights", "average_context_chars"),
    "roles": ("recent_selections",),
}


class SnapshotContractError(ValueError):
    """Raised when a Canopy public snapshot cannot be projected safely."""


def _object(value: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SnapshotContractError(f"{label} must be an object")
    return value


def _list(value: Any, *, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise SnapshotContractError(f"{label} must be a list")
    return value


def _health_status(value: Any, *, label: str) -> str:
    status = str(value or "").strip()
    if status not in HEALTH_STATUSES:
        raise SnapshotContractError(f"{label} has an invalid health status")
    return status


def validate_normalized_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Validate the normalized public contract without deriving replacement data.

    Individual metrics remain optional because absence is meaningful to the UI.
    In particular, this validator never turns a missing value into numeric zero.
    """

    if not isinstance(snapshot, dict):
        raise SnapshotContractError("snapshot must be an object")

    try:
        schema_version = int(snapshot.get("schema_version", 0))
    except (TypeError, ValueError) as exc:
        raise SnapshotContractError("snapshot schema_version must be an integer") from exc
    if schema_version < MIN_SCHEMA_VERSION:
        raise SnapshotContractError(
            f"snapshot schema_version {schema_version} is older than required version {MIN_SCHEMA_VERSION}"
        )

    if snapshot.get("source_mode") != "canopy_public_contract":
        raise SnapshotContractError("snapshot did not come from the Canopy public contract")

    generated_at = str(snapshot.get("generated_at") or "").strip()
    if not generated_at:
        raise SnapshotContractError("snapshot generated_at is missing")
    try:
        datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SnapshotContractError("snapshot generated_at is invalid") from exc

    overall = _object(snapshot.get("overall"), label="snapshot overall")
    _health_status(overall.get("status"), label="snapshot overall")
    _object(overall.get("scores"), label="snapshot overall scores")

    modules = _list(snapshot.get("modules"), label="snapshot modules")
    if not modules:
        raise SnapshotContractError("snapshot modules must not be empty")
    module_ids: set[str] = set()
    module_issue_ids: dict[str, set[str]] = {}
    for position, item in enumerate(modules):
        module = _object(item, label=f"snapshot modules[{position}]")
        module_id = str(module.get("id") or "").strip()
        if not module_id:
            raise SnapshotContractError(f"snapshot modules[{position}] is missing an id")
        if module_id in module_ids:
            raise SnapshotContractError(f"snapshot contains duplicate module id: {module_id}")
        module_ids.add(module_id)
        health = _object(module.get("health"), label=f"module {module_id} health")
        _health_status(health.get("status"), label=f"module {module_id}")
        _object(module.get("activity"), label=f"module {module_id} activity")
        _object(module.get("impact"), label=f"module {module_id} impact")
        _object(module.get("confidence"), label=f"module {module_id} confidence")
        metrics = _object(module.get("metrics"), label=f"module {module_id} metrics")
        raw_issue_ids = _list(
            module.get("issue_ids"), label=f"module {module_id} issue_ids"
        )
        issue_ids = {
            str(issue_id).strip()
            for issue_id in raw_issue_ids
            if isinstance(issue_id, str) and issue_id.strip()
        }
        if len(issue_ids) != len(raw_issue_ids):
            raise SnapshotContractError(
                f"module {module_id} issue_ids must contain unique non-empty strings"
            )
        module_issue_ids[module_id] = issue_ids
        for metric_id in REQUIRED_OBSERVATION_METRICS.get(module_id, ()):
            if metric_id not in metrics:
                raise SnapshotContractError(
                    f"module {module_id} is missing required metric: {metric_id}"
                )
            value = metrics[metric_id]
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, (int, float))
            ):
                raise SnapshotContractError(
                    f"module {module_id} metric {metric_id} must be numeric or null"
                )

    issues = _list(snapshot.get("issues"), label="snapshot issues")
    public_issue_ids: set[str] = set()
    issue_module_ids: dict[str, set[str]] = {}
    for position, item in enumerate(issues):
        issue = _object(item, label=f"snapshot issues[{position}]")
        label = f"snapshot issues[{position}]"
        _health_status(issue.get("severity"), label=label)
        issue_id = str(issue.get("id") or "").strip()
        if not issue_id:
            raise SnapshotContractError(f"{label} is missing an id")
        if issue_id in public_issue_ids:
            raise SnapshotContractError(f"snapshot contains duplicate issue id: {issue_id}")
        public_issue_ids.add(issue_id)
        raw_module_ids = _list(issue.get("module_ids"), label=f"{label} module_ids")
        linked_module_ids = {
            str(module_id).strip()
            for module_id in raw_module_ids
            if isinstance(module_id, str) and module_id.strip()
        }
        if len(linked_module_ids) != len(raw_module_ids):
            raise SnapshotContractError(
                f"{label} module_ids must contain unique non-empty strings"
            )
        unknown_modules = linked_module_ids - module_ids
        if unknown_modules:
            raise SnapshotContractError(
                f"{label} references unknown module: {sorted(unknown_modules)[0]}"
            )
        issue_module_ids[issue_id] = linked_module_ids
        for field in (
            "id",
            "source",
            "state",
            "owner",
            "impact",
            "evidence_state",
            "case_id",
            "last_seen_at",
            "next_review_at",
            "code",
            "title",
            "detail",
        ):
            if field in issue and not isinstance(issue[field], str):
                raise SnapshotContractError(f"{label} {field} must be a string")
        if "requires_operator" in issue and not isinstance(issue["requires_operator"], bool):
            raise SnapshotContractError(f"{label} requires_operator must be boolean")
        if "params" in issue:
            _object(issue["params"], label=f"{label} params")
        remediation = _object(issue.get("remediation"), label=f"{label} remediation")
        if "automatic" in remediation and not isinstance(remediation["automatic"], bool):
            raise SnapshotContractError(f"{label} remediation automatic must be boolean")
        if not isinstance(remediation.get("requestable"), bool):
            raise SnapshotContractError(
                f"{label} remediation requestable must be boolean"
            )
        for field in (
            "mode",
            "state",
            "action_id",
            "authority",
            "summary",
            "next_action",
            "command",
            "verification",
            "rollback",
        ):
            if field in remediation and not isinstance(remediation[field], str):
                raise SnapshotContractError(
                    f"{label} remediation {field} must be a string"
                )
        if "verification" in issue and not isinstance(issue["verification"], (str, dict)):
            raise SnapshotContractError(f"{label} verification must be a string or object")

    for module_id, linked_issue_ids in module_issue_ids.items():
        unknown_issues = linked_issue_ids - public_issue_ids
        if unknown_issues:
            raise SnapshotContractError(
                f"module {module_id} references unknown issue: {sorted(unknown_issues)[0]}"
            )
        inverse = {
            issue_id
            for issue_id, linked_module_ids in issue_module_ids.items()
            if module_id in linked_module_ids
        }
        if linked_issue_ids != inverse:
            raise SnapshotContractError(
                f"module {module_id} issue_ids do not match issues module_ids"
            )

    seed_memory = _object(snapshot.get("seed_memory"), label="snapshot seed_memory")
    _list(seed_memory.get("cards"), label="snapshot seed_memory cards")
    _list(snapshot.get("roles"), label="snapshot roles")
    _object(snapshot.get("resources"), label="snapshot resources")
    _object(snapshot.get("capabilities"), label="snapshot capabilities")

    return {
        "status": "valid",
        "schema_version": schema_version,
        "source_mode": "canopy_public_contract",
        "module_count": len(modules),
    }
