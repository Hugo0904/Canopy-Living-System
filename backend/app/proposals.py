from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


VALID_INTENTS = {"create", "update", "merge", "archive", "diagnose"}


def find_card(snapshot: dict[str, Any], card_id: str) -> dict[str, Any] | None:
    cards = (snapshot.get("seed_memory") or {}).get("cards", [])
    for card in cards if isinstance(cards, list) else []:
        if isinstance(card, dict) and str(card.get("id", "")) == card_id:
            return card
    return None


def build_treatment_proposal(
    *,
    snapshot: dict[str, Any],
    target_type: str,
    target_id: str,
    intent: str,
    operator_prompt: str,
) -> tuple[str, dict[str, Any]]:
    prompt = operator_prompt.strip()
    if intent not in VALID_INTENTS:
        raise ValueError(f"unsupported intent: {intent}")
    if len(prompt) < 4:
        raise ValueError("operator_prompt must contain at least 4 characters")
    if len(prompt) > 2000:
        raise ValueError("operator_prompt exceeds 2000 characters")

    before: dict[str, Any] | None = None
    request_type = "TreatmentRequest"
    owner = "canopy_core"
    if target_type == "seed_card":
        request_type = "SeedChangeProposal"
        owner = "seed_card"
        if intent != "create":
            before = find_card(snapshot, target_id)
            if before is None:
                raise ValueError(f"unknown Seed card: {target_id}")
    elif target_type == "agent":
        owner = "agent_governance"
    elif target_type in {"receipt", "log"}:
        if intent != "diagnose":
            raise ValueError("receipts and logs only support diagnosis")
        owner = "seed_core" if target_type == "receipt" else "canopy_core"

    proposal = {
        "schema_version": 1,
        "artifact_type": request_type,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "awaiting_ai_review",
        "owner_route": owner,
        "target": {"type": target_type, "id": target_id},
        "intent": intent,
        "operator_prompt": prompt,
        "before": before,
        "proposed_after": None,
        "direct_mutation_allowed": False,
        "required_validation": [
            "preserve_source_provenance",
            "validate_schema_and_governance",
            "simulate_before_after_retrieval",
            "show_operator_diff",
            "require_operator_confirmation",
            "apply_through_canopy_owner",
            "write_revision_and_receipt",
            "reobserve_after_apply",
        ],
        "handoff": {
            "bridge_status": "manual_or_mcp_required",
            "instruction": (
                "Ask Codex to inspect this request, produce a structured proposal and tests, "
                "but do not apply it until the operator confirms the diff."
            ),
        },
    }
    return request_type, proposal
