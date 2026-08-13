from __future__ import annotations

"""Thin Living System adapter for Canopy's canonical remediation workflow.

The Living System uses the surface term "treatment", but it does not own a
second workflow.  Every method in this module delegates to ``canopy
remediation`` and returns only a bounded, sanitized public projection of the
Core response.
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


MAX_ERROR_CHARS = 360
MAX_PUBLIC_TEXT_CHARS = 16_000

_SECRET_KEY = re.compile(
    r"^(?:access[_-]?token|api[_-]?key|authorization[_-]?header|credential|password|secret|token)$",
    re.IGNORECASE,
)
_PRIVATE_CONTENT_KEY = re.compile(
    r"^(?:chain[_-]?of[_-]?thought|hidden[_-]?reasoning|raw[_-]?prompt|"
    r"raw[_-]?transcript|transcript)$",
    re.IGNORECASE,
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(token|password|secret|api[_-]?key|authorization|credential)"
    r"\s*[:=]\s*(?:bearer\s+)?[^\s,;]+"
)
_HIGH_RISK_SECRET = re.compile(
    r"(?i)(?:bearer\s+)[A-Za-z0-9._~+/=-]{8,}|"
    r"\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b"
)
_POSIX_PRIVATE_PATH = re.compile(
    r"(?<![\w:])/(?:Users|home|private|tmp|var|opt|Volumes)/[^\s,;\"']+"
)
_GENERIC_ABSOLUTE_PATH = re.compile(
    r"(?<![:/\w])/(?!/)(?:[^/\s,;\"']+/)+[^/\s,;\"']+"
)
_WINDOWS_PRIVATE_PATH = re.compile(
    r"(?i)(?<![\w])(?:[a-z]:\\)(?:[^\s,;\"']+\\)*[^\s,;\"']+"
)
_SAFE_ARGUMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$")


class RemediationAdapterError(RuntimeError):
    """Base class for bounded remediation adapter failures."""

    code = "remediation_error"

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


class RemediationUnavailable(RemediationAdapterError):
    """The optional Core remediation command is unavailable or did not run."""

    code = "remediation_unavailable"


class RemediationContractError(RemediationAdapterError):
    """Core returned data that is not a valid public JSON response."""

    code = "remediation_contract_error"


def _bounded_text(value: Any, *, limit: int = MAX_PUBLIC_TEXT_CHARS) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        return text[:limit] + "...[truncated]"
    return text


def _sanitize_text(value: Any, *, canopy_root: Path, limit: int) -> str:
    text = _bounded_text(value, limit=limit)
    root = str(canopy_root)
    if root:
        text = text.replace(root, "Canopy")
    text = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[redacted]", text)
    text = _HIGH_RISK_SECRET.sub("[redacted]", text)
    text = _POSIX_PRIVATE_PATH.sub("[local path]", text)
    text = _GENERIC_ABSOLUTE_PATH.sub("[local path]", text)
    text = _WINDOWS_PRIVATE_PATH.sub("[local path]", text)
    return text


def _sanitize_public(value: Any, *, canopy_root: Path) -> Any:
    """Remove private content if a provider accidentally includes it.

    Core owns the response schema.  This adapter intentionally does not
    reinterpret its workflow state; it only enforces the Living System's
    privacy boundary before returning the payload to the UI.
    """

    if isinstance(value, dict):
        projected: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            if _PRIVATE_CONTENT_KEY.match(key):
                continue
            if _SECRET_KEY.match(key):
                projected[key] = "[redacted]"
                continue
            projected[key] = _sanitize_public(item, canopy_root=canopy_root)
        return projected
    if isinstance(value, list):
        return [_sanitize_public(item, canopy_root=canopy_root) for item in value]
    if isinstance(value, str):
        return _sanitize_text(
            value,
            canopy_root=canopy_root,
            limit=MAX_PUBLIC_TEXT_CHARS,
        )
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _sanitize_text(
        value,
        canopy_root=canopy_root,
        limit=MAX_PUBLIC_TEXT_CHARS,
    )


def _argument(value: Any, *, field: str, max_chars: int = 200) -> str:
    if not isinstance(value, str):
        raise RemediationContractError(f"{field} must be text")
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > max_chars
        or not _SAFE_ARGUMENT.fullmatch(candidate)
    ):
        raise RemediationContractError(f"{field} is invalid")
    return candidate


class RemediationAdapter:
    """Delegate treatment entry points to the one Core-owned remediation SOP."""

    def __init__(self, settings: Any) -> None:
        canopy_root = getattr(settings, "canopy_root", None)
        if canopy_root is None:
            raise TypeError("settings.canopy_root is required")
        self.canopy_root = Path(canopy_root).expanduser().resolve()
        self.command_path = self.canopy_root / "canopy"

    def _run_json(
        self,
        subcommand: str,
        arguments: list[str] | None = None,
        *,
        timeout: int,
    ) -> dict[str, Any]:
        if not self.command_path.is_file():
            raise RemediationUnavailable("Canopy remediation is unavailable")

        argv = [
            sys.executable,
            str(self.command_path),
            "remediation",
            subcommand,
            *(arguments or []),
            "--json",
        ]
        try:
            result = subprocess.run(
                argv,
                cwd=self.canopy_root,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RemediationUnavailable(
                f"Canopy remediation timed out after {timeout}s"
            ) from exc
        except (OSError, RuntimeError) as exc:
            detail = getattr(exc, "strerror", "") or exc.__class__.__name__
            safe_detail = _sanitize_text(
                detail,
                canopy_root=self.canopy_root,
                limit=MAX_ERROR_CHARS,
            )
            raise RemediationUnavailable(
                f"Canopy remediation is unavailable: {safe_detail}"
            ) from exc

        if result.returncode:
            detail = (result.stderr or result.stdout or "").strip()
            safe_detail = _sanitize_text(
                detail or f"exit {result.returncode}",
                canopy_root=self.canopy_root,
                limit=MAX_ERROR_CHARS,
            )
            raise RemediationUnavailable(
                f"Canopy remediation command failed: {safe_detail}"
            )

        try:
            payload = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as exc:
            raise RemediationContractError(
                "Canopy remediation returned invalid JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise RemediationContractError(
                "Canopy remediation returned an invalid public contract"
            )
        return _sanitize_public(payload, canopy_root=self.canopy_root)

    def capabilities(self) -> dict[str, Any]:
        return self._run_json("capabilities", timeout=15)

    def open(
        self,
        issue_id: str,
        *,
        origin: str = "living_system",
        mode: str,
        model: str = "",
        effort: str = "",
    ) -> dict[str, Any]:
        arguments = [
            "--issue-id",
            _argument(issue_id, field="issue_id"),
            "--origin",
            _argument(origin, field="origin", max_chars=40),
            "--mode",
            _argument(mode, field="mode", max_chars=40),
        ]
        if model:
            arguments.extend(
                ["--model", _argument(model, field="model", max_chars=100)]
            )
        if effort:
            arguments.extend(
                [
                    "--reasoning-effort",
                    _argument(effort, field="effort", max_chars=40),
                ]
            )
        return self._run_json(
            "open",
            arguments,
            timeout=30,
        )

    def list(self, limit: int = 30) -> dict[str, Any]:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 100
        ):
            raise RemediationContractError("limit must be between 1 and 100")
        return self._run_json("list", ["--limit", str(limit)], timeout=15)

    def status(self, remediation_id: str) -> dict[str, Any]:
        return self._run_for_request("status", remediation_id, timeout=15)

    def diagnose(self, remediation_id: str) -> dict[str, Any]:
        return self._run_for_request("diagnose", remediation_id, timeout=240)

    def authorize(
        self,
        remediation_id: str,
        decision: str,
        proposal_hash: str,
    ) -> dict[str, Any]:
        return self._run_json(
            "authorize",
            [
                "--request-id",
                _argument(remediation_id, field="remediation_id"),
                "--decision",
                _argument(decision, field="decision", max_chars=40),
                "--proposal-hash",
                _argument(proposal_hash, field="proposal_hash", max_chars=128),
            ],
            timeout=30,
        )

    def run(self, remediation_id: str) -> dict[str, Any]:
        return self._run_for_request("run", remediation_id, timeout=900)

    def handoff(self, remediation_id: str) -> dict[str, Any]:
        return self._run_for_request("handoff", remediation_id, timeout=30)

    def _run_for_request(
        self,
        subcommand: str,
        remediation_id: str,
        *,
        timeout: int,
    ) -> dict[str, Any]:
        return self._run_json(
            subcommand,
            [
                "--request-id",
                _argument(remediation_id, field="remediation_id"),
            ],
            timeout=timeout,
        )
