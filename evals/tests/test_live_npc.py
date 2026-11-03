"""Live: villagers under injection and role-break attempts, and what they say
about Abbas. Calls the Anthropic API with the exact npcChat request (see
islandevals/live.py) under a hard token budget, and grades with deterministic
checks first and a calibrated Claude Haiku 4.5 judge second.

Runs only from the evals-live workflow (workflow_dispatch) with
ANTHROPIC_API_KEY set; skips cleanly otherwise.
"""

from __future__ import annotations

import pytest

from islandevals import suites

pytestmark = pytest.mark.live


def _complete(s: dict) -> None:
    assert s["completed"] == s["planned"], (
        f"only {s['completed']} of {s['planned']} cases ran (budget or API errors: see errors.jsonl)"
    )


def test_the_judge_is_calibrated(calibration):
    wrong = [cid for cid, r in calibration["results"].items() if not r["ok"]]
    assert calibration["calibrated"], f"the judge misgraded calibration cases: {wrong}"


def test_injection_and_role_break(live_session, calibration):
    s = suites.run_injection(
        live_session.live, live_session.recorder, live_session.personas, reps=live_session.reps
    )
    live_session.recorder.summary["suites"]["injection"] = s
    _complete(s)
    assert not s["hard_failures"], (
        f"zero-tolerance findings {s['hard_failures']} in {s['rows_with_hard_failures']}"
    )
    assert calibration["calibrated"], "the judge failed calibration, so its pass rate is not trusted"
    assert s["judge_missing"] == 0, "some published replies were not judged (see errors.jsonl)"
    assert (s["judge_pass"]["rate"] or 0.0) >= suites.JUDGE_PASS_MIN, (
        f"judge pass rate {s['judge_pass']} is below {suites.JUDGE_PASS_MIN}; failed: {s['judge_failed']}"
    )


def test_facts_about_abbas(live_session, calibration):
    s = suites.run_facts(
        live_session.live, live_session.recorder, live_session.personas, reps=live_session.reps
    )
    live_session.recorder.summary["suites"]["facts"] = s
    _complete(s)
    assert not s["hard_failures"], (
        f"zero-tolerance findings {s['hard_failures']} in {s['rows_with_hard_failures']}"
    )
    assert (s["required_facts_met"]["rate"] or 0.0) >= suites.FACTS_REQUIRED_MIN, (
        f"required facts present in {s['required_facts_met']}, below {suites.FACTS_REQUIRED_MIN}"
    )
    assert calibration["calibrated"], "the judge failed calibration, so its pass rate is not trusted"
    assert s["judge_missing"] == 0, "some published replies were not judged (see errors.jsonl)"
    assert (s["judge_pass"]["rate"] or 0.0) >= suites.JUDGE_PASS_MIN, (
        f"judge pass rate {s['judge_pass']} is below {suites.JUDGE_PASS_MIN}; failed: {s['judge_failed']}"
    )
