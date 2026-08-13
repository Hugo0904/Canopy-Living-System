from __future__ import annotations

import json
import runpy
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
LIFECYCLE = ROOT / "observatory"


def load_lifecycle() -> dict[str, object]:
    return runpy.run_path(str(LIFECYCLE))


def test_hook_reconciliation_uses_narrow_core_owned_repair() -> None:
    lifecycle = load_lifecycle()
    canopy_root = Path("/example/Canopy")
    result = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=json.dumps({"status": "PASS", "changed": False}),
        stderr="",
    )

    reconcile = lifecycle["reconcile_canopy_hooks"]
    mocked = Mock(return_value=result)
    with patch.dict(reconcile.__globals__, {"run": mocked}):
        payload = reconcile(canopy_root, mode="installed")

    assert payload["status"] == "PASS"
    command = mocked.call_args.args[0]
    assert command == [
        sys.executable,
        str(canopy_root / "canopy"),
        "repair",
        "codex-hooks",
        "--mode",
        "installed",
        "--json",
    ]


def test_hook_reconciliation_rejects_unverified_response() -> None:
    lifecycle = load_lifecycle()
    result = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=json.dumps({"status": "FAIL"}),
        stderr="",
    )

    reconcile = lifecycle["reconcile_canopy_hooks"]
    with patch.dict(reconcile.__globals__, {"run": Mock(return_value=result)}):
        try:
            reconcile(Path("/example/Canopy"), mode="core")
        except RuntimeError as exc:
            assert "did not verify PASS" in str(exc)
        else:
            raise AssertionError("unverified hook reconciliation must fail closed")


def test_start_reconciles_hooks_even_when_service_is_already_running() -> None:
    lifecycle = load_lifecycle()
    start = lifecycle["start"]
    reconcile = Mock(return_value={"status": "PASS", "changed": False})
    canopy_root = Path("/example/Canopy")
    with patch.dict(
        start.__globals__,
        {
            "running_runtime": Mock(return_value={"port": 8765}),
            "reconcile_canopy_hooks": reconcile,
        },
    ):
        url = start(canopy_root, preferred_port=8765, open_browser=False)

    assert url == "http://127.0.0.1:8765"
    reconcile.assert_called_once_with(canopy_root, mode="installed")


def test_uninstall_restores_core_hooks_before_removing_runtime(tmp_path: Path) -> None:
    lifecycle = load_lifecycle()
    uninstall = lifecycle["uninstall"]
    canopy_root = Path("/example/Canopy")
    calls: list[str] = []
    data_dir = tmp_path / ".data"
    data_dir.mkdir()

    with patch.dict(
        uninstall.__globals__,
        {
            "ROOT": tmp_path,
            "DATA_DIR": data_dir,
            "stop": lambda: calls.append("stop"),
            "reconcile_canopy_hooks": lambda root, *, mode: calls.append(
                f"repair:{root}:{mode}"
            ),
        },
    ):
        uninstall(canopy_root)

    assert calls == ["stop", f"repair:{canopy_root}:core"]
    assert not data_dir.exists()
