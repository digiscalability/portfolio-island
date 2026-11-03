"""Shared fixtures: fresh generated fixtures, the run summary, and the live session.

Every test module carries a marker (``offline`` or ``live``). The offline run
writes its headline numbers to ``runs/offline/summary.json``, which
``python -m islandevals.report`` turns into the tables in RESULTS.md. A live
run writes ``runs/live-<UTC time>/`` (results, errors, calibration, summary).
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from islandevals import fixtures, suites
from islandevals.live import (
    DEFAULT_TOKEN_BUDGET,
    LiveClient,
    RunRecorder,
    TokenBudget,
    live_gate,
)
from islandevals.paths import RUNS_DIR


class Summary:
    """Headline numbers the suites record, keyed by suite then metric."""

    def __init__(self) -> None:
        self.data: dict[str, dict[str, Any]] = {}

    def record(self, suite: str, key: str, value: Any) -> None:
        self.data.setdefault(suite, {})[key] = value


@pytest.fixture(scope="session")
def summary(request: pytest.FixtureRequest):
    s = Summary()
    yield s
    if not s.data:
        return
    mark = request.config.getoption("-m") or "all"
    out = RUNS_DIR / ("offline" if mark == "offline" else "last")
    out.mkdir(parents=True, exist_ok=True)
    try:
        day_key = fixtures.load("meta").get("day_key")
    except fixtures.FixtureError:
        day_key = None
    doc = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "marker": mark,
        "fixtures_day_key": day_key,
        "suites": s.data,
    }
    (out / "summary.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


@pytest.fixture(scope="session")
def generated():
    """The dumped fixtures, refusing stale ones (see fixtures.DUMP_HINT)."""
    try:
        fixtures.require_fresh()
        return {name: fixtures.load(name) for name in ("personas", "planner", "surfaces", "meta")}
    except fixtures.FixtureError as e:
        pytest.fail(str(e), pytrace=False)


@pytest.fixture(scope="session")
def live_session(request: pytest.FixtureRequest):
    """One client, one hard token budget and one run directory for every live
    suite. Skips (before touching fixtures or the SDK) unless the run was asked
    for with -m live and ANTHROPIC_API_KEY is set."""
    ok, reason = live_gate(request.config.getoption("-m"))
    if not ok:
        pytest.skip(reason)
    gen = request.getfixturevalue("generated")
    budget = TokenBudget(int(os.environ.get("EVALS_TOKEN_BUDGET") or DEFAULT_TOKEN_BUDGET))
    recorder = RunRecorder()
    personas, planner = gen["personas"], gen["planner"]
    recorder.write_json("prompts.json", suites.prompts_record(personas, planner))
    session = SimpleNamespace(
        live=LiveClient(budget),
        budget=budget,
        recorder=recorder,
        personas=personas,
        planner=planner,
        reps=int(os.environ.get("EVALS_REPS") or 1),
        planner_reps=int(os.environ.get("EVALS_PLANNER_REPS") or 3),
    )
    yield session
    recorder.finish(budget)


@pytest.fixture(scope="session")
def calibration(live_session):
    result = suites.run_calibration(
        live_session.live, live_session.recorder, live_session.personas["about_abbas"]
    )
    live_session.recorder.summary["calibration"] = {k: result[k] for k in ("cases", "correct", "calibrated")}
    return result
