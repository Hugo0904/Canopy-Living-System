from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from backend.app import main as backend_main
from backend.app.remediation_adapter import (
    RemediationContractError,
    RemediationUnavailable,
)


class RemediationApiTest(unittest.IsolatedAsyncioTestCase):
    async def test_open_is_a_thin_core_call_and_never_creates_local_state(self) -> None:
        payload = backend_main.RemediationOpenInput(
            issue_id="doctor:codex-hooks",
            mode="embedded",
            model="gpt-5.6-sol",
            reasoning_effort="high",
        )
        projection = {"id": "RM-123", "stage": "case_open"}
        to_thread = AsyncMock(return_value=projection)
        public_snapshot = AsyncMock(return_value={
            "snapshot": {
                "issues": [{
                    "id": "doctor:codex-hooks",
                    "remediation": {"requestable": True},
                }]
            }
        })

        with (
            patch.object(backend_main.asyncio, "to_thread", to_thread),
            patch.object(backend_main, "snapshot_projection", public_snapshot),
            patch.object(backend_main.database, "create_treatment") as local_create,
        ):
            result = await backend_main.api_open_remediation(payload)

        self.assertEqual(result, projection)
        to_thread.assert_awaited_once_with(
            backend_main.remediation_adapter.open,
            "doctor:codex-hooks",
            origin="living_system",
            mode="embedded",
            model="gpt-5.6-sol",
            effort="high",
        )
        local_create.assert_not_called()

    async def test_open_allows_core_to_choose_default_model_and_effort(self) -> None:
        payload = backend_main.RemediationOpenInput(
            issue_id="review-pressure:due-cards",
            mode="handoff",
        )
        to_thread = AsyncMock(return_value={"id": "RM-DEFAULT"})
        public_snapshot = AsyncMock(return_value={
            "snapshot": {
                "issues": [{
                    "id": "review-pressure:due-cards",
                    "remediation": {"requestable": True},
                }]
            }
        })

        with (
            patch.object(backend_main.asyncio, "to_thread", to_thread),
            patch.object(backend_main, "snapshot_projection", public_snapshot),
        ):
            await backend_main.api_open_remediation(payload)

        to_thread.assert_awaited_once_with(
            backend_main.remediation_adapter.open,
            "review-pressure:due-cards",
            origin="living_system",
            mode="handoff",
            model="",
            effort="",
        )

    async def test_open_rejects_unlinked_or_read_only_issue_without_calling_core(self) -> None:
        payload = backend_main.RemediationOpenInput(
            issue_id="miss:routing.example",
            mode="embedded",
        )
        to_thread = AsyncMock()
        cases = [
            {"issues": []},
            {
                "issues": [{
                    "id": "miss:routing.example",
                    "remediation": {"requestable": False},
                }]
            },
        ]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot):
                with (
                    patch.object(backend_main.asyncio, "to_thread", to_thread),
                    patch.object(
                        backend_main,
                        "snapshot_projection",
                        AsyncMock(return_value={"snapshot": snapshot}),
                    ),
                ):
                    with self.assertRaises(HTTPException) as raised:
                        await backend_main.api_open_remediation(payload)
                self.assertIn(raised.exception.status_code, {404, 409})
        to_thread.assert_not_awaited()

    async def test_read_and_action_endpoints_delegate_to_the_same_adapter(self) -> None:
        projection = {"status": "PASS"}
        cases = [
            (
                backend_main.api_remediation_capabilities,
                (),
                backend_main.remediation_adapter.capabilities,
                (),
            ),
            (
                backend_main.api_remediations,
                (12,),
                backend_main.remediation_adapter.list,
                (12,),
            ),
            (
                backend_main.api_remediation_status,
                ("RM-123",),
                backend_main.remediation_adapter.status,
                ("RM-123",),
            ),
            (
                backend_main.api_diagnose_remediation,
                ("RM-123",),
                backend_main.remediation_adapter.diagnose,
                ("RM-123",),
            ),
            (
                backend_main.api_run_remediation,
                ("RM-123",),
                backend_main.remediation_adapter.run,
                ("RM-123",),
            ),
            (
                backend_main.api_remediation_handoff,
                ("RM-123",),
                backend_main.remediation_adapter.handoff,
                ("RM-123",),
            ),
        ]
        for endpoint, endpoint_args, method, method_args in cases:
            with self.subTest(endpoint=endpoint.__name__):
                to_thread = AsyncMock(return_value=projection)
                with patch.object(backend_main.asyncio, "to_thread", to_thread):
                    result = await endpoint(*endpoint_args)
                self.assertEqual(result, projection)
                to_thread.assert_awaited_once_with(method, *method_args)

    async def test_authorization_is_proposal_bound_and_operator_only(self) -> None:
        proposal_hash = "a" * 64
        payload = backend_main.RemediationAuthorizationInput(
            decision="operator_approved",
            proposal_hash=proposal_hash,
        )
        to_thread = AsyncMock(return_value={"stage": "experiment_ready"})

        with patch.object(backend_main.asyncio, "to_thread", to_thread):
            result = await backend_main.api_authorize_remediation("RM-123", payload)

        self.assertEqual(result["stage"], "experiment_ready")
        to_thread.assert_awaited_once_with(
            backend_main.remediation_adapter.authorize,
            "RM-123",
            "operator_approved",
            proposal_hash,
        )

        with self.assertRaises(ValidationError):
            backend_main.RemediationAuthorizationInput(
                decision="standing_policy_authorized",
                proposal_hash=proposal_hash,
            )

    async def test_adapter_failures_remain_typed_and_fail_only_the_api_call(self) -> None:
        cases = [
            (RemediationUnavailable("Core is unavailable"), 503),
            (RemediationContractError("Core contract is invalid"), 502),
        ]
        for error, expected_status in cases:
            with self.subTest(error=error.code):
                with patch.object(
                    backend_main.remediation_adapter,
                    "capabilities",
                    side_effect=error,
                ):
                    with self.assertRaises(HTTPException) as raised:
                        await backend_main.api_remediation_capabilities()
                self.assertEqual(raised.exception.status_code, expected_status)
                self.assertEqual(raised.exception.detail["code"], error.code)

    def test_ui_cannot_request_scheduled_mode_or_unsafe_argument_shapes(self) -> None:
        with self.assertRaises(ValidationError):
            backend_main.RemediationOpenInput(
                issue_id="doctor:codex-hooks",
                mode="scheduled",
            )
        with self.assertRaises(ValidationError):
            backend_main.RemediationOpenInput(
                issue_id="--json",
                mode="embedded",
            )

    def test_all_core_remediation_routes_are_registered(self) -> None:
        registered = {
            (route.path, method)
            for route in backend_main.app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        expected = {
            ("/api/remediations/capabilities", "GET"),
            ("/api/remediations", "POST"),
            ("/api/remediations", "GET"),
            ("/api/remediations/{remediation_id}", "GET"),
            ("/api/remediations/{remediation_id}/diagnose", "POST"),
            ("/api/remediations/{remediation_id}/authorize", "POST"),
            ("/api/remediations/{remediation_id}/run", "POST"),
            ("/api/remediations/{remediation_id}/handoff", "GET"),
        }
        self.assertTrue(expected.issubset(registered))


if __name__ == "__main__":
    unittest.main()
