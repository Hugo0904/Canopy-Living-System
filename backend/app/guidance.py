from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Mapping


GUIDANCE_SCHEMA_VERSION = 1
GUIDANCE_CONTRACT_ID = "canopy.living-system.guidance"

PresentationKey = tuple[str, str, str]
PresentationStates = Mapping[PresentationKey, Mapping[str, Any]]


def _text(value: Any, *, limit: int = 600) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _string_list(value: Any, *, limit: int = 5) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = _text(item, limit=240)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _fingerprint(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _message_id(kind: str, source_id: str) -> str:
    digest = hashlib.sha256(f"{kind}:{source_id}".encode("utf-8")).hexdigest()[:20]
    return f"fura:{kind}:{digest}"


def _issue_message(snapshot: dict[str, Any], issue: dict[str, Any]) -> dict[str, Any] | None:
    issue_id = _text(issue.get("id"), limit=200)
    title = _text(issue.get("title"), limit=240)
    body = _text(issue.get("detail"), limit=800)
    severity = _text(issue.get("severity"), limit=40)
    if not issue_id or not title or not body or severity == "healthy":
        return None

    remediation = issue.get("remediation")
    remediation = remediation if isinstance(remediation, dict) else {}
    requestable = remediation.get("requestable") is True
    module_ids = _string_list(issue.get("module_ids"), limit=20)
    evidence = _string_list(issue.get("evidence"), limit=5)
    fingerprint = _fingerprint(
        {
            "id": issue_id,
            "owner": _text(issue.get("owner"), limit=80),
            "state": _text(issue.get("state"), limit=80),
            "severity": severity,
            "impact": _text(issue.get("impact"), limit=120),
            "evidence_state": _text(issue.get("evidence_state"), limit=80),
            "requires_operator": issue.get("requires_operator") is True,
            "title": title,
            "detail": body,
            "module_ids": module_ids,
            "evidence": evidence,
            "remediation": {
                "state": _text(remediation.get("state"), limit=80),
                "action_id": _text(remediation.get("action_id"), limit=160),
                "requestable": requestable,
                "next_action": _text(remediation.get("next_action"), limit=400),
                "verification": _text(remediation.get("verification"), limit=400),
            },
        }
    )
    actions = ["inspect"]
    if requestable:
        actions.append("diagnose")
    actions.extend(["snooze", "dismiss", "open_notebook"])
    return {
        "id": _message_id("issue", issue_id),
        "fingerprint": fingerprint,
        "kind": "issue",
        "title": title,
        "body": body,
        "source_owner": _text(issue.get("owner"), limit=80) or "canopy_core",
        "observed_at": _text(issue.get("last_seen_at"), limit=80)
        or _text(snapshot.get("generated_at"), limit=80),
        "claim_status": "core_evidence",
        "target": {"type": "issue", "id": issue_id, "module_ids": module_ids},
        "requestable": requestable,
        "evidence": evidence,
        "actions": actions,
        "_priority": (
            {
                "critical": 0,
                "attention": 1,
                "unknown": 2,
            }.get(severity, 3)
            if requestable
            else 30
        ),
    }


def _question_message(snapshot: dict[str, Any], card: dict[str, Any]) -> dict[str, Any] | None:
    card_id = _text(card.get("id"), limit=240)
    question = _text(card.get("reflection_question"), limit=800)
    if not card_id or not question or _text(card.get("lifecycle"), limit=40) != "active":
        return None

    title = (
        _text(card.get("title"), limit=240)
        or _text(card.get("summary"), limit=240)
        or card_id
    )
    source_summary = _text(card.get("source_summary"), limit=240)
    fingerprint = _fingerprint(
        {
            "id": card_id,
            "lifecycle": "active",
            "reflection_question": question,
            "review_after": _text(card.get("review_after"), limit=80),
            "source_type": _text(card.get("source_type"), limit=80),
            "source_summary": source_summary,
        }
    )
    return {
        "id": _message_id("question", card_id),
        "fingerprint": fingerprint,
        "kind": "question",
        "title": title,
        "body": question,
        "source_owner": "seed_card",
        "observed_at": _text(snapshot.get("generated_at"), limit=80),
        "claim_status": "operator_question",
        "target": {"type": "seed_card", "id": card_id},
        "requestable": True,
        "evidence": [source_summary] if source_summary else [],
        "actions": ["answer", "snooze", "dismiss", "open_notebook"],
        "_priority": 10,
    }


def _daily_message(value: dict[str, Any]) -> dict[str, Any] | None:
    source_id = _text(value.get("id"), limit=240)
    category = _text(value.get("category"), limit=80)
    title = _text(value.get("title"), limit=240)
    body = _text(value.get("body"), limit=800)
    source_url = _text(value.get("source_url"), limit=600)
    claim_status = _text(value.get("claim_status"), limit=80)
    if (
        not source_id
        or not category
        or not title
        or not body
        or not source_url.startswith("https://")
        or claim_status != "external_verified"
    ):
        return None
    facts = value.get("facts") if isinstance(value.get("facts"), dict) else {}
    source_name = _text(value.get("source_name"), limit=120)
    fingerprint = _fingerprint(
        {
            "id": source_id,
            "category": category,
            "title": title,
            "body": body,
            "source_owner": _text(value.get("source_owner"), limit=80),
            "source_name": source_name,
            "source_url": source_url,
            "facts": facts,
        }
    )
    return {
        "id": _message_id("daily", source_id),
        "fingerprint": fingerprint,
        "kind": "daily",
        "title": title,
        "body": body,
        "source_owner": _text(value.get("source_owner"), limit=80) or "living_system",
        "observed_at": _text(value.get("observed_at"), limit=80),
        "claim_status": "external_verified",
        "target": {
            "type": "daily",
            "id": source_id,
            "category": category,
            "source_name": source_name,
            "source_url": source_url,
        },
        "requestable": False,
        "evidence": [source_name] if source_name else [],
        "actions": ["source", "snooze", "dismiss", "open_notebook"],
        "_priority": max(4, min(20, int(value.get("priority", 15) or 15))),
    }


def build_guidance_messages(
    snapshot: dict[str, Any],
    *,
    companion_messages: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build bounded candidates without mutating Core-owned evidence.

    Core issues and Seed questions come only from the normalized public
    snapshot. Optional daily companion items are already source-labelled,
    bounded Living System projections supplied by the caller.
    """

    messages: list[dict[str, Any]] = []
    issues = snapshot.get("issues")
    for issue in issues if isinstance(issues, list) else []:
        if isinstance(issue, dict):
            message = _issue_message(snapshot, issue)
            if message is not None:
                messages.append(message)

    seed_memory = snapshot.get("seed_memory")
    seed_memory = seed_memory if isinstance(seed_memory, dict) else {}
    cards = seed_memory.get("cards")
    for card in cards if isinstance(cards, list) else []:
        if isinstance(card, dict):
            message = _question_message(snapshot, card)
            if message is not None:
                messages.append(message)

    for item in (companion_messages or [])[:6]:
        if isinstance(item, dict):
            message = _daily_message(item)
            if message is not None:
                messages.append(message)

    messages.sort(
        key=lambda item: (
            int(item.get("_priority", 99)),
            0 if item.get("requestable") is True else 1,
            str(item.get("target", {}).get("id", "")),
        )
    )
    for message in messages:
        message.pop("_priority", None)
    return messages


def find_guidance_message(
    snapshot: dict[str, Any],
    *,
    message_id: str,
    expected_fingerprint: str,
    companion_messages: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    for message in build_guidance_messages(
        snapshot,
        companion_messages=companion_messages,
    ):
        if (
            message["id"] == message_id
            and message["fingerprint"] == expected_fingerprint
        ):
            return message
    return None


def _parse_time(value: Any) -> datetime | None:
    text = _text(value, limit=80)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_hidden(
    message: dict[str, Any],
    presentations: PresentationStates,
    *,
    now: datetime,
) -> bool:
    target = message.get("target") if isinstance(message.get("target"), dict) else {}
    key = (
        str(message.get("kind", "")),
        str(target.get("id", "")),
        str(message.get("fingerprint", "")),
    )
    state = presentations.get(key, {})
    decision = _text(state.get("decision"), limit=40)
    if decision in {"dismiss", "answered"}:
        return True
    if decision == "snooze":
        snoozed_until = _parse_time(state.get("snoozed_until"))
        return snoozed_until is not None and snoozed_until > now
    return False


def observation_unavailable_reason(sync: dict[str, Any]) -> str:
    observation_state = _text(sync.get("observation_state"), limit=80)
    if observation_state == "contract_invalid":
        return "observation_contract_invalid"
    if observation_state == "no_data":
        return "observation_not_yet_available"
    return "observation_not_current"


def select_guidance(
    *,
    snapshot: dict[str, Any],
    sync: dict[str, Any],
    presentations: PresentationStates | None = None,
    companion_messages: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Return at most one truthful message from Core or verified UI sources."""

    if not (
        sync.get("status") == "live"
        and sync.get("observation_state") == "observed"
        and sync.get("projection_state") == "current"
    ):
        return {
            "schema_version": GUIDANCE_SCHEMA_VERSION,
            "contract_id": GUIDANCE_CONTRACT_ID,
            "status": "unavailable",
            "reason": observation_unavailable_reason(sync),
            "message": None,
        }

    states = presentations or {}
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    candidates = [
        candidate
        for candidate in build_guidance_messages(
            snapshot,
            companion_messages=companion_messages,
        )
        if not _is_hidden(candidate, states, now=current_time)
    ]
    actionable = [
        candidate
        for candidate in candidates
        if candidate.get("kind") == "issue" and candidate.get("requestable") is True
    ]
    if actionable:
        message = actionable[0]
    else:
        conversational = [
            candidate
            for candidate in candidates
            if candidate.get("kind") in {"question", "daily"}
        ]
        pool = conversational or candidates
        # The optional conversation changes at most every three hours. It
        # remains deterministic within a slot so an action always resolves
        # against the item the operator actually saw.
        rotation_slot = int(current_time.timestamp() // (3 * 60 * 60))
        message = pool[rotation_slot % len(pool)] if pool else None
    return {
        "schema_version": GUIDANCE_SCHEMA_VERSION,
        "contract_id": GUIDANCE_CONTRACT_ID,
        "status": "available" if message is not None else "quiet",
        "reason": "" if message is not None else "no_guidance",
        "message": message,
    }
