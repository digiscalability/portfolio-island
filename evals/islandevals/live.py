"""Live-suite plumbing: one Anthropic client behind a hard token budget, the
exact npcChat request, and run records.

Nothing here runs unless a live suite asks for it, and the ``anthropic`` package
(the ``live`` dependency group) is imported only when a real client is built,
so the offline suites and the harness tests need neither the SDK nor a key.

Fidelity to production: npcChat sends ``model`` = NPC_MODEL, ``max_tokens`` =
NPC_MAX_TOKENS, ``system`` = the persona prompt plus dayContext, and the
visitor's clamped message as the only user turn, with no sampling parameters.
``npc_request`` builds exactly that from the dumped fixtures. This SDK sends API
version 2026-10-21 and npcChat's TypeScript SDK sends 2023-06-01; for this
request shape (no sampling parameters, no documents, no citations) the two
behave the same.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .paths import RUNS_DIR

DEFAULT_TOKEN_BUDGET = 300_000

# USD per million tokens (input, output): Anthropic first-party rates, as
# listed on 2026-10-06. Used only to report an estimated cost per run.
PRICES_PER_MTOK = {"claude-haiku-4-5": (1.00, 5.00)}


class BudgetExhausted(RuntimeError):
    """A call was refused because it could push the run past its token budget."""


class ModelMismatch(RuntimeError):
    """The API served a different model from the one requested."""


def live_gate(marker_expr: str, env: dict[str, str] | None = None) -> tuple[bool, str]:
    """(run?, reason). Live suites run only when the marker expression asks for
    them AND a key is set, so a bare ``pytest`` on a machine that happens to
    hold a key never spends."""
    env = os.environ if env is None else env
    expr = marker_expr or ""
    if "live" not in expr or "not live" in expr:
        return False, "live suites run only with -m live (the evals-live workflow)"
    if not env.get("ANTHROPIC_API_KEY"):
        return False, "ANTHROPIC_API_KEY is not set, so the live suites are skipped"
    return True, ""


def estimate_input_tokens(system: str, user: str) -> int:
    """A deliberate over-estimate (UTF-8 bytes / 3, plus framing), used only to
    refuse a call before it is sent; spend is then booked from ``usage``."""
    return (len(system.encode("utf-8")) + len(user.encode("utf-8"))) // 3 + 32


@dataclass
class TokenBudget:
    """A hard cap on input + output tokens for a whole run. A call starts only
    if its worst case (estimated input + max_tokens) still fits."""

    limit: int
    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    refused: int = 0
    by_purpose: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def spent(self) -> int:
        return self.input_tokens + self.output_tokens

    def reserve(self, est_input: int, max_tokens: int) -> None:
        if self.spent + est_input + max_tokens > self.limit:
            self.refused += 1
            raise BudgetExhausted(
                f"token budget {self.limit:,} would be exceeded "
                f"(spent {self.spent:,}, next call up to {est_input + max_tokens:,})"
            )

    def book(self, purpose: str, model: str, input_tokens: int, output_tokens: int) -> None:
        self.calls += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        p = self.by_purpose.setdefault(
            purpose, {"model": model, "calls": 0, "input_tokens": 0, "output_tokens": 0}
        )
        p["calls"] += 1
        p["input_tokens"] += input_tokens
        p["output_tokens"] += output_tokens

    def report(self) -> dict[str, Any]:
        """Spend so far, with an estimated cost per purpose from recorded usage."""
        by_purpose = {}
        total = 0.0
        for purpose, use in self.by_purpose.items():
            c = cost_usd(use["model"], use["input_tokens"], use["output_tokens"])
            by_purpose[purpose] = {**use, "est_cost_usd": c}
            total += c or 0.0
        return {
            "limit": self.limit,
            "spent": self.spent,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "calls": self.calls,
            "refused_calls": self.refused,
            "by_purpose": by_purpose,
            "est_cost_usd": round(total, 4),
        }


def price_for(model: str) -> tuple[float, float] | None:
    return next((p for prefix, p in PRICES_PER_MTOK.items() if model.startswith(prefix)), None)


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float | None:
    p = price_for(model)
    if p is None:
        return None
    return round((input_tokens * p[0] + output_tokens * p[1]) / 1_000_000, 4)


def model_matches(requested: str, served: str) -> bool:
    """A dated snapshot satisfies its alias (claude-haiku-4-5 -> ...-20251001)."""
    return served == requested or served.startswith(requested + "-")


@dataclass
class CallResult:
    text: str
    stop_reason: str | None
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float


class LiveClient:
    """Messages API calls under a TokenBudget. ``client`` may be any object with
    ``messages.create(**kwargs)`` (the harness tests pass a fake)."""

    def __init__(self, budget: TokenBudget, client: Any | None = None, *, timeout: float = 30.0):
        if client is None:
            import anthropic  # the `live` dependency group

            client = anthropic.Anthropic(max_retries=2, timeout=timeout)
        self._client = client
        self.budget = budget

    def call(
        self,
        *,
        purpose: str,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        output_schema: dict[str, Any] | None = None,
    ) -> CallResult:
        self.budget.reserve(estimate_input_tokens(system, user), max_tokens)
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if output_schema is not None:
            kwargs["output_config"] = {"format": {"type": "json_schema", "schema": output_schema}}
        started = time.monotonic()
        resp = self._client.messages.create(**kwargs)
        latency = time.monotonic() - started
        usage = resp.usage
        self.budget.book(purpose, model, int(usage.input_tokens or 0), int(usage.output_tokens or 0))
        if not model_matches(model, resp.model):
            raise ModelMismatch(f"asked for {model}, served by {resp.model}")
        # npcChat publishes the first text block, trimmed.
        first = next((b for b in resp.content if getattr(b, "type", None) == "text"), None)
        text = first.text.strip() if first is not None else ""
        return CallResult(
            text=text,
            stop_reason=resp.stop_reason,
            model=resp.model,
            input_tokens=int(usage.input_tokens or 0),
            output_tokens=int(usage.output_tokens or 0),
            latency_s=round(latency, 3),
        )


# --- The npcChat request ------------------------------------------------------------


def clamp_message(text: str, max_chars: int) -> str:
    """npcChat's input clamp (index.ts): collapse whitespace, trim, cut."""
    return re.sub(r"\s+", " ", text).strip()[:max_chars]


def npc_system(personas: dict[str, Any], persona_id: str) -> str:
    """The persona prompt variant production uses, plus the day context."""
    variant = "audio_tags_on" if personas["audio_tags_in_production"] else "audio_tags_off"
    return (
        personas["personas"][variant][persona_id]["system"]
        + personas["day_context"]["by_persona"][persona_id]
    )


def npc_request(personas: dict[str, Any], persona_id: str, message: str) -> dict[str, Any]:
    chat = personas["chat"]
    return {
        "model": chat["model"],
        "max_tokens": chat["max_tokens"],
        "system": npc_system(personas, persona_id),
        "user": clamp_message(message, chat["msg_max_chars"]),
    }


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- Run records ----------------------------------------------------------------------


class RunRecorder:
    """results.jsonl (rows that produced a scorable reply), errors.jsonl
    (infra failures and budget refusals, never scored as model failures), and
    summary.json, under runs/live-<UTC time>/."""

    def __init__(self, root: Path | None = None):
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        self.dir = (root or RUNS_DIR) / f"live-{stamp}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.summary: dict[str, Any] = {"started_at": stamp, "suites": {}}

    def _append(self, name: str, row: dict[str, Any]) -> None:
        with (self.dir / name).open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def result(self, row: dict[str, Any]) -> None:
        self._append("results.jsonl", row)

    def error(self, row: dict[str, Any]) -> None:
        self._append("errors.jsonl", row)

    def write_json(self, name: str, data: Any) -> None:
        (self.dir / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def finish(self, budget: TokenBudget) -> None:
        self.summary["budget"] = budget.report()
        self.write_json("summary.json", self.summary)


def as_row(result: CallResult) -> dict[str, Any]:
    return asdict(result)
