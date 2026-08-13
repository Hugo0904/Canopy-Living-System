from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, call, patch

from backend.app import main as backend_main
from backend.app.canopy_adapter import CanopyAdapter, CanopySnapshotUnavailable
from backend.app.database import ObservatoryDatabase
from backend.app.proposals import build_treatment_proposal
from backend.app.snapshot_contract import SnapshotContractError, validate_normalized_snapshot
from backend.app.topology import TopologyContractError, validate_snapshot_topology


class PublicSnapshotAdapterTest(unittest.TestCase):
    def test_missing_canopy_is_explicitly_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(CanopySnapshotUnavailable, "public snapshot command"):
                CanopyAdapter(Path(temp_dir)).collect()

    def test_public_snapshot_is_passed_through_without_private_seed_parsing(self) -> None:
        payload = normalized_snapshot()
        payload["modules"][0]["id"] = "roles"
        payload["modules"][0]["metrics"] = {"recent_selections": 33}
        payload["modules"][1]["metrics"] = {
            "observed_preflights": 314,
            "average_context_chars": 2156.3,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "canopy").touch()
            adapter = CanopyAdapter(root)
            with patch.object(adapter, "_run_json", return_value=(payload, "")) as run_json:
                snapshot = adapter.collect()

        self.assertIs(snapshot, payload)
        self.assertEqual(snapshot["modules"][0]["metrics"]["recent_selections"], 33)
        self.assertEqual(snapshot["modules"][1]["metrics"]["average_context_chars"], 2156.3)
        run_json.assert_called_once_with(["observe", "snapshot", "--json"], timeout=120)
        self.assertFalse(hasattr(adapter, "_seed_health"))
        self.assertFalse(hasattr(adapter, "_read_cards"))

    def test_public_snapshot_failure_does_not_fall_back_to_parallel_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "canopy").touch()
            adapter = CanopyAdapter(root)
            with patch.object(adapter, "_run_json", return_value=({}, "required topology path is missing")) as run_json:
                with self.assertRaisesRegex(CanopySnapshotUnavailable, "required topology path"):
                    adapter.collect()

        run_json.assert_called_once_with(["observe", "snapshot", "--json"], timeout=120)


class EvolutionLabContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = CanopyAdapter(Path("/opt/canopy"))
        self.validation = {
            "status": "PASS",
            "contract_id": "canopy.directed_evolution",
            "contract_version": "3.4.0",
            "routing_case_count": 32,
            "contract_bundle_chars": 5158,
            "contract_runtime_target_chars": 7000,
            "finding_state_path": "/opt/canopy/state/evolution_findings.json",
            "warnings": [],
            "errors": [],
        }
        self.monitor = {
            "status": "PASS",
            "state_path": "/opt/canopy/state/evolution_findings.json",
            "state_updated": False,
            "summary": {
                "unchanged": 2,
                "regressed": 1,
                "new": 1,
                "active": 4,
                "stored": 7,
                "reportable": 2,
                "report_truncated": False,
            },
            "reportable": [
                {
                    "finding_id": "finding-0",
                    "event": "regressed",
                    "source_refs": ["/private/evolution/findings.jsonl"],
                }
            ],
            "findings": [
                {
                    "id": f"finding-{index}",
                    "status": "open",
                    "priority": "medium",
                    "category": "evidence_gap",
                    "owner": "canopy_core",
                    "scope": "seed-lifecycle",
                    "summary": f"Finding {index}",
                    "suggested_improvement": "Inspect the bounded public evidence.",
                    "evidence": [
                        "/opt/canopy/private.jsonl",
                        "token=should-not-leak",
                        "metric=1",
                        "metric=2",
                        "metric=3",
                        "metric=4",
                    ],
                    "source_refs": ["/opt/canopy/private.jsonl"],
                    "case": {
                        "case_id": f"EVO-{index}",
                        "hidden_reasoning": "must never be projected",
                    },
                }
                for index in range(6)
            ],
            "case_candidates": [
                {
                    "artifact_type": "EvolutionCase",
                    "case_id": "EVO-0",
                    "trigger_source": "manual",
                    "problem": "A bounded problem statement.",
                    "scope": "seed-lifecycle",
                    "evidence": [
                        "one",
                        "two",
                        "three",
                        "four",
                        "five",
                        "six",
                    ],
                    "constraints": ["Observation is not mutation authority."],
                    "current_state": "case_open",
                    "target_outcome": "Collect enough evidence for review.",
                    "raw_prompt": "must never be projected",
                }
            ],
        }

        self.observation = {
            "schema_version": 1,
            "contract_id": "canopy.observation.evolution",
            "status": "live",
            "read_only": {"on_demand": True, "state_updated": False, "confirmed": True},
            "contract": {"health": "healthy", "id": "canopy.directed_evolution", "version": "3.4.0", "routing_cases": 32, "runtime_chars": 5158, "runtime_target_chars": 7000, "warnings": [], "errors": []},
            "monitor": {"health": "healthy", "trigger_source": "manual", "summary": self.monitor["summary"]},
            "findings": self.monitor["findings"][:5],
            "findings_total": 6,
            "findings_omitted": 1,
            "findings_truncated": True,
            "case_candidates": self.monitor["case_candidates"],
            "case_candidates_truncated": False,
        }
        self.observation["findings"] = [
            {
                "id": f"finding:{index:012x}",
                "event": "new",
                "status": "open",
                "priority": "medium",
                "category": "evidence_gap" if index == 0 else "unknown-category",
                "owner": "canopy_core",
                "summary": "Core-owned public template",
                "evidence": [
                    "required_success_rate=0.98",
                    "required_closure_rate=0.875",
                    "required_resolution_rate=1.0",
                    "unclosed_required=12",
                    "interrupted_required=2",
                ],
                "evidence_truncated": index == 0,
                "evidence_omitted": 1 if index == 0 else 0,
                "suggested_improvement": "Core-owned public template",
                "disposition": "evolution_case",
                "case_id": f"case:{index:012x}",
            }
            for index in range(5)
        ]
        self.observation["case_candidates"] = [
            {
                "artifact_type": "EvolutionCase",
                "artifact_status": "candidate_only",
                "case_id": "case:000000000000",
                "trigger_source": "manual",
                "problem": "Core-owned public template",
                "scope": "unreported",
                "evidence": ["required_success_rate=0.98"],
                "constraints": ["Core-owned public template"],
                "reached_state": "unreported",
                "target_outcome": "Core-owned public template",
            }
        ]

    def test_public_commands_build_a_bounded_sanitized_read_only_projection(self) -> None:
        with patch.object(
            self.adapter,
            "_run_json",
            return_value=(self.observation, ""),
        ) as run_json:
            projection = self.adapter.collect_evolution_lab()

        self.assertEqual(
            run_json.call_args_list,
            [call(["observe", "evolution", "--json"], timeout=30)],
        )
        self.assertEqual(projection["status"], "live")
        self.assertTrue(projection["read_only"]["confirmed"])
        self.assertEqual(projection["contract"]["version"], "3.4.0")
        self.assertEqual(projection["contract"]["routing_cases"], 32)
        self.assertEqual(projection["contract"]["runtime_chars"], 5158)
        self.assertEqual(projection["monitor"]["summary"]["active"], 4)
        self.assertEqual(len(projection["findings"]), 5)
        self.assertTrue(projection["findings_truncated"])
        self.assertEqual(projection["findings_total"], 6)
        self.assertEqual(projection["findings_omitted"], 1)
        self.assertEqual(len(projection["findings"][0]["evidence"]), 5)
        self.assertTrue(projection["findings"][0]["evidence_truncated"])
        self.assertEqual(projection["case_candidates"][0]["artifact_status"], "candidate_only")
        self.assertEqual(
            projection["case_candidates"][0]["artifact_persistence"],
            "unreported",
        )
        self.assertEqual(projection["case_candidates"][0]["reached_state"], "unreported")
        self.assertEqual(projection["workflow_stages"][0]["status"], "candidate_only")
        self.assertTrue(
            all(
                stage["status"] == "unreported"
                for stage in projection["workflow_stages"][1:]
            )
        )
        self.assertEqual(
            [stage["id"] for stage in projection["workflow_stages"]],
            ["case", "proposal", "review", "experiment", "adoption", "monitoring"],
        )
        serialized = json.dumps(projection)
        self.assertNotIn("source_refs", serialized)
        self.assertNotIn("raw_prompt", serialized)
        self.assertNotIn("hidden_reasoning", serialized)
        self.assertNotIn("/opt/", serialized)
        self.assertNotIn("/private/", serialized)
        self.assertNotIn("should-not-leak", serialized)
        self.assertIn('"category": "unavailable"', serialized)

    def test_numeric_injection_is_rejected_by_category_and_value_bounds(self) -> None:
        observation = dict(self.observation)
        observation["findings"] = [
            {
                **self.observation["findings"][0],
                "category": "miss",
                "evidence": [
                    "closed_turns=4111111111111111",
                    "hits=12345678901234567890",
                ],
            },
            {
                **self.observation["findings"][0],
                "id": "finding:000000000001",
                "category": "evidence_gap",
                "evidence": [
                    "required_success_rate=0.98",
                    "unclosed_required=123456",
                    "closed_turns=12",
                ],
            },
        ]
        with patch.object(self.adapter, "_run_json", return_value=(observation, "")):
            projection = self.adapter.collect_evolution_lab()

        serialized = json.dumps(projection)
        self.assertEqual(projection["findings"][0]["evidence"], [])
        self.assertEqual(
            projection["findings"][1]["evidence"],
            ["required_success_rate=0.98"],
        )
        self.assertNotIn("4111111111111111", serialized)
        self.assertNotIn("12345678901234567890", serialized)
        self.assertNotIn("unclosed_required=123456", serialized)

    def test_cli_failures_return_an_unavailable_contract_instead_of_raising(self) -> None:
        with patch.object(
            self.adapter,
            "_run_json",
            return_value=({}, "observation failed at /opt/canopy"),
        ):
            projection = self.adapter.collect_evolution_lab()

        self.assertEqual(projection["status"], "unavailable")
        self.assertEqual(projection["source_mode"], "unavailable")
        self.assertFalse(projection["read_only"]["confirmed"])
        self.assertEqual(projection["findings"], [])
        self.assertEqual(projection["case_candidates"], [])
        self.assertTrue(
            all(stage["status"] == "unreported" for stage in projection["workflow_stages"])
        )
        self.assertNotIn("/opt/", json.dumps(projection))

    def test_command_timeout_is_contained_as_fail_open_evidence(self) -> None:
        with patch("backend.app.canopy_adapter.subprocess.run", side_effect=subprocess.TimeoutExpired("canopy", 1)):
            payload, error = self.adapter._run_json(
                ["evolution", "validate", "--json"],
                timeout=1,
            )

        self.assertEqual(payload, {})
        self.assertEqual(error, "Canopy command timed out after 1s")

    def test_reopening_the_laboratory_reuses_the_short_bounded_cache(self) -> None:
        with patch.object(
            self.adapter,
            "_run_json",
            return_value=(self.observation, ""),
        ) as run_json:
            first = self.adapter.collect_evolution_lab()
            second = self.adapter.collect_evolution_lab()

        self.assertIs(second, first)
        self.assertEqual(run_json.call_count, 1)


class EvolutionLabApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_api_collects_only_when_the_evolution_lab_endpoint_is_requested(self) -> None:
        route = next(
            route for route in backend_main.app.routes if route.path == "/api/evolution-lab"
        )
        self.assertIn("GET", route.methods)
        expected = {
            "contract_id": "canopy.living-system.evolution-lab",
            "status": "live",
        }
        with patch.object(
            backend_main.adapter,
            "collect_evolution_lab",
            return_value=expected,
        ) as collect:
            response = await backend_main.api_evolution_lab()

        self.assertEqual(response, expected)
        collect.assert_called_once_with()


class LocalApiBoundaryTest(unittest.TestCase):
    def test_api_origin_guard_allows_only_local_browser_origins(self) -> None:
        self.assertTrue(backend_main._local_origin_allowed(""))
        self.assertTrue(backend_main._local_origin_allowed("http://127.0.0.1:8765"))
        self.assertTrue(backend_main._local_origin_allowed("http://localhost:8765"))
        self.assertFalse(backend_main._local_origin_allowed("https://example.com"))
        self.assertFalse(backend_main._local_origin_allowed("null"))


def topology_snapshot(*, extra_module: bool = False) -> dict:
    modules = [
        {
            "id": "brain",
            "name": "Brain",
            "zone": "core",
            "summary": "Brain module",
            "health": {"status": "healthy"},
            "activity": {"status": "observed", "label": "observed"},
            "impact": {"status": "observed", "label": "observed"},
            "confidence": {"level": "high", "label": "high"},
            "metrics": {},
            "issue_ids": [],
        },
        {
            "id": "hooks",
            "name": "Hooks",
            "zone": "boundary",
            "summary": "Hook module",
            "health": {"status": "healthy"},
            "activity": {"status": "observed", "label": "observed"},
            "impact": {"status": "observed", "label": "observed"},
            "confidence": {"level": "high", "label": "high"},
            "metrics": {
                "observed_preflights": None,
                "average_context_chars": None,
            },
            "issue_ids": [],
        },
    ]
    nodes = [
        {"id": "root", "parent_id": "", "kind": "canopy", "module_id": "", "dependencies": []},
        {"id": "module:brain", "parent_id": "root", "kind": "organ", "module_id": "brain", "dependencies": []},
        {"id": "module:hooks", "parent_id": "root", "kind": "organ", "module_id": "hooks", "dependencies": []},
    ]
    edges = [
        {"source": "root", "target": "module:brain", "relation": "contains"},
        {"source": "root", "target": "module:hooks", "relation": "contains"},
    ]
    connections = [
        {
            "id": "brain_hooks",
            "source": "brain",
            "target": "hooks",
            "phase": "preflight",
            "signal": {"semantics": "architectural_flow_not_live_packet_trace"},
        }
    ]
    if extra_module:
        modules.append(
            {
                "id": "new-capability",
                "name": "New capability",
                "zone": "extension",
                "summary": "New module",
                "health": {"status": "healthy"},
                "activity": {"status": "observed", "label": "observed"},
                "impact": {"status": "observed", "label": "observed"},
                "confidence": {"level": "high", "label": "high"},
                "metrics": {},
                "issue_ids": [],
            }
        )
        nodes.append(
            {"id": "module:new-capability", "parent_id": "root", "kind": "organ", "module_id": "new-capability", "dependencies": []}
        )
        edges.append({"source": "root", "target": "module:new-capability", "relation": "contains"})
        connections.append(
            {
                "id": "hooks_new_capability",
                "source": "hooks",
                "target": "new-capability",
                "phase": "postflight",
                "signal": {"semantics": "architectural_flow_not_live_packet_trace"},
            }
        )
    return {
        "schema_version": 4,
        "generated_at": "2026-08-13T00:00:00+00:00",
        "source_mode": "canopy_public_contract",
        "overall": {"status": "healthy", "scores": {}, "summary": "verified"},
        "modules": modules,
        "topology": {
            "schema_version": 2,
            "contract_id": "canopy.observability_topology",
            "signal_semantics": "architectural_flow_not_live_packet_trace",
            "structure_contract_id": "canopy.public_structure",
        },
        "connections": connections,
        "structure": {"root_id": "root", "nodes": nodes, "edges": edges},
        "seed_memory": {"cards": [], "active_count": 0, "candidate_count": 0, "archived_count": 0},
        "roles": [],
        "resources": {},
        "issues": [],
        "capabilities": {"card_proposals": True, "direct_card_mutation": False},
    }


def normalized_snapshot() -> dict:
    return topology_snapshot()


def link_issue(snapshot: dict, issue: dict, *, module_id: str = "brain") -> None:
    issue["module_ids"] = [module_id]
    remediation = issue.setdefault("remediation", {})
    remediation.setdefault("requestable", False)
    snapshot["issues"].append(issue)
    module = next(item for item in snapshot["modules"] if item["id"] == module_id)
    module["issue_ids"].append(issue["id"])


class NormalizedSnapshotContractTest(unittest.TestCase):
    def test_module_issue_links_are_core_owned_and_bidirectionally_consistent(self) -> None:
        snapshot = normalized_snapshot()
        link_issue(snapshot, {
            "id": "miss:routing.example",
            "severity": "attention",
            "code": "seed_routing_miss",
            "title": "Routing miss",
            "detail": "A continuation left the required workflow.",
            "remediation": {"requestable": True},
        })

        validate_normalized_snapshot(snapshot)

        self.assertEqual(snapshot["modules"][0]["issue_ids"], ["miss:routing.example"])
        self.assertEqual(snapshot["issues"][0]["module_ids"], ["brain"])

    def test_module_issue_links_cannot_reference_unknown_or_one_sided_records(self) -> None:
        unknown = normalized_snapshot()
        link_issue(unknown, {
            "id": "miss:routing.example",
            "severity": "attention",
            "title": "Routing miss",
            "detail": "detail",
            "remediation": {"requestable": True},
        })
        unknown["issues"][0]["module_ids"] = ["not-a-module"]
        with self.assertRaisesRegex(SnapshotContractError, "unknown module"):
            validate_normalized_snapshot(unknown)

        one_sided = normalized_snapshot()
        link_issue(one_sided, {
            "id": "miss:routing.example",
            "severity": "attention",
            "title": "Routing miss",
            "detail": "detail",
            "remediation": {"requestable": True},
        })
        one_sided["modules"][0]["issue_ids"] = []
        with self.assertRaisesRegex(SnapshotContractError, "do not match"):
            validate_normalized_snapshot(one_sided)

    def test_nonzero_role_and_context_metrics_survive_the_normalized_contract(self) -> None:
        snapshot = normalized_snapshot()
        snapshot["modules"][1]["metrics"] = {
            "observed_preflights": 314,
            "average_context_chars": 2156.3,
        }
        snapshot["modules"].append(
            {
                "id": "roles",
                "name": "Roles",
                "zone": "capabilities",
                "summary": "Role module",
                "health": {"status": "healthy"},
                "activity": {"status": "observed", "label": "observed"},
                "impact": {"status": "observed", "label": "observed"},
                "confidence": {"level": "high", "label": "high"},
                "metrics": {"recent_selections": 33},
                "issue_ids": [],
            }
        )

        report = validate_normalized_snapshot(snapshot)

        self.assertEqual(report["status"], "valid")
        self.assertEqual(snapshot["modules"][2]["metrics"]["recent_selections"], 33)
        self.assertEqual(snapshot["modules"][1]["metrics"]["average_context_chars"], 2156.3)

    def test_null_metric_is_no_data_while_an_explicit_zero_stays_zero(self) -> None:
        snapshot = normalized_snapshot()
        snapshot["modules"][1]["metrics"] = {
            "observed_preflights": 0,
            "average_context_chars": None,
        }

        validate_normalized_snapshot(snapshot)

        self.assertEqual(snapshot["modules"][1]["metrics"]["observed_preflights"], 0)
        self.assertIsNone(snapshot["modules"][1]["metrics"]["average_context_chars"])

    def test_missing_required_observation_metric_is_a_contract_failure(self) -> None:
        snapshot = normalized_snapshot()
        snapshot["modules"][1]["metrics"].pop("average_context_chars")

        with self.assertRaisesRegex(SnapshotContractError, "missing required metric"):
            validate_normalized_snapshot(snapshot)

    def test_legacy_or_parallel_snapshot_is_rejected(self) -> None:
        snapshot = normalized_snapshot()
        snapshot["schema_version"] = 1
        snapshot["source_mode"] = "compatibility_adapter"

        with self.assertRaises(SnapshotContractError):
            validate_normalized_snapshot(snapshot)

    def test_core_issue_lifecycle_is_preserved_without_local_recalculation(self) -> None:
        snapshot = normalized_snapshot()
        link_issue(snapshot, {
                "id": "doctor:codex-hooks",
                "source": "canopy_doctor",
                "state": "awaiting_runtime_verification",
                "owner": "canopy_core",
                "severity": "attention",
                "code": "doctor_check_failed",
                "title": "Codex hooks need runtime verification",
                "detail": "Configuration passed; live tool evidence is still pending.",
                "requires_operator": False,
                "remediation": {
                    "mode": "auto_safe",
                    "state": "awaiting_runtime_verification",
                    "action_id": "repair_codex_hooks",
                    "automatic": True,
                    "requestable": True,
                    "verification": "canopy doctor --json",
                },
            }, module_id="hooks")

        validate_normalized_snapshot(snapshot)

        self.assertEqual(snapshot["issues"][0]["owner"], "canopy_core")
        self.assertEqual(
            snapshot["issues"][0]["remediation"]["state"],
            "awaiting_runtime_verification",
        )

    def test_invalid_issue_remediation_cannot_enter_the_projection(self) -> None:
        snapshot = normalized_snapshot()
        link_issue(snapshot, {
                "id": "invalid:remediation",
                "severity": "attention",
                "title": "invalid",
                "detail": "invalid",
                "remediation": {"automatic": "yes", "requestable": False},
            })

        with self.assertRaisesRegex(SnapshotContractError, "automatic must be boolean"):
            validate_normalized_snapshot(snapshot)

    def test_seed_operator_issue_keeps_core_owner_and_review_action(self) -> None:
        snapshot = normalized_snapshot()
        link_issue(snapshot, {
                "id": "LEARN-001",
                "state": "needs_operator",
                "owner": "seed_core",
                "severity": "attention",
                "code": "seed_operator_issue",
                "title": "A Seed learning item needs semantic review",
                "detail": "Compare the candidate with its source evidence.",
                "remediation": {
                    "mode": "operator_required",
                    "state": "needs_operator",
                    "action_id": "review_seed_operator_issue",
                    "automatic": False,
                    "requestable": True,
                    "next_action": "Review the source evidence before changing a card.",
                    "verification": "Re-run Seed health and reconcile the same finding.",
                },
            })

        validate_normalized_snapshot(snapshot)

        issue = snapshot["issues"][0]
        self.assertEqual(issue["owner"], "seed_core")
        self.assertFalse(issue["remediation"]["automatic"])
        self.assertEqual(issue["remediation"]["state"], "needs_operator")


class TopologyProjectionContractTest(unittest.TestCase):
    def test_new_module_and_connection_are_accepted_without_a_ui_catalog(self) -> None:
        report = validate_snapshot_topology(topology_snapshot(extra_module=True))

        self.assertEqual(report["status"], "valid")
        self.assertEqual(report["module_count"], 3)
        self.assertEqual(report["connection_count"], 2)
        self.assertEqual(len(report["fingerprint"]), 64)

    def test_unknown_connection_endpoint_is_rejected_before_projection(self) -> None:
        snapshot = topology_snapshot()
        snapshot["connections"][0]["target"] = "missing-module"

        with self.assertRaisesRegex(TopologyContractError, "unknown module"):
            validate_snapshot_topology(snapshot)

    def test_isolated_new_module_is_rejected_until_connections_are_declared(self) -> None:
        snapshot = topology_snapshot(extra_module=True)
        snapshot["connections"].pop()

        with self.assertRaisesRegex(TopologyContractError, "without a connection"):
            validate_snapshot_topology(snapshot)

    def test_structure_must_reach_the_declared_root(self) -> None:
        snapshot = topology_snapshot()
        snapshot["structure"]["nodes"][1]["parent_id"] = "module:hooks"

        with self.assertRaisesRegex(TopologyContractError, "parent does not match"):
            validate_snapshot_topology(snapshot)

    def test_legacy_compatibility_snapshot_is_explicitly_unavailable(self) -> None:
        report = validate_snapshot_topology({"modules": [{"id": "brain"}]})

        self.assertEqual(report["status"], "unavailable")
        self.assertEqual(report["fingerprint"], "")


class TopologySyncRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_existing_projection_refreshes_automatically_after_short_startup_delay(self) -> None:
        sync = AsyncMock(side_effect=asyncio.CancelledError())
        sleep = AsyncMock()
        with (
            patch.object(backend_main, "_latest_verified_snapshot", return_value=normalized_snapshot()),
            patch.object(backend_main, "sync_snapshot", sync),
            patch.object(backend_main.asyncio, "sleep", sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await backend_main.snapshot_sync_loop()

        sync.assert_awaited_once_with()
        sleep.assert_awaited_once_with(backend_main.STARTUP_SNAPSHOT_DELAY_SECONDS)

    async def test_background_snapshot_sync_retries_after_a_degraded_attempt(self) -> None:
        sync = AsyncMock(side_effect=[RuntimeError("temporary failure"), asyncio.CancelledError()])
        sleep = AsyncMock()
        with (
            patch.object(backend_main, "_latest_verified_snapshot", return_value=None),
            patch.object(backend_main, "sync_snapshot", sync),
            patch.object(backend_main.asyncio, "sleep", sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await backend_main.snapshot_sync_loop()

        self.assertEqual(sync.await_count, 2)
        sleep.assert_awaited_once_with(backend_main.settings.snapshot_sync_seconds)

    async def test_invalid_topology_never_reaches_snapshot_storage(self) -> None:
        invalid = topology_snapshot()
        invalid["connections"][0]["target"] = "missing-module"

        with (
            patch.object(backend_main.adapter, "collect", return_value=invalid),
            patch.object(backend_main.database, "latest_snapshot", return_value=None),
            patch.object(backend_main.database, "save_snapshot") as save,
        ):
            with self.assertRaisesRegex(TopologyContractError, "unknown module"):
                await backend_main.sync_snapshot()

        save.assert_not_called()
        self.assertEqual(backend_main.snapshot_sync_state["observation_state"], "contract_invalid")
        self.assertEqual(backend_main.snapshot_sync_state["projection_state"], "unavailable")

    async def test_unavailable_topology_keeps_the_last_verified_projection(self) -> None:
        verified = topology_snapshot()
        unavailable = normalized_snapshot()
        unavailable.pop("topology")
        unavailable.pop("connections")
        unavailable.pop("structure")

        with (
            patch.object(backend_main.adapter, "collect", return_value=unavailable),
            patch.object(backend_main.database, "latest_snapshot", return_value=verified),
            patch.object(backend_main.database, "save_snapshot") as save,
        ):
            result = await backend_main.snapshot_projection(refresh=True)

        save.assert_not_called()
        self.assertIs(result["snapshot"], verified)
        self.assertEqual(result["sync"]["observation_state"], "contract_invalid")
        self.assertEqual(result["sync"]["projection_state"], "last_known_good")
        self.assertTrue(result["sync"]["using_last_verified"])

    async def test_optional_topology_warning_is_saved_without_becoming_contract_failure(self) -> None:
        snapshot = normalized_snapshot()
        link_issue(snapshot, {
                "id": "optional:path-unavailable",
                "severity": "attention",
                "code": "optional_observation_path_unavailable",
                "title": "Optional observation unavailable",
                "detail": "A declared optional source is not installed.",
            }, module_id="hooks")

        with (
            patch.object(backend_main.adapter, "collect", return_value=snapshot),
            patch.object(backend_main.database, "save_snapshot", return_value=True) as save,
        ):
            result = await backend_main.sync_snapshot()

        self.assertIs(result, snapshot)
        save.assert_called_once_with(snapshot)
        self.assertEqual(backend_main.snapshot_sync_state["observation_state"], "observed")
        self.assertEqual(backend_main.snapshot_sync_state["projection_state"], "current")


class ProposalBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.snapshot = {
            "seed_memory": {
                "cards": [
                    {
                        "id": "pref.example",
                        "lifecycle": "active",
                        "source_type": "user_teaching",
                        "source_summary": "Operator teaching",
                    }
                ]
            }
        }

    def test_seed_change_is_a_proposal_not_a_direct_edit(self) -> None:
        request_type, proposal = build_treatment_proposal(
            snapshot=self.snapshot,
            target_type="seed_card",
            target_id="pref.example",
            intent="update",
            operator_prompt="請縮小這張卡片的召回範圍",
        )
        self.assertEqual(request_type, "SeedChangeProposal")
        self.assertFalse(proposal["direct_mutation_allowed"])
        self.assertEqual(proposal["before"]["source_type"], "user_teaching")
        self.assertIn("preserve_source_provenance", proposal["required_validation"])
        self.assertIsNone(proposal["proposed_after"])

    def test_receipt_cannot_be_edited(self) -> None:
        with self.assertRaisesRegex(ValueError, "only support diagnosis"):
            build_treatment_proposal(
                snapshot=self.snapshot,
                target_type="receipt",
                target_id="receipt-1",
                intent="update",
                operator_prompt="修改這筆 receipt",
            )

    def test_seed_card_can_be_requested_without_direct_creation(self) -> None:
        request_type, proposal = build_treatment_proposal(
            snapshot=self.snapshot,
            target_type="seed_card",
            target_id="new-seed-card",
            intent="create",
            operator_prompt="請分析這個習慣是否適合建立成 Seed 卡片",
        )
        self.assertEqual(request_type, "SeedChangeProposal")
        self.assertIsNone(proposal["before"])
        self.assertFalse(proposal["direct_mutation_allowed"])

    def test_module_treatment_cannot_create_parallel_local_request(self) -> None:
        with self.assertRaisesRegex(ValueError, "Core-issued remediation finding"):
            build_treatment_proposal(
                snapshot=self.snapshot,
                target_type="module",
                target_id="brain",
                intent="diagnose",
                operator_prompt="請確認這個生命單元最近的問題與改善方向",
            )


class DatabaseTest(unittest.TestCase):
    def test_snapshots_are_deduplicated_and_treatments_are_local(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "observatory.db")
            database.initialize()
            snapshot = {
                "generated_at": "2026-08-12T00:00:00+00:00",
                "overall": {"status": "healthy", "scores": {"structural": 91}},
            }
            self.assertTrue(database.save_snapshot(snapshot))
            self.assertEqual(database.latest_snapshot(), snapshot)
            refreshed_snapshot = {
                **snapshot,
                "generated_at": "2026-08-12T00:05:00+00:00",
            }
            self.assertFalse(database.save_snapshot(refreshed_snapshot))
            self.assertEqual(len(database.snapshot_history()), 1)
            self.assertEqual(database.latest_snapshot(), snapshot)

            treatment = database.create_treatment(
                request_type="SeedChangeProposal",
                target_type="seed_card",
                target_id="pref.example",
                intent="update",
                operator_prompt="請調整",
                proposal={"direct_mutation_allowed": False},
            )
            self.assertEqual(treatment["status"], "awaiting_ai_review")
            self.assertFalse(treatment["proposal"]["direct_mutation_allowed"])

    def test_local_history_prunes_old_rows_and_keeps_latest_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(
                Path(temp_dir) / "observatory.db",
                snapshot_retention_days=30,
                snapshot_max_records=3,
                treatment_retention_days=30,
                treatment_max_records=3,
            )
            database.initialize()
            old = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat(timespec="seconds")
            with database.connect() as connection:
                connection.execute(
                    "INSERT INTO snapshots(captured_at, payload_hash, overall_status, payload_json) VALUES(?, ?, ?, ?)",
                    (old, "old", "healthy", "{}"),
                )
                connection.execute(
                    "INSERT INTO treatment_requests VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("TR-OLD", "TreatmentRequest", "module", "brain", "diagnose", "old request", "awaiting_ai_review", "{}", old, old),
                )
            database.save_snapshot({"generated_at": database._now(), "overall": {"status": "healthy"}})
            database.create_treatment(
                request_type="TreatmentRequest",
                target_type="module",
                target_id="brain",
                intent="diagnose",
                operator_prompt="new request",
                proposal={},
            )
            self.assertEqual(len(database.snapshot_history()), 1)
            self.assertIsNone(database.get_treatment("TR-OLD"))

    def test_only_latest_snapshot_keeps_the_full_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "observatory.db")
            database.initialize()
            first = {
                "schema_version": 3,
                "generated_at": "2026-08-12T00:00:00+00:00",
                "source_mode": "canopy_public_contract",
                "overall": {"status": "healthy", "scores": {"structural": 91}},
                "structure": {"nodes": [{"id": "large-rebuildable-topology"}] * 50},
                "activity": {"events": [{"id": "large-rebuildable-activity"}] * 50},
            }
            second = {
                **first,
                "generated_at": "2026-08-12T00:05:00+00:00",
                "overall": {"status": "attention", "scores": {"structural": 88}},
            }

            database.save_snapshot(first)
            database.save_snapshot(second)

            with database.connect() as connection:
                rows = connection.execute(
                    "SELECT payload_json FROM snapshots ORDER BY id"
                ).fetchall()
            historical = json.loads(rows[0]["payload_json"])
            latest = json.loads(rows[1]["payload_json"])
            self.assertTrue(historical["history_summary"])
            self.assertNotIn("structure", historical)
            self.assertNotIn("activity", historical)
            self.assertEqual(historical["overall"]["scores"]["structural"], 91)
            self.assertIn("structure", latest)
            self.assertEqual(database.latest_snapshot(), second)

    def test_life_events_import_automatically_and_upsert_by_event_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(
                Path(temp_dir) / "observatory.db",
                life_event_retention_days=60,
                life_event_max_records=3,
            )
            database.initialize()
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            running = {
                "id": "activity:tool:one",
                "occurred_at": now,
                "correlation_id": "turn:one",
                "module_id": "hooks",
                "phase": "running",
                "status": "in_progress",
                "growth_stage": "",
                "summary": "正在執行專案操作",
                "facts": {"model": "gpt-test"},
                "assistance": "AI 正在執行有邊界的專案操作。",
                "request_effect": "沒有增加新的任務範圍。",
                "verification": "等待工具完成事件。",
            }
            completed = {
                **running,
                "status": "completed",
                "summary": "已完成專案操作",
                "verification": "工具已回報完成。",
            }

            first = database.import_life_events({"events": [running]})
            unchanged = database.import_life_events({"events": [running]})
            second = database.import_life_events({"events": [completed]})
            events = database.list_life_events()

            self.assertEqual(first["persisted"], 1)
            self.assertEqual(first["changed"], 1)
            self.assertEqual(unchanged["changed"], 0)
            self.assertEqual(second["persisted"], 1)
            self.assertEqual(second["changed"], 1)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["status"], "completed")
            self.assertEqual(events[0]["facts"]["model"], "gpt-test")
            self.assertEqual(events[0]["verification"], "工具已回報完成。")
            self.assertEqual(database.life_event_stats()["total"], 1)
            self.assertTrue(database.life_event_stats()["revision"])
            self.assertEqual(database.life_event_cursor(), now)

    def test_life_event_v3_rebuild_removes_older_vague_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(Path(temp_dir) / "observatory.db")
            database.initialize()
            database.import_life_events(
                {
                    "events": [
                        {
                            "id": "activity:old-vague-event",
                            "occurred_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "module_id": "hooks",
                            "summary": "AI 已完成協助。",
                        }
                    ]
                }
            )
            with database.connect() as connection:
                connection.execute("DELETE FROM schema_migrations WHERE version = 3")

            database.initialize()

            self.assertEqual(database.list_life_events(), [])
            with database.connect() as connection:
                migrated = connection.execute(
                    "SELECT 1 FROM schema_migrations WHERE version = 3"
                ).fetchone()
            self.assertIsNotNone(migrated)

    def test_life_events_prune_expired_rows_without_touching_other_tables(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = ObservatoryDatabase(
                Path(temp_dir) / "observatory.db",
                life_event_retention_days=30,
                life_event_max_records=3,
            )
            database.initialize()
            old = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat(
                timespec="seconds"
            )
            recent = datetime.now(timezone.utc).isoformat(timespec="seconds")
            database.import_life_events(
                {
                    "events": [
                        {
                            "id": "activity:old",
                            "occurred_at": old,
                            "correlation_id": "turn:old",
                            "module_id": "hooks",
                            "phase": "completed",
                            "status": "completed",
                        },
                        {
                            "id": "activity:recent",
                            "occurred_at": recent,
                            "correlation_id": "turn:recent",
                            "module_id": "hooks",
                            "phase": "completed",
                            "status": "completed",
                        },
                    ]
                }
            )
            self.assertEqual(
                [event["id"] for event in database.list_life_events()],
                ["activity:recent"],
            )


if __name__ == "__main__":
    unittest.main()
