from __future__ import annotations

from typing import Any


MAX_FINDINGS = 5
MAX_CASE_CANDIDATES = 5
MAX_EVIDENCE_ITEMS = 5
MAX_TEXT_CHARS = 400

WORKFLOW_ARTIFACTS = (
    ("case", "EvolutionCase"),
    ("proposal", "EvolutionProposal"),
    ("review", "EngineeringReview"),
    ("experiment", "ExperimentResult"),
    ("adoption", "AdoptionReceipt"),
    ("monitoring", "AdoptionReceipt"),
)

_HEALTH = {"healthy", "attention", "critical", "unknown"}
_LAB_STATUS = {"live", "degraded", "unavailable"}
_EVENTS = {"baseline", "changed", "due", "needs_operator", "new", "regressed", "resolved", "unchanged", "unavailable"}
_FINDING_STATUS = {"needs_operator", "observing", "open", "resolved", "unavailable"}
_PRIORITIES = {"high", "medium", "low", "unavailable"}
_CATEGORIES = {
    "action_mismatch",
    "distillation_pressure",
    "evidence_gap",
    "miss",
    "operator_outcome_evidence",
    "retrieval_observation",
    "review_pressure",
    "runtime_pressure",
    "unavailable",
}
_OWNERS = {
    "agent_governance",
    "canopy_core",
    "extension_adapter",
    "seed_card",
    "seed_core",
    "target_project",
    "unavailable",
}
_DISPOSITIONS = {"evolution_case", "needs_operator", "observe", "unavailable"}
_TRIGGERS = {"manual", "scheduled", "autonomous", "unavailable"}
_METRIC_SPECS_BY_CATEGORY: dict[str, dict[str, str]] = {
    "evidence_gap": {
        "blocked_required": "count",
        "interrupted_required": "count",
        "required_closure_rate": "rate",
        "required_resolution_rate": "rate",
        "required_success_rate": "rate",
        "unclosed_required": "count",
    },
    "operator_outcome_evidence": {
        "claim_level": "claim_level",
        "closed_turns": "count",
        "equivalent_quality_pairs": "count",
        "minimum_complete_pairs": "count",
        "quality_losses": "count",
    },
    "retrieval_observation": {
        "average_seed_bundle_chars": "char_count",
        "hits": "count",
    },
    "runtime_pressure": {
        "overflow_chars": "char_count",
        "resident_chars": "char_count",
        "runtime_target_chars": "char_count",
        "source_chars": "char_count",
    },
}


def _enum(value: Any, allowed: set[str], fallback: str = "unavailable") -> str:
    candidate = str(value or "").strip()
    return candidate if candidate in allowed else fallback


def _public_id(value: Any, prefix: str) -> str:
    text = str(value or "")
    expected_prefix = f"{prefix}:"
    suffix = text.removeprefix(expected_prefix)
    return text if text.startswith(expected_prefix) and len(suffix) == 12 and all(char in "0123456789abcdef" for char in suffix) else "unavailable"


def _public_version(value: Any) -> str:
    parts = str(value or "").split(".")
    return ".".join(parts) if len(parts) == 3 and all(part.isdigit() for part in parts) else "unavailable"


def _valid_metric_value(metric_type: str, value: str) -> bool:
    if metric_type == "rate":
        if value.count(".") > 1 or not value.replace(".", "", 1).isdigit():
            return False
        whole, _, fraction = value.partition(".")
        if "." in value and not fraction:
            return False
        return whole in {"0", "1"} and len(fraction) <= 4 and (
            whole == "0" or not fraction or set(fraction) <= {"0"}
        )
    if metric_type == "count":
        return value == "0" or (
            value.isdigit()
            and not value.startswith("0")
            and len(value) <= 5
        )
    if metric_type == "char_count":
        return (
            value == "0"
            or value.isdigit()
            and not value.startswith("0")
            and len(value) <= 8
            and int(value) <= 50_000_000
        )
    return metric_type == "claim_level" and value in {"none", "bounded", "supported"}


def _bounded_metrics(value: Any, *, category: str) -> tuple[list[str], int]:
    if not isinstance(value, list):
        return [], 0
    metric_specs = _METRIC_SPECS_BY_CATEGORY.get(category, {})
    result: list[str] = []
    omitted = max(0, len(value) - MAX_EVIDENCE_ITEMS)
    for item in value[:MAX_EVIDENCE_ITEMS]:
        text = str(item or "")
        if "=" not in text:
            omitted += 1
            continue
        key, metric_value = text.split("=", 1)
        metric_type = metric_specs.get(key, "")
        if _valid_metric_value(metric_type, metric_value):
            result.append(text)
        else:
            omitted += 1
    return result, omitted


def _nonnegative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _project_finding(item: dict[str, Any]) -> dict[str, Any]:
    evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    category = _enum(item.get("category"), _CATEGORIES)
    public_evidence, locally_omitted = _bounded_metrics(evidence, category=category)
    evidence_omitted = _nonnegative_int(item.get("evidence_omitted")) + locally_omitted
    return {
        "id": _public_id(item.get("id"), "finding"),
        "event": _enum(item.get("event"), _EVENTS),
        "status": _enum(item.get("status"), _FINDING_STATUS),
        "priority": _enum(item.get("priority"), _PRIORITIES),
        "category": category,
        "owner": _enum(item.get("owner"), _OWNERS),
        "summary": "Public Evolution observation; use the category for its localized description.",
        "evidence": public_evidence,
        "evidence_omitted": evidence_omitted,
        "evidence_truncated": item.get("evidence_truncated") is True or evidence_omitted > 0,
        "suggested_improvement": "Use the existing Canopy owner workflow for review.",
        "disposition": _enum(item.get("disposition"), _DISPOSITIONS),
        "case_id": _public_id(item.get("case_id"), "case"),
    }


def _project_case_candidate(item: dict[str, Any]) -> dict[str, Any]:
    evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    constraints = item.get("constraints") if isinstance(item.get("constraints"), list) else []
    evidence_omitted = _nonnegative_int(item.get("evidence_omitted")) + len(evidence)
    return {
        "artifact_type": "EvolutionCase",
        "artifact_status": "candidate_only",
        "artifact_persistence": "unreported",
        "case_id": _public_id(item.get("case_id"), "case"),
        "trigger_source": _enum(item.get("trigger_source"), _TRIGGERS),
        "problem": "Candidate derived from a bounded public Evolution observation.",
        "scope": "unreported",
        "evidence": [],
        "evidence_omitted": evidence_omitted,
        "evidence_truncated": item.get("evidence_truncated") is True or evidence_omitted > 0,
        "constraints": [
            "This candidate is observation evidence, not implementation authority.",
            "Use the canonical Evolution workflow for any proposed change.",
        ] if constraints else [],
        "constraints_truncated": item.get("constraints_truncated") is True,
        "reached_state": "unreported",
        "target_outcome": "Route the finding to its existing owner and collect reviewable evidence.",
    }


def _workflow_stages(case_candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for order, (stage_id, artifact_type) in enumerate(WORKFLOW_ARTIFACTS, start=1):
        is_candidate_stage = stage_id == "case" and bool(case_candidates)
        result.append(
            {
                "id": stage_id,
                "order": order,
                "artifact_type": artifact_type,
                "status": "candidate_only" if is_candidate_stage else "unreported",
                "reached_state": "unreported",
                "artifact_count": len(case_candidates) if is_candidate_stage else 0,
                "basis": (
                    "public_observation_case_candidates"
                    if is_candidate_stage
                    else "public_contract_does_not_report_artifact"
                ),
            }
        )
    return result


def build_evolution_lab_projection(
    *,
    observation: dict[str, Any],
    observation_error: str,
    generated_at: str,
) -> dict[str, Any]:
    contract_valid = (
        observation.get("contract_id") == "canopy.observation.evolution"
        and observation.get("schema_version") == 1
    )
    contract_source = (
        observation.get("contract")
        if contract_valid and isinstance(observation.get("contract"), dict)
        else {}
    )
    monitor_source = (
        observation.get("monitor")
        if contract_valid and isinstance(observation.get("monitor"), dict)
        else {}
    )
    read_only_source = (
        observation.get("read_only")
        if contract_valid and isinstance(observation.get("read_only"), dict)
        else {}
    )
    raw_findings = (
        observation.get("findings")
        if contract_valid and isinstance(observation.get("findings"), list)
        else []
    )
    raw_candidates = (
        observation.get("case_candidates")
        if contract_valid and isinstance(observation.get("case_candidates"), list)
        else []
    )
    findings = [
        _project_finding(item)
        for item in raw_findings[:MAX_FINDINGS]
        if isinstance(item, dict)
    ]
    candidates = [
        _project_case_candidate(item)
        for item in raw_candidates[:MAX_CASE_CANDIDATES]
        if isinstance(item, dict) and item.get("artifact_type") == "EvolutionCase"
    ]

    state_updated = read_only_source.get("state_updated") is True
    read_only_confirmed = (
        contract_valid
        and read_only_source.get("confirmed") is True
        and read_only_source.get("state_updated") is False
    )
    source_status = _enum(observation.get("status"), _LAB_STATUS, "unavailable")
    status = (
        source_status
        if contract_valid and not observation_error and read_only_confirmed
        else "unavailable"
        if not contract_valid and not observation
        else "degraded"
    )
    issues: list[dict[str, str]] = []
    if observation_error:
        issues.append(
            {"source": "observation", "detail": "Evolution observation is unavailable."}
        )
    if observation and not contract_valid:
        issues.append(
            {
                "source": "observation",
                "detail": "Unsupported Canopy Evolution observation contract.",
            }
        )
    if contract_valid and not read_only_confirmed:
        issues.append(
            {
                "source": "observation",
                "detail": "The public contract did not confirm read-only monitoring.",
            }
        )

    raw_summary = (
        monitor_source.get("summary")
        if isinstance(monitor_source.get("summary"), dict)
        else {}
    )
    summary = {
        key: _nonnegative_int(raw_summary.get(key))
        for key in (
            "unchanged",
            "regressed",
            "new",
            "changed",
            "resolved",
            "due",
            "active",
            "stored",
            "reportable",
        )
    }
    summary["report_truncated"] = raw_summary.get("report_truncated") is True

    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.evolution-lab",
        "generated_at": generated_at,
        "status": status,
        "source_mode": "canopy_public_contract" if contract_valid else "unavailable",
        "read_only": {
            "on_demand": True,
            "monitor_no_write_requested": True,
            "monitor_state_updated": state_updated,
            "confirmed": read_only_confirmed,
        },
        "contract": {
            "health": _enum(contract_source.get("health"), _HEALTH),
            "id": (
                "canopy.directed_evolution"
                if contract_source.get("id") == "canopy.directed_evolution"
                else "unavailable"
            ),
            "version": _public_version(contract_source.get("version")),
            "routing_cases": _nonnegative_int(contract_source.get("routing_cases")),
            "runtime_chars": _nonnegative_int(contract_source.get("runtime_chars")),
            "runtime_target_chars": _nonnegative_int(contract_source.get("runtime_target_chars")),
            "warnings": [],
            "errors": [],
        },
        "monitor": {
            "health": _enum(monitor_source.get("health"), _HEALTH),
            "trigger_source": _enum(monitor_source.get("trigger_source"), _TRIGGERS),
            "all_findings_requested": False,
            "summary": summary,
        },
        "findings": findings,
        "findings_total": _nonnegative_int(observation.get("findings_total")),
        "findings_omitted": _nonnegative_int(observation.get("findings_omitted")),
        "findings_truncated": observation.get("findings_truncated") is True,
        "case_candidates": candidates,
        "case_candidates_truncated": observation.get("case_candidates_truncated") is True,
        "workflow_stages": _workflow_stages(candidates),
        "limits": {
            "findings": MAX_FINDINGS,
            "case_candidates": MAX_CASE_CANDIDATES,
            "evidence_per_item": MAX_EVIDENCE_ITEMS,
            "text_chars": MAX_TEXT_CHARS,
        },
        "privacy": {
            "allowlist_only": True,
            "source_references": False,
            "absolute_paths": False,
            "uris": False,
            "operator_prompt_content": False,
            "model_private_reasoning": False,
            "secrets": False,
        },
        "issues": issues[:5],
    }
