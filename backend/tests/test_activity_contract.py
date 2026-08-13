from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from backend.app.activity_contract import (
    ActivityContractError,
    validate_activity_projection,
)
from backend.app.canopy_adapter import CanopyAdapter, empty_activity
from backend.app.database import ObservatoryDatabase


def public_activity() -> dict:
    payload = empty_activity()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload["window"] = {
        "days": 30,
        "from": now,
        "to": now,
        "timezone": "CST",
    }
    payload["events"] = [
        {
            "id": "activity:turn:one",
            "occurred_at": now,
            "local_date": "2026-08-13",
            "correlation_id": "turn:one",
            "module_id": "hooks",
            "kind": "turn",
            "phase": "completed",
            "status": "completed",
            "importance": 2,
            "actor": "canopy",
            "action": "turn_completed",
            "summary": "Canopy 已完成本回合的公開觀測。",
            "assistance": "Canopy 執行了有邊界的收尾驗證。",
            "request_effect": "沒有增加新的任務範圍。",
            "verification": "公開收據已回報完成。",
            "learning": "",
            "growth_stage": "",
            "next_benefit": "",
            "source": "hook_activity",
            "facts": {
                "role": "senior-engineer",
                "model": "gpt-test",
            },
        }
    ]
    payload["sync_cursor"] = now
    return payload


class ActivityContractTest(unittest.TestCase):
    def test_v3_projection_is_allowlisted_before_sqlite_persistence(self) -> None:
        payload = public_activity()
        payload["private_internal"] = {"token": "must-not-persist"}
        payload["privacy"]["unreviewed_private_flag"] = False
        payload["events"][0]["raw_prompt"] = "must-not-persist"
        payload["events"][0]["hidden_reasoning"] = "must-not-persist"
        payload["events"][0]["facts"]["private_workspace_path"] = "/private/path"

        sanitized = validate_activity_projection(payload)

        self.assertNotIn("private_internal", sanitized)
        self.assertNotIn("unreviewed_private_flag", sanitized["privacy"])
        self.assertNotIn("raw_prompt", sanitized["events"][0])
        self.assertNotIn("hidden_reasoning", sanitized["events"][0])
        self.assertNotIn("private_workspace_path", sanitized["events"][0]["facts"])

        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "observatory.db")
            database.initialize()
            database.import_life_events(sanitized)
            persisted = json.dumps(database.list_life_events(), ensure_ascii=False)

        self.assertNotIn("must-not-persist", persisted)
        self.assertNotIn("/private/path", persisted)
        self.assertIn("senior-engineer", persisted)

    def test_schema_and_privacy_attestations_are_hard_gates(self) -> None:
        schema_two = public_activity()
        schema_two["schema_version"] = 2
        with self.assertRaisesRegex(ActivityContractError, "schema_version"):
            validate_activity_projection(schema_two)

        unsafe = public_activity()
        unsafe["privacy"]["raw_prompts_included"] = True
        with self.assertRaisesRegex(ActivityContractError, "raw_prompts_included"):
            validate_activity_projection(unsafe)

        unreviewed = public_activity()
        unreviewed["privacy"]["future_private_data_included"] = True
        with self.assertRaisesRegex(ActivityContractError, "future_private_data_included"):
            validate_activity_projection(unreviewed)

        missing_attestation = public_activity()
        del missing_attestation["privacy"]["hidden_reasoning_included"]
        with self.assertRaisesRegex(ActivityContractError, "hidden_reasoning_included"):
            validate_activity_projection(missing_attestation)

    def test_required_event_fields_are_not_silently_defaulted(self) -> None:
        payload = public_activity()
        del payload["events"][0]["summary"]

        with self.assertRaisesRegex(ActivityContractError, "summary is required"):
            validate_activity_projection(payload)

    def test_invalid_cli_payload_degrades_to_empty_without_replacing_last_known_good(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "canopy").touch()
            database = ObservatoryDatabase(root / "observatory.db")
            database.initialize()
            database.import_life_events(validate_activity_projection(public_activity()))
            adapter = CanopyAdapter(root)
            unsafe = public_activity()
            unsafe["privacy"]["raw_tool_outputs_included"] = True

            with patch.object(
                adapter,
                "_run_json",
                side_effect=[
                    (unsafe, ""),
                    ({}, "public snapshot unavailable"),
                ],
            ):
                activity, warning = adapter.collect_activity()

            result = database.import_life_events(activity)

        self.assertEqual(activity["schema_version"], 3)
        self.assertEqual(activity["events"], [])
        self.assertIn("invalid activity contract", warning)
        self.assertIn("raw_tool_outputs_included", warning)
        self.assertEqual(result["accepted"], 0)
        self.assertEqual(result["persisted"], 1)

    def test_snapshot_fallback_is_also_validated_and_sanitized(self) -> None:
        adapter = CanopyAdapter(Path("/opt/canopy"))
        invalid_cli = public_activity()
        invalid_cli["contract_id"] = "private.activity"
        fallback = public_activity()
        fallback["events"][0]["raw_prompt"] = "must-not-be-exposed"

        with patch.object(adapter, "_run_json", return_value=(invalid_cli, "")), patch.object(
            adapter,
            "collect",
            return_value={"activity": fallback},
        ):
            activity, warning = adapter.collect_activity()

        self.assertNotIn("raw_prompt", activity["events"][0])
        self.assertIn("invalid activity contract", warning)
        self.assertIn("using snapshot activity", warning)


if __name__ == "__main__":
    unittest.main()
