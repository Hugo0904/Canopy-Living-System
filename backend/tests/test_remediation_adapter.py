from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.app.remediation_adapter import (
    RemediationAdapter,
    RemediationContractError,
    RemediationUnavailable,
)


def completed(
    payload: object = None,
    *,
    returncode: int = 0,
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    stdout = json.dumps({"status": "ok"} if payload is None else payload)
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)


class RemediationAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()
        (self.root / "canopy").touch()
        self.adapter = RemediationAdapter(SimpleNamespace(canopy_root=self.root))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def assert_run(
        self,
        mocked_run: object,
        *arguments: str,
        timeout: int,
    ) -> None:
        mocked_run.assert_called_once_with(  # type: ignore[attr-defined]
            [
                sys.executable,
                str(self.root / "canopy"),
                "remediation",
                *arguments,
                "--json",
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_open_delegates_exact_typed_request_without_shell(
        self, mocked_run: object
    ) -> None:
        mocked_run.return_value = completed(  # type: ignore[attr-defined]
            {"request_id": "remediation:123", "state": "case_open"}
        )

        payload = self.adapter.open(
            "review-pressure:due-cards",
            mode="embedded",
            model="gpt-5.6-sol",
            effort="high",
        )

        self.assertEqual(payload["request_id"], "remediation:123")
        self.assert_run(
            mocked_run,
            "open",
            "--issue-id",
            "review-pressure:due-cards",
            "--origin",
            "living_system",
            "--mode",
            "embedded",
            "--model",
            "gpt-5.6-sol",
            "--reasoning-effort",
            "high",
            timeout=30,
        )

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_read_and_action_methods_are_only_core_cli_entry_points(
        self, mocked_run: object
    ) -> None:
        cases = [
            ("capabilities", (), ("capabilities",), 15),
            ("list", (), ("list", "--limit", "30"), 15),
            ("status", ("remediation:abc",), ("status", "--request-id", "remediation:abc"), 15),
            ("diagnose", ("remediation:abc",), ("diagnose", "--request-id", "remediation:abc"), 240),
            ("run", ("remediation:abc",), ("run", "--request-id", "remediation:abc"), 900),
            ("handoff", ("remediation:abc",), ("handoff", "--request-id", "remediation:abc"), 30),
        ]
        for method_name, method_args, command_args, timeout in cases:
            with self.subTest(method=method_name):
                mocked_run.reset_mock()  # type: ignore[attr-defined]
                mocked_run.return_value = completed()  # type: ignore[attr-defined]
                getattr(self.adapter, method_name)(*method_args)
                self.assert_run(mocked_run, *command_args, timeout=timeout)

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_authorize_forwards_decision_and_exact_proposal_hash(
        self, mocked_run: object
    ) -> None:
        mocked_run.return_value = completed()  # type: ignore[attr-defined]
        proposal_hash = "a" * 64

        self.adapter.authorize(
            "remediation:abc", "operator_approved", proposal_hash
        )

        self.assert_run(
            mocked_run,
            "authorize",
            "--request-id",
            "remediation:abc",
            "--decision",
            "operator_approved",
            "--proposal-hash",
            proposal_hash,
            timeout=30,
        )

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_open_omits_unspecified_provider_preferences(
        self, mocked_run: object
    ) -> None:
        mocked_run.return_value = completed()  # type: ignore[attr-defined]

        self.adapter.open("doctor:codex-hooks", mode="handoff")

        self.assert_run(
            mocked_run,
            "open",
            "--issue-id",
            "doctor:codex-hooks",
            "--origin",
            "living_system",
            "--mode",
            "handoff",
            timeout=30,
        )

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_list_limit_is_bounded_before_subprocess(
        self, mocked_run: object
    ) -> None:
        for limit in (0, 101, True, "30"):
            with self.subTest(limit=limit):
                with self.assertRaises(RemediationContractError):
                    self.adapter.list(limit)  # type: ignore[arg-type]
        mocked_run.assert_not_called()  # type: ignore[attr-defined]

    def test_missing_core_command_fails_only_when_adapter_is_called(self) -> None:
        with tempfile.TemporaryDirectory() as empty_dir:
            adapter = RemediationAdapter(
                SimpleNamespace(canopy_root=Path(empty_dir))
            )
            with self.assertRaises(RemediationUnavailable) as raised:
                adapter.capabilities()

        self.assertEqual(raised.exception.code, "remediation_unavailable")
        self.assertNotIn(empty_dir, str(raised.exception))

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_timeout_is_a_typed_unavailable_error_without_command_details(
        self, mocked_run: object
    ) -> None:
        mocked_run.side_effect = subprocess.TimeoutExpired(  # type: ignore[attr-defined]
            cmd=[str(self.root / "canopy"), "secret-token"],
            timeout=15,
        )

        with self.assertRaises(RemediationUnavailable) as raised:
            self.adapter.capabilities()

        self.assertEqual(raised.exception.code, "remediation_unavailable")
        self.assertNotIn(str(self.root), str(raised.exception))
        self.assertNotIn("secret-token", str(raised.exception))

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_nonzero_error_is_bounded_and_redacts_paths_and_secrets(
        self, mocked_run: object
    ) -> None:
        mocked_run.return_value = subprocess.CompletedProcess(  # type: ignore[attr-defined]
            [],
            1,
            stdout="",
            stderr=(
                f"failed at {self.root}/state/private.json "
                "token=top-secret password=hunter2"
            ),
        )

        with self.assertRaises(RemediationUnavailable) as raised:
            self.adapter.status("remediation:abc")

        message = str(raised.exception)
        self.assertNotIn(str(self.root), message)
        self.assertNotIn("top-secret", message)
        self.assertNotIn("hunter2", message)
        self.assertIn("token=[redacted]", message)

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_invalid_json_and_non_object_are_typed_contract_errors(
        self, mocked_run: object
    ) -> None:
        for stdout in ("not json", "[]"):
            with self.subTest(stdout=stdout):
                mocked_run.return_value = subprocess.CompletedProcess(  # type: ignore[attr-defined]
                    [], 0, stdout=stdout, stderr=""
                )
                with self.assertRaises(RemediationContractError) as raised:
                    self.adapter.list()
                self.assertEqual(
                    raised.exception.code, "remediation_contract_error"
                )

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_public_payload_drops_private_content_and_redacts_secret_fields(
        self, mocked_run: object
    ) -> None:
        mocked_run.return_value = completed(  # type: ignore[attr-defined]
            {
                "request_id": "remediation:abc",
                "hidden_reasoning": "private chain",
                "raw_transcript": "private transcript",
                "prompt": "Bounded public handoff instructions",
                "authorization": {"decision": "approved"},
                "token": "secret-value",
                "evidence": [
                    f"validated {self.root}/state/evidence.json",
                    "authorization=Bearer-secret",
                ],
            }
        )

        payload = self.adapter.status("remediation:abc")

        self.assertNotIn("hidden_reasoning", payload)
        self.assertNotIn("raw_transcript", payload)
        self.assertEqual(payload["prompt"], "Bounded public handoff instructions")
        self.assertEqual(payload["authorization"]["decision"], "approved")
        self.assertEqual(payload["token"], "[redacted]")
        serialized = json.dumps(payload)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("secret-value", serialized)
        self.assertNotIn("Bearer-secret", serialized)

    @patch("backend.app.remediation_adapter.subprocess.run")
    def test_option_injection_is_rejected_before_subprocess(
        self, mocked_run: object
    ) -> None:
        with self.assertRaises(RemediationContractError):
            self.adapter.open(
                "--json",
                mode="embedded",
                model="gpt-5.6-sol",
                effort="high",
            )
        mocked_run.assert_not_called()  # type: ignore[attr-defined]


if __name__ == "__main__":
    unittest.main()
