from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    project_root: Path
    canopy_root: Path
    data_dir: Path
    database_path: Path
    snapshot_cache_seconds: int
    snapshot_sync_seconds: int
    snapshot_retention_days: int
    snapshot_max_records: int
    treatment_retention_days: int
    treatment_max_records: int
    life_event_retention_days: int
    life_event_max_records: int
    life_event_sync_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        project_root = PROJECT_ROOT
        canopy_raw = os.getenv("CANOPY_ROOT", "").strip()
        canopy_root = (
            Path(canopy_raw).expanduser().resolve()
            if canopy_raw
            else (project_root.parent / "Canopy").resolve()
        )
        data_raw = os.getenv("CANOPY_OBSERVATORY_DATA_DIR", "").strip()
        data_dir = (
            Path(data_raw).expanduser().resolve()
            if data_raw
            else (project_root / ".data").resolve()
        )
        try:
            cache_seconds = max(
                5, min(300, int(os.getenv("CANOPY_OBSERVATORY_CACHE_SECONDS", "20")))
            )
        except ValueError:
            cache_seconds = 20

        def bounded_int(name: str, fallback: int, minimum: int, maximum: int) -> int:
            try:
                return max(minimum, min(maximum, int(os.getenv(name, str(fallback)))))
            except ValueError:
                return fallback

        return cls(
            project_root=project_root,
            canopy_root=canopy_root,
            data_dir=data_dir,
            database_path=data_dir / "observatory.db",
            snapshot_cache_seconds=cache_seconds,
            snapshot_sync_seconds=bounded_int(
                "CANOPY_LIVING_SYSTEM_SNAPSHOT_SYNC_SECONDS", 300, 60, 3600
            ),
            snapshot_retention_days=bounded_int("CANOPY_OBSERVATORY_SNAPSHOT_DAYS", 30, 7, 365),
            snapshot_max_records=bounded_int("CANOPY_OBSERVATORY_SNAPSHOT_MAX", 500, 30, 5000),
            treatment_retention_days=bounded_int("CANOPY_OBSERVATORY_TREATMENT_DAYS", 90, 30, 730),
            treatment_max_records=bounded_int("CANOPY_OBSERVATORY_TREATMENT_MAX", 200, 30, 2000),
            life_event_retention_days=bounded_int(
                "CANOPY_LIVING_SYSTEM_EVENT_DAYS", 60, 7, 365
            ),
            life_event_max_records=bounded_int(
                "CANOPY_LIVING_SYSTEM_EVENT_MAX", 5000, 200, 20000
            ),
            life_event_sync_seconds=bounded_int(
                "CANOPY_LIVING_SYSTEM_SYNC_SECONDS", 4, 2, 60
            ),
        )
