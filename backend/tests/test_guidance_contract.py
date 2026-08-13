from __future__ import annotations

import ssl
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from backend.app import main as backend_main
from backend.app.companionship import CompanionBriefingCache, _fetch_json
from backend.app.database import ObservatoryDatabase
from backend.app.guidance import build_guidance_messages, select_guidance


CURRENT_SYNC = {
    "status": "live",
    "observation_state": "observed",
    "projection_state": "current",
}


def guidance_snapshot(*, issue_detail: str = "Hook runtime evidence is missing.") -> dict:
    return {
        "generated_at": "2026-08-13T08:00:00+00:00",
        "issues": [
            {
                "id": "doctor:codex-hooks",
                "owner": "canopy_core",
                "severity": "attention",
                "title": "Runtime evidence needs attention",
                "detail": issue_detail,
                "module_ids": ["hooks"],
                "evidence": ["doctor=unavailable"],
                "remediation": {
                    "state": "case_open",
                    "requestable": True,
                    "action_id": "repair_codex_hooks",
                    "verification": "canopy doctor --json",
                },
            }
        ],
        "seed_memory": {
            "cards": [
                {
                    "id": "pref.ui.clarity",
                    "title": "介面清楚度",
                    "summary": "讓狀態更容易理解",
                    "lifecycle": "active",
                    "reflection_question": "遇到異常時，你希望先看到原因還是修正建議？",
                    "source_type": "user_teaching",
                    "source_summary": "使用者希望狀態容易理解",
                    "review_after": "",
                }
            ]
        },
    }


class GuidanceSelectionTest(unittest.TestCase):
    def test_contract_failure_is_unavailable_instead_of_quiet_or_healthy(self) -> None:
        result = select_guidance(
            snapshot=guidance_snapshot(),
            sync={
                "status": "degraded",
                "observation_state": "contract_invalid",
                "projection_state": "last_known_good",
            },
        )

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], "observation_contract_invalid")
        self.assertIsNone(result["message"])

    def test_one_message_uses_core_issue_evidence_and_existing_remediation(self) -> None:
        result = select_guidance(snapshot=guidance_snapshot(), sync=CURRENT_SYNC)

        self.assertEqual(result["status"], "available")
        message = result["message"]
        self.assertEqual(message["kind"], "issue")
        self.assertEqual(message["body"], "Hook runtime evidence is missing.")
        self.assertEqual(message["claim_status"], "core_evidence")
        self.assertEqual(message["target"]["id"], "doctor:codex-hooks")
        self.assertEqual(message["evidence"], ["doctor=unavailable"])
        self.assertIn("diagnose", message["actions"])
        self.assertEqual(len(message["fingerprint"]), 64)

    def test_snooze_hides_only_the_same_evidence_version(self) -> None:
        snapshot = guidance_snapshot()
        issue_message = build_guidance_messages(snapshot)[0]
        future = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(
            timespec="seconds"
        )
        states = {
            (
                issue_message["kind"],
                issue_message["target"]["id"],
                issue_message["fingerprint"],
            ): {"decision": "snooze", "snoozed_until": future}
        }

        result = select_guidance(
            snapshot=snapshot,
            sync=CURRENT_SYNC,
            presentations=states,
        )
        self.assertEqual(result["message"]["kind"], "question")

        changed = guidance_snapshot(issue_detail="New Core evidence is now available.")
        changed_result = select_guidance(
            snapshot=changed,
            sync=CURRENT_SYNC,
            presentations=states,
        )
        self.assertEqual(changed_result["message"]["kind"], "issue")
        self.assertNotEqual(
            changed_result["message"]["fingerprint"], issue_message["fingerprint"]
        )

    def test_observation_timestamp_does_not_break_a_semantic_snooze(self) -> None:
        first = guidance_snapshot()
        first["issues"][0]["last_seen_at"] = "2026-08-13T08:00:00+00:00"
        later = guidance_snapshot()
        later["issues"][0]["last_seen_at"] = "2026-08-13T08:05:00+00:00"

        self.assertEqual(
            build_guidance_messages(first)[0]["fingerprint"],
            build_guidance_messages(later)[0]["fingerprint"],
        )

    def test_read_only_issue_does_not_hide_a_question_the_user_can_answer(self) -> None:
        snapshot = guidance_snapshot()
        snapshot["issues"][0]["remediation"]["requestable"] = False

        result = select_guidance(
            snapshot=snapshot,
            sync=CURRENT_SYNC,
            now=datetime(2026, 8, 13, 8, tzinfo=timezone.utc),
        )

        self.assertEqual(result["message"]["kind"], "question")

    def test_daily_message_requires_a_verified_source_and_remains_bounded(self) -> None:
        snapshot = guidance_snapshot()
        snapshot["issues"] = []
        snapshot["seed_memory"]["cards"] = []
        daily = {
            "id": "weather:2026-08-13:zh-TW",
            "category": "weather",
            "title": "今天的臺北：晴朗，30°C",
            "body": "這是模型預報，不是現場實測。",
            "source_owner": "open_meteo",
            "source_name": "Open-Meteo",
            "source_url": "https://open-meteo.com/en/docs",
            "observed_at": "2026-08-13T12:00:00+08:00",
            "claim_status": "external_verified",
            "facts": {"temperature_c": 30},
        }

        result = select_guidance(
            snapshot=snapshot,
            sync=CURRENT_SYNC,
            companion_messages=[daily] * 20,
            now=datetime(2026, 8, 13, 8, tzinfo=timezone.utc),
        )

        self.assertEqual(result["message"]["kind"], "daily")
        self.assertEqual(result["message"]["claim_status"], "external_verified")
        self.assertEqual(result["message"]["target"]["source_name"], "Open-Meteo")
        self.assertIn("source", result["message"]["actions"])


class CompanionBriefingTest(unittest.TestCase):
    def test_fetch_json_uses_a_verified_certifi_tls_context(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"ok": true}'

        with patch("backend.app.companionship.urlopen", return_value=response) as mocked:
            self.assertEqual(_fetch_json("https://api.open-meteo.com/test"), {"ok": True})

        kwargs = mocked.call_args.kwargs
        self.assertEqual(kwargs["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(kwargs["context"].check_hostname)

    def test_refresh_uses_three_bounded_sources_and_localizes_messages(self) -> None:
        weather = {
            "current": {
                "temperature_2m": 30.2,
                "apparent_temperature": 34.1,
                "weather_code": 1,
                "time": "2026-08-13T15:00",
            },
            "daily": {
                "time": ["2026-08-13"],
                "temperature_2m_max": [34.5],
                "temperature_2m_min": [27.1],
                "precipitation_probability_max": [40],
            },
        }
        history = {
            "selected": [{
                "text": "A verifiable event from this date.",
                "year": 1960,
                "pages": [{
                    "content_urls": {
                        "desktop": {"page": "https://en.wikipedia.org/wiki/Example"}
                    }
                }],
            }]
        }
        requested: list[str] = []

        def fetch_json(url: str) -> dict:
            requested.append(url)
            return weather if "open-meteo" in url else history

        cache = CompanionBriefingCache(location="臺北")
        status = cache.refresh(
            now=datetime(2026, 8, 13, 7, tzinfo=timezone.utc),
            fetch_json=fetch_json,
        )

        self.assertEqual(len(requested), 3)
        self.assertEqual(status["status"], "available")
        self.assertLessEqual(status["count"], 6)
        self.assertEqual(len(cache.messages("zh-TW")), 2)
        self.assertEqual(len(cache.messages("en")), 2)
        self.assertTrue(all(item["source_url"].startswith("https://") for item in cache.all_messages()))

    def test_source_failures_are_optional_and_return_no_fabricated_message(self) -> None:
        cache = CompanionBriefingCache()

        status = cache.refresh(fetch_json=lambda _: (_ for _ in ()).throw(OSError("offline")))

        self.assertEqual(status["status"], "unavailable")
        self.assertEqual(cache.all_messages(), [])
        self.assertIn("weather:OSError", status["last_error"])


class GuidanceDatabaseTest(unittest.TestCase):
    def test_sqlite_stores_only_bounded_presentation_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "living.db")
            database.initialize()
            fingerprint = "a" * 64
            saved = database.record_guidance_decision(
                source_kind="issue",
                source_id="doctor:codex-hooks",
                source_fingerprint=fingerprint,
                decision="dismiss",
            )

            self.assertEqual(saved["decision"], "dismiss")
            self.assertEqual(
                database.guidance_presentations()[
                    ("issue", "doctor:codex-hooks", fingerprint)
                ]["source_id"],
                "doctor:codex-hooks",
            )
            with database.connect() as connection:
                columns = {
                    row["name"]
                    for row in connection.execute(
                        "PRAGMA table_info(guidance_presentations)"
                    ).fetchall()
                }
                migration = connection.execute(
                    "SELECT 1 FROM schema_migrations WHERE version = 6"
                ).fetchone()
            self.assertNotIn("title", columns)
            self.assertNotIn("body", columns)
            self.assertIsNotNone(migration)

    def test_daily_decision_is_bounded_projection_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "living.db")
            database.initialize()
            saved = database.record_guidance_decision(
                source_kind="daily",
                source_id="weather:2026-08-13:zh-TW",
                source_fingerprint="b" * 64,
                decision="snooze",
                snoozed_until="2026-08-14T00:00:00+00:00",
            )

        self.assertEqual(saved["source_kind"], "daily")
        self.assertEqual(saved["decision"], "snooze")


class GuidanceApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_current_returns_unavailable_for_last_known_good_contract_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "living.db")
            database.initialize()
            projection = {
                "snapshot": guidance_snapshot(),
                "sync": {
                    "status": "degraded",
                    "observation_state": "contract_invalid",
                    "projection_state": "last_known_good",
                },
            }
            with (
                patch.object(backend_main, "database", database),
                patch.object(
                    backend_main,
                    "snapshot_projection",
                    AsyncMock(return_value=projection),
                ),
            ):
                result = await backend_main.api_current_guidance()

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], "observation_contract_invalid")

    async def test_decision_records_snooze_without_changing_core_evidence(self) -> None:
        snapshot = guidance_snapshot()
        message = select_guidance(snapshot=snapshot, sync=CURRENT_SYNC)["message"]
        payload = backend_main.GuidanceDecisionInput(
            decision="snooze",
            expected_fingerprint=message["fingerprint"],
            snooze_hours=6,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "living.db")
            database.initialize()
            with (
                patch.object(backend_main, "database", database),
                patch.object(
                    backend_main,
                    "snapshot_projection",
                    AsyncMock(return_value={"snapshot": snapshot, "sync": CURRENT_SYNC}),
                ),
            ):
                result = await backend_main.api_guidance_decision(
                    message["id"], payload
                )
                current = await backend_main.api_current_guidance()

        self.assertEqual(result["status"], "recorded")
        self.assertEqual(result["decision"], "snooze")
        self.assertEqual(current["message"]["kind"], "question")
        self.assertEqual(snapshot["issues"][0]["detail"], "Hook runtime evidence is missing.")

    async def test_seed_answer_is_operator_evidence_awaiting_ai_review(self) -> None:
        snapshot = guidance_snapshot()
        question = next(
            message
            for message in build_guidance_messages(snapshot)
            if message["kind"] == "question"
        )
        payload = backend_main.GuidanceAnswerInput(
            answer="先說明原因，再讓我決定是否治療。",
            expected_fingerprint=question["fingerprint"],
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "living.db")
            database.initialize()
            with (
                patch.object(backend_main, "database", database),
                patch.object(
                    backend_main,
                    "snapshot_projection",
                    AsyncMock(return_value={"snapshot": snapshot, "sync": CURRENT_SYNC}),
                ),
            ):
                result = await backend_main.api_guidance_answer(question["id"], payload)
                repeated = await backend_main.api_guidance_answer(question["id"], payload)
                treatments = database.list_treatments()

        self.assertEqual(result["status"], "awaiting_ai_review")
        self.assertEqual(result["treatment"]["id"], repeated["treatment"]["id"])
        self.assertEqual(len(treatments), 1)
        dialogue = result["treatment"]["proposal"]["dialogue"]
        self.assertEqual(dialogue["operator_evidence"]["provenance"], "operator_explicit")
        self.assertIsNone(dialogue["ai_inferred_candidate"])
        self.assertEqual(dialogue["learning_status"], "not_yet_learned")
        self.assertEqual(
            result["provenance"]["distillation_status"], "awaiting_ai_review"
        )

    async def test_issue_answer_cannot_bypass_core_remediation(self) -> None:
        snapshot = guidance_snapshot()
        issue = select_guidance(snapshot=snapshot, sync=CURRENT_SYNC)["message"]
        payload = backend_main.GuidanceAnswerInput(
            answer="請直接修好",
            expected_fingerprint=issue["fingerprint"],
        )
        with patch.object(
            backend_main,
            "snapshot_projection",
            AsyncMock(return_value={"snapshot": snapshot, "sync": CURRENT_SYNC}),
        ):
            with self.assertRaises(HTTPException) as raised:
                await backend_main.api_guidance_answer(issue["id"], payload)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "guidance_not_answerable")

    def test_guidance_routes_are_registered(self) -> None:
        registered = {
            (route.path, method)
            for route in backend_main.app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        expected = {
            ("/api/guidance/current", "GET"),
            ("/api/guidance/{message_id}/decision", "POST"),
            ("/api/guidance/{message_id}/answer", "POST"),
        }
        self.assertTrue(expected.issubset(registered))


if __name__ == "__main__":
    unittest.main()
