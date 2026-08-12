from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .canopy_adapter import CanopyAdapter
from .database import ObservatoryDatabase
from .proposals import build_treatment_proposal
from .settings import Settings
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
life_sync_state: dict[str, Any] = {
    "status": "starting",
    "last_synced_at": "",
    "last_error": "",
    "accepted": 0,
    "persisted": 0,
}
snapshot_sync_state: dict[str, Any] = {
    "status": "starting",
    "last_synced_at": "",
    "last_error": "",
    "changed": False,
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


def initialize_runtime() -> None:
    database.initialize()


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


async def sync_life_events() -> dict[str, Any]:
    cursor = await asyncio.to_thread(database.life_event_cursor)
    activity, warning = await asyncio.to_thread(
        adapter.collect_activity,
        since=_incremental_since(cursor),
        days=settings.life_event_retention_days,
        max_events=500,
    )
    result = await asyncio.to_thread(database.import_life_events, activity)
    life_sync_state.update(
        {
            "status": "degraded" if warning else "live",
            "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "last_error": warning,
            **result,
            "coverage": activity.get("coverage", {}),
        }
    )
    return dict(life_sync_state)


async def life_event_sync_loop() -> None:
    while True:
        try:
            await sync_life_events()
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
        await asyncio.sleep(settings.life_event_sync_seconds)


async def sync_snapshot() -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(adapter.collect, refresh=True)
        topology = validate_snapshot_topology(snapshot)
        latest = await asyncio.to_thread(database.latest_snapshot)
        if topology["status"] == "unavailable" and latest is not None:
            latest_topology = validate_snapshot_topology(latest)
            if latest_topology["status"] == "valid":
                raise TopologyContractError(
                    "Canopy public topology is temporarily unavailable; retained the last verified projection"
                )
        changed = await asyncio.to_thread(database.save_snapshot, snapshot)
        snapshot_sync_state.update(
            {
                "status": "live",
                "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "last_error": "",
                "changed": changed,
                "topology": topology,
            }
        )
        return snapshot
    except Exception as exc:  # noqa: BLE001 - persisted snapshot remains available.
        snapshot_sync_state.update(
            {
                "status": "degraded",
                "last_synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "last_error": str(exc)[:300],
            }
        )
        raise


async def snapshot_sync_loop() -> None:
    # A persisted snapshot lets the UI become interactive immediately. Avoid
    # competing with the first page load by deferring the heavier Core scan;
    # a fresh installation (with no snapshot yet) still collects at once.
    if await asyncio.to_thread(database.latest_snapshot) is not None:
        await asyncio.sleep(settings.snapshot_sync_seconds)
    while True:
        try:
            await sync_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(settings.snapshot_sync_seconds)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_runtime()
    life_task = asyncio.create_task(life_event_sync_loop())
    snapshot_task = asyncio.create_task(snapshot_sync_loop())
    try:
        yield
    finally:
        life_task.cancel()
        snapshot_task.cancel()
        await asyncio.gather(life_task, snapshot_task, return_exceptions=True)


app = FastAPI(
    title="Canopy Living System",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    lifespan=lifespan,
)


class TreatmentInput(BaseModel):
    target_type: str = Field(pattern="^(seed_card|module|agent|receipt|log)$")
    target_id: str = Field(min_length=1, max_length=240)
    intent: str = Field(pattern="^(create|update|merge|archive|diagnose)$")
    operator_prompt: str = Field(min_length=4, max_length=2000)


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {
        "status": "healthy",
        "service": "canopy-living-system",
        "canopy_root": str(settings.canopy_root),
        "database": str(settings.database_path),
        "retention": {
            "snapshots_days": settings.snapshot_retention_days,
            "snapshots_max": settings.snapshot_max_records,
            "snapshots_sync_seconds": settings.snapshot_sync_seconds,
            "treatments_days": settings.treatment_retention_days,
            "treatments_max": settings.treatment_max_records,
            "life_events_days": settings.life_event_retention_days,
            "life_events_max": settings.life_event_max_records,
            "life_events_sync_seconds": settings.life_event_sync_seconds,
        },
        "life_sync": dict(life_sync_state),
        "snapshot_sync": dict(snapshot_sync_state),
    }


@app.get("/api/snapshot")
async def api_snapshot(refresh: bool = Query(default=False)) -> dict[str, Any]:
    if not refresh:
        persisted = await asyncio.to_thread(database.latest_snapshot)
        if persisted is not None:
            return persisted
    try:
        return await sync_snapshot()
    except TopologyContractError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/sync")
async def api_sync() -> dict[str, Any]:
    """Rebuild the local projection through the same path as automatic sync."""
    try:
        snapshot = await sync_snapshot()
    except TopologyContractError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"snapshot": snapshot, "sync": dict(snapshot_sync_state)}


@app.get("/api/cards")
async def api_cards(
    lifecycle: str = Query(default=""),
    category: str = Query(default=""),
    search: str = Query(default="", max_length=120),
) -> dict[str, Any]:
    snapshot = await asyncio.to_thread(adapter.collect)
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
    snapshot = await asyncio.to_thread(adapter.collect)
    for card in (snapshot.get("seed_memory") or {}).get("cards", []):
        if card.get("id") == card_id:
            return card
    raise HTTPException(status_code=404, detail="Seed card not found")


@app.get("/api/history")
async def api_history(limit: int = Query(default=30, ge=1, le=100)) -> dict[str, Any]:
    return {"snapshots": await asyncio.to_thread(database.snapshot_history, limit)}


@app.get("/api/life-events")
async def api_life_events(
    limit: int = Query(default=160, ge=1, le=500),
    refresh: bool = Query(default=False),
) -> dict[str, Any]:
    if refresh:
        await sync_life_events()
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


@app.get("/api/evolution-lab")
async def api_evolution_lab() -> dict[str, Any]:
    """Run the bounded public Evolution checks only when the laboratory is opened."""
    return await asyncio.to_thread(adapter.collect_evolution_lab)


@app.post("/api/treatments")
async def api_create_treatment(payload: TreatmentInput) -> dict[str, Any]:
    snapshot = await asyncio.to_thread(adapter.collect)
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
