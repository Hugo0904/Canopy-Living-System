from __future__ import annotations

import asyncio
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .canopy_adapter import CanopyAdapter
from .companionship import CompanionBriefingCache
from .database import ObservatoryDatabase
from .guidance import (
    find_guidance_message,
    observation_unavailable_reason,
    select_guidance,
)
from .proposals import build_treatment_proposal
from .remediation_adapter import (
    RemediationAdapter,
    RemediationAdapterError,
    RemediationContractError,
    RemediationUnavailable,
)
from .settings import Settings
from .snapshot_contract import SnapshotContractError, validate_normalized_snapshot
from .topology import TopologyContractError, validate_snapshot_topology


settings = Settings.from_env()
database = ObservatoryDatabase(
    settings.database_path,
    snapshot_retention_days=settings.snapshot_retention_days,
    snapshot_max_records=settings.snapshot_max_records,
    treatment_retention_days=settings.treatment_retention_days,
    treatment_max_records=settings.treatment_max_records,
    life_event_retention_days=settings.life_event_retention_days,
    life_event_max_records=settings.life_event_max_records,
)
adapter = CanopyAdapter(settings.canopy_root, cache_seconds=settings.snapshot_cache_seconds)
remediation_adapter = RemediationAdapter(settings)
companion_cache = CompanionBriefingCache(
    latitude=settings.weather_latitude,
    longitude=settings.weather_longitude,
    location=settings.weather_location,
)
life_sync_state: dict[str, Any] = {
    "status": "starting",
    "last_synced_at": "",
    "last_error": "",
    "accepted": 0,
    "persisted": 0,
    "truncated": False,
    "omitted": {},
}
life_sync_lock = asyncio.Lock()
snapshot_sync_lock = asyncio.Lock()
snapshot_sync_state: dict[str, Any] = {
    "status": "starting",
    "last_synced_at": "",
    "last_error": "",
    "changed": False,
    "observation_state": "no_data",
    "projection_state": "unavailable",
    "using_last_verified": False,
    "contract": {
        "status": "unavailable",
        "schema_version": 0,
        "source_mode": "",
        "module_count": 0,
    },
    "topology": {
        "status": "unavailable",
        "fingerprint": "",
        "contract_id": "",
        "schema_version": 0,
        "module_count": 0,
        "connection_count": 0,
        "structure_node_count": 0,
    },
}
STARTUP_SNAPSHOT_DELAY_SECONDS = 5


def _validate_snapshot(snapshot: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    contract = validate_normalized_snapshot(snapshot)
    topology = validate_snapshot_topology(snapshot)
    if topology["status"] != "valid":
        raise TopologyContractError(
            "Canopy public snapshot does not contain a verified topology contract"
        )
    return contract, topology


def _latest_verified_snapshot() -> dict[str, Any] | None:
    snapshot = database.latest_snapshot()
    if snapshot is None:
        return None
    try:
        _validate_snapshot(snapshot)
    except (SnapshotContractError, TopologyContractError):
        return None
    return snapshot


def initialize_runtime() -> None:
    database.initialize()
    latest = _latest_verified_snapshot()
    if latest is not None:
        contract, topology = _validate_snapshot(latest)
        snapshot_sync_state.update(
            {
                "projection_state": "last_known_good",
                "using_last_verified": True,
                "contract": contract,
                "topology": topology,
            }
        )


def _incremental_since(cursor: str) -> str:
    if not cursor:
        return ""
    try:
        parsed = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (parsed.astimezone(timezone.utc) - timedelta(seconds=30)).isoformat(
        timespec="seconds"
    )


async def sync_life_events(*, full_scan: bool = False) -> dict[str, Any]:
    async with life_sync_lock:
        cursor = "" if full_scan else await asyncio.to_thread(database.life_event_cursor)
        activity, warning = await asyncio.to_thread(
            adapter.collect_activity,
            since=_incremental_since(cursor),
            days=settings.life_event_retention_days,
            max_events=500,
        )
        result = await asyncio.to_thread(database.import_life_events, activity)
        coverage = activity.get("coverage", {})
        current_omitted = activity.get("omitted", {})
        current_truncated = bool(activity.get("truncated", False))
        truncated = current_truncated if full_scan else bool(life_sync_state.get("truncated")) or current_truncated
        omitted = current_omitted if current_truncated or full_scan else life_sync_state.get("omitted", {})
        life_sync_state.update(
            {
                "status": "degraded" if warning else "live",
                "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "last_error": warning,
                **result,
                "coverage": coverage,
                "truncated": truncated,
                "omitted": omitted,
            }
        )
        return dict(life_sync_state)


async def life_event_sync_loop() -> None:
    delay = settings.life_event_sync_seconds
    first_scan = True
    while True:
        try:
            result = await sync_life_events(full_scan=first_scan)
            first_scan = False
            delay = (
                settings.life_event_sync_seconds
                if result.get("changed", 0)
                else min(30, max(settings.life_event_sync_seconds, int(delay * 1.5)))
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - degraded UI must not stop the service.
            life_sync_state.update(
                {
                    "status": "degraded",
                    "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "last_error": str(exc)[:300],
                }
            )
        await asyncio.sleep(delay)


async def sync_snapshot() -> dict[str, Any]:
    async with snapshot_sync_lock:
        try:
            snapshot = await asyncio.to_thread(adapter.collect, refresh=True)
            contract, topology = _validate_snapshot(snapshot)
            changed = await asyncio.to_thread(database.save_snapshot, snapshot)
            snapshot_sync_state.update(
                {
                    "status": "live",
                    "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "last_error": "",
                    "changed": changed,
                    "observation_state": "observed",
                    "projection_state": "current",
                    "using_last_verified": False,
                    "contract": contract,
                    "topology": topology,
                }
            )
            return snapshot
        except Exception as exc:  # noqa: BLE001 - persisted snapshot remains available.
            latest = await asyncio.to_thread(_latest_verified_snapshot)
            snapshot_sync_state.update(
                {
                    "status": "degraded",
                    "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "last_error": str(exc)[:300],
                    "changed": False,
                    "observation_state": "contract_invalid",
                    "projection_state": "last_known_good" if latest is not None else "unavailable",
                    "using_last_verified": latest is not None,
                }
            )
            raise


async def snapshot_sync_loop() -> None:
    # A persisted snapshot lets the UI become interactive immediately. Give
    # startup a short head start, then refresh automatically instead of making
    # the operator wait for the full recurring interval or press Sync.
    if await asyncio.to_thread(_latest_verified_snapshot) is not None:
        await asyncio.sleep(
            min(STARTUP_SNAPSHOT_DELAY_SECONDS, settings.snapshot_sync_seconds)
        )
    while True:
        try:
            await sync_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(settings.snapshot_sync_seconds)


async def companion_briefing_loop() -> None:
    """Refresh optional public companion sources away from the request path."""

    while True:
        try:
            await asyncio.to_thread(companion_cache.refresh)
        except asyncio.CancelledError:
            raise
        except Exception:
            # The optional companion must never affect observation or Core.
            pass
        await asyncio.sleep(settings.companion_refresh_seconds)


async def snapshot_projection(*, refresh: bool = False) -> dict[str, Any]:
    if not refresh:
        persisted = await asyncio.to_thread(_latest_verified_snapshot)
        if persisted is not None:
            return {"snapshot": persisted, "sync": dict(snapshot_sync_state)}
    try:
        snapshot = await sync_snapshot()
        return {"snapshot": snapshot, "sync": dict(snapshot_sync_state)}
    except Exception as exc:  # noqa: BLE001 - a verified projection is a safe fallback.
        persisted = await asyncio.to_thread(_latest_verified_snapshot)
        if persisted is not None:
            return {"snapshot": persisted, "sync": dict(snapshot_sync_state)}
        status_code = 409 if isinstance(exc, (SnapshotContractError, TopologyContractError)) else 503
        raise HTTPException(status_code=status_code, detail=str(exc)[:300]) from exc


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_runtime()
    tasks = [
        asyncio.create_task(life_event_sync_loop()),
        asyncio.create_task(snapshot_sync_loop()),
    ]
    if settings.companion_enabled:
        tasks.append(asyncio.create_task(companion_briefing_loop()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(
    title="Canopy Living System",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    lifespan=lifespan,
)


def _local_origin_allowed(origin: str) -> bool:
    if not origin:
        return True
    from urllib.parse import urlparse

    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def local_origin_guard(request: Request, call_next):
    if request.url.path.startswith("/api/") and not _local_origin_allowed(request.headers.get("origin", "")):
        return JSONResponse(status_code=403, content={"detail": "Cross-origin localhost requests are not allowed"})
    return await call_next(request)


class TreatmentInput(BaseModel):
    target_type: str = Field(pattern="^(seed_card|agent|receipt|log)$")
    target_id: str = Field(min_length=1, max_length=240)
    intent: str = Field(pattern="^(create|update|merge|archive|diagnose)$")
    operator_prompt: str = Field(min_length=4, max_length=2000)


class RemediationOpenInput(BaseModel):
    """Living System surface request for one Core-owned remediation."""

    issue_id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
    )
    mode: Literal["embedded", "handoff"] = "embedded"
    model: str | None = Field(default=None, min_length=1, max_length=100)
    reasoning_effort: str | None = Field(default=None, min_length=1, max_length=40)


class RemediationAuthorizationInput(BaseModel):
    """Explicit operator decision bound to the exact Core proposal hash."""

    decision: Literal["operator_approved", "operator_rejected"]
    proposal_hash: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


class GuidanceDecisionInput(BaseModel):
    decision: Literal["snooze", "dismiss"]
    expected_fingerprint: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    snooze_hours: int = Field(default=24, ge=1, le=720)


class GuidanceAnswerInput(BaseModel):
    answer: str = Field(min_length=1, max_length=1800)
    expected_fingerprint: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


async def _call_remediation(
    method: Any,
    *args: Any,
    **kwargs: Any,
) -> dict[str, Any]:
    """Keep blocking Core CLI work off the event loop and preserve typed failures."""

    try:
        return await asyncio.to_thread(method, *args, **kwargs)
    except RemediationUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.as_dict()) from exc
    except RemediationContractError as exc:
        raise HTTPException(status_code=502, detail=exc.as_dict()) from exc
    except RemediationAdapterError as exc:
        raise HTTPException(status_code=500, detail=exc.as_dict()) from exc


def _unavailable_guidance(sync: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.guidance",
        "status": "unavailable",
        "reason": observation_unavailable_reason(sync),
        "message": None,
    }


async def _current_guidance_source(
    *,
    message_id: str,
    expected_fingerprint: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve an action against the exact current public evidence version."""

    projection = await snapshot_projection()
    snapshot = projection["snapshot"]
    sync = projection.get("sync") if isinstance(projection.get("sync"), dict) else {}
    availability = select_guidance(snapshot=snapshot, sync=sync)
    if availability["status"] == "unavailable":
        raise HTTPException(
            status_code=409,
            detail={
                "code": availability["reason"],
                "message": "Current Canopy observation evidence is unavailable",
            },
        )
    message = find_guidance_message(
        snapshot,
        message_id=message_id,
        expected_fingerprint=expected_fingerprint,
        companion_messages=companion_cache.all_messages(),
    )
    if message is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "guidance_evidence_changed",
                "message": "The guidance source changed; refresh before acting",
            },
        )
    return snapshot, message


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    snapshot_current = (
        snapshot_sync_state["status"] == "live"
        and snapshot_sync_state["observation_state"] == "observed"
        and snapshot_sync_state["projection_state"] == "current"
    )
    return {
        "status": "healthy" if snapshot_current else "degraded",
        "service": "canopy-living-system",
        "canopy_instance": hashlib.sha256(
            str(settings.canopy_root).encode("utf-8")
        ).hexdigest()[:16],
        "canopy_connected": settings.canopy_root.is_dir(),
        "database_ready": settings.database_path.is_file(),
        "retention": {
            "snapshots_days": settings.snapshot_retention_days,
            "snapshots_max": settings.snapshot_max_records,
            "snapshots_sync_seconds": settings.snapshot_sync_seconds,
            "treatments_days": settings.treatment_retention_days,
            "treatments_max": settings.treatment_max_records,
            "life_events_days": settings.life_event_retention_days,
            "life_events_max": settings.life_event_max_records,
            "life_events_sync_seconds": settings.life_event_sync_seconds,
            "companion_refresh_seconds": settings.companion_refresh_seconds,
        },
        "companion": {
            "enabled": settings.companion_enabled,
            **companion_cache.status(),
        },
        "life_sync": dict(life_sync_state),
        "snapshot_sync": dict(snapshot_sync_state),
    }


@app.get("/api/snapshot")
async def api_snapshot() -> dict[str, Any]:
    return await snapshot_projection()


@app.get("/api/snapshot/revision")
async def api_snapshot_revision() -> dict[str, Any]:
    snapshot = await asyncio.to_thread(_latest_verified_snapshot)
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.snapshot-revision",
        "generated_at": str((snapshot or {}).get("generated_at", "")),
        "sync": dict(snapshot_sync_state),
    }


@app.post("/api/sync")
async def api_sync() -> dict[str, Any]:
    """Rebuild the local projection through the same path as automatic sync."""
    return await snapshot_projection(refresh=True)


@app.get("/api/guidance/current")
async def api_current_guidance(
    locale: Literal["zh-TW", "zh-CN", "en"] = "zh-TW",
) -> dict[str, Any]:
    """Return one bounded Fura prompt from current Core-owned evidence."""

    try:
        projection = await snapshot_projection()
    except HTTPException:
        return _unavailable_guidance(dict(snapshot_sync_state))
    snapshot = projection["snapshot"]
    sync = projection.get("sync") if isinstance(projection.get("sync"), dict) else {}
    presentations = await asyncio.to_thread(database.guidance_presentations)
    return select_guidance(
        snapshot=snapshot,
        sync=sync,
        presentations=presentations,
        companion_messages=(
            companion_cache.messages(locale) if settings.companion_enabled else []
        ),
    )


@app.post("/api/guidance/{message_id}/decision")
async def api_guidance_decision(
    message_id: str,
    payload: GuidanceDecisionInput,
) -> dict[str, Any]:
    _, message = await _current_guidance_source(
        message_id=message_id,
        expected_fingerprint=payload.expected_fingerprint,
    )
    target = message["target"]
    snoozed_until = ""
    if payload.decision == "snooze":
        snoozed_until = (
            datetime.now(timezone.utc) + timedelta(hours=payload.snooze_hours)
        ).isoformat(timespec="seconds")
    await asyncio.to_thread(
        database.record_guidance_decision,
        source_kind=message["kind"],
        source_id=target["id"],
        source_fingerprint=message["fingerprint"],
        decision=payload.decision,
        snoozed_until=snoozed_until,
    )
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.guidance-decision",
        "status": "recorded",
        "message_id": message["id"],
        "decision": payload.decision,
        "snoozed_until": snoozed_until,
    }


@app.post("/api/guidance/{message_id}/answer")
async def api_guidance_answer(
    message_id: str,
    payload: GuidanceAnswerInput,
) -> dict[str, Any]:
    snapshot, message = await _current_guidance_source(
        message_id=message_id,
        expected_fingerprint=payload.expected_fingerprint,
    )
    if message["kind"] != "question" or message["target"]["type"] != "seed_card":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "guidance_not_answerable",
                "message": "This guidance item is not a Seed reflection question",
            },
        )
    answer = payload.answer.strip()
    if not answer:
        raise HTTPException(status_code=422, detail="answer must not be blank")

    target_id = message["target"]["id"]
    previous = await asyncio.to_thread(
        database.get_guidance_presentation,
        source_kind="question",
        source_id=target_id,
        source_fingerprint=message["fingerprint"],
    )
    if previous and previous.get("decision") == "answered":
        linked_id = str(previous.get("linked_artifact_id", ""))
        linked = (
            await asyncio.to_thread(database.get_treatment, linked_id)
            if linked_id
            else None
        )
        if linked is not None:
            return {
                "schema_version": 1,
                "contract_id": "canopy.living-system.guidance-answer",
                "status": "awaiting_ai_review",
                "message_id": message["id"],
                "treatment": linked,
                "provenance": {
                    "operator_evidence": "operator_explicit",
                    "ai_inferred_candidate": None,
                    "distillation_status": "awaiting_ai_review",
                },
            }

    try:
        request_type, proposal = build_treatment_proposal(
            snapshot=snapshot,
            target_type="seed_card",
            target_id=target_id,
            intent="update",
            operator_prompt=f"使用者回覆芙拉的反思問題：{answer}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    proposal["dialogue"] = {
        "question": message["body"],
        "operator_evidence": {
            "provenance": "operator_explicit",
            "content": answer,
        },
        "ai_inferred_candidate": None,
        "distillation_status": "awaiting_ai_review",
        "learning_status": "not_yet_learned",
    }
    treatment = await asyncio.to_thread(
        database.create_treatment,
        request_type=request_type,
        target_type="seed_card",
        target_id=target_id,
        intent="update",
        operator_prompt=f"使用者回覆芙拉的反思問題：{answer}",
        proposal=proposal,
    )
    await asyncio.to_thread(
        database.record_guidance_decision,
        source_kind="question",
        source_id=target_id,
        source_fingerprint=message["fingerprint"],
        decision="answered",
        linked_artifact_type=request_type,
        linked_artifact_id=treatment["id"],
    )
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.guidance-answer",
        "status": "awaiting_ai_review",
        "message_id": message["id"],
        "treatment": treatment,
        "provenance": {
            "operator_evidence": "operator_explicit",
            "ai_inferred_candidate": None,
            "distillation_status": "awaiting_ai_review",
        },
    }


@app.get("/api/cards")
async def api_cards(
    lifecycle: str = Query(default=""),
    category: str = Query(default=""),
    search: str = Query(default="", max_length=120),
) -> dict[str, Any]:
    snapshot = (await snapshot_projection())["snapshot"]
    cards = list((snapshot.get("seed_memory") or {}).get("cards", []))
    search_text = search.strip().lower()
    if lifecycle:
        cards = [card for card in cards if card.get("lifecycle") == lifecycle]
    if category:
        cards = [card for card in cards if card.get("category") == category]
    if search_text:
        cards = [
            card
            for card in cards
            if search_text
            in " ".join(
                [
                    str(card.get("id", "")),
                    str(card.get("summary", "")),
                    str(card.get("source_summary", "")),
                    " ".join(card.get("triggers", [])),
                ]
            ).lower()
        ]
    return {"cards": cards, "count": len(cards)}


@app.get("/api/cards/{card_id:path}")
async def api_card(card_id: str) -> dict[str, Any]:
    snapshot = (await snapshot_projection())["snapshot"]
    for card in (snapshot.get("seed_memory") or {}).get("cards", []):
        if card.get("id") == card_id:
            return card
    raise HTTPException(status_code=404, detail="Seed card not found")


@app.get("/api/history")
async def api_history(limit: int = Query(default=30, ge=1, le=100)) -> dict[str, Any]:
    return {"snapshots": await asyncio.to_thread(database.snapshot_history, limit)}


@app.get("/api/life-events")
async def api_life_events(
    limit: int = Query(default=140, ge=1, le=500),
) -> dict[str, Any]:
    events, stats = await asyncio.gather(
        asyncio.to_thread(database.list_life_events, limit),
        asyncio.to_thread(database.life_event_stats),
    )
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.life-events",
        "events": events,
        "stats": stats,
        "retention_days": settings.life_event_retention_days,
        "sync": dict(life_sync_state),
    }


@app.get("/api/life-events/revision")
async def api_life_events_revision() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "contract_id": "canopy.living-system.life-events-revision",
        "stats": await asyncio.to_thread(database.life_event_stats),
        "sync": dict(life_sync_state),
    }


@app.get("/api/evolution-lab")
async def api_evolution_lab() -> dict[str, Any]:
    """Run the bounded public Evolution checks only when the laboratory is opened."""
    return await asyncio.to_thread(adapter.collect_evolution_lab)


@app.get("/api/remediations/capabilities")
async def api_remediation_capabilities() -> dict[str, Any]:
    """Expose Core-discovered models and reasoning efforts without a UI catalog."""

    return await _call_remediation(remediation_adapter.capabilities)


@app.post("/api/remediations")
async def api_open_remediation(payload: RemediationOpenInput) -> dict[str, Any]:
    """Open or reuse the canonical Core remediation for one public issue."""

    snapshot = (await snapshot_projection())["snapshot"]
    issue = next(
        (
            item
            for item in snapshot.get("issues", [])
            if isinstance(item, dict) and item.get("id") == payload.issue_id
        ),
        None,
    )
    if issue is None:
        raise HTTPException(
            status_code=404,
            detail="The requested finding is not in the current public Canopy snapshot",
        )
    remediation = issue.get("remediation")
    if not isinstance(remediation, dict) or remediation.get("requestable") is not True:
        raise HTTPException(
            status_code=409,
            detail="Canopy Core has not marked this finding as requestable",
        )

    return await _call_remediation(
        remediation_adapter.open,
        payload.issue_id,
        origin="living_system",
        mode=payload.mode,
        model=payload.model or "",
        effort=payload.reasoning_effort or "",
    )


@app.get("/api/remediations")
async def api_remediations(
    limit: int = Query(default=30, ge=1, le=100),
) -> dict[str, Any]:
    return await _call_remediation(remediation_adapter.list, limit)


@app.get("/api/remediations/{remediation_id}")
async def api_remediation_status(remediation_id: str) -> dict[str, Any]:
    return await _call_remediation(remediation_adapter.status, remediation_id)


@app.post("/api/remediations/{remediation_id}/diagnose")
async def api_diagnose_remediation(remediation_id: str) -> dict[str, Any]:
    return await _call_remediation(remediation_adapter.diagnose, remediation_id)


@app.post("/api/remediations/{remediation_id}/authorize")
async def api_authorize_remediation(
    remediation_id: str,
    payload: RemediationAuthorizationInput,
) -> dict[str, Any]:
    return await _call_remediation(
        remediation_adapter.authorize,
        remediation_id,
        payload.decision,
        payload.proposal_hash,
    )


@app.post("/api/remediations/{remediation_id}/run")
async def api_run_remediation(remediation_id: str) -> dict[str, Any]:
    return await _call_remediation(remediation_adapter.run, remediation_id)


@app.get("/api/remediations/{remediation_id}/handoff")
async def api_remediation_handoff(remediation_id: str) -> dict[str, Any]:
    return await _call_remediation(remediation_adapter.handoff, remediation_id)


@app.post("/api/treatments")
async def api_create_treatment(payload: TreatmentInput) -> dict[str, Any]:
    snapshot = (await snapshot_projection())["snapshot"]
    try:
        request_type, proposal = build_treatment_proposal(
            snapshot=snapshot,
            target_type=payload.target_type,
            target_id=payload.target_id,
            intent=payload.intent,
            operator_prompt=payload.operator_prompt,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await asyncio.to_thread(
        database.create_treatment,
        request_type=request_type,
        target_type=payload.target_type,
        target_id=payload.target_id,
        intent=payload.intent,
        operator_prompt=payload.operator_prompt,
        proposal=proposal,
    )


@app.get("/api/treatments")
async def api_treatments(limit: int = Query(default=30, ge=1, le=100)) -> dict[str, Any]:
    items = await asyncio.to_thread(database.list_treatments, limit)
    return {"treatments": items, "count": len(items)}


@app.get("/api/treatments/{request_id}")
async def api_treatment(request_id: str) -> dict[str, Any]:
    item = await asyncio.to_thread(database.get_treatment, request_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Treatment request not found")
    return item


dist_dir = settings.project_root / "dist"
assets_dir = dist_dir / "assets"
if assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/{path:path}", include_in_schema=False)
async def frontend(path: str):
    candidate = (dist_dir / path).resolve()
    try:
        candidate.relative_to(dist_dir.resolve())
    except ValueError:
        candidate = dist_dir / "index.html"
    if path and candidate.is_file():
        return FileResponse(candidate)
    index = dist_dir / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(status_code=503, detail="Frontend is not built; run npm run build")
