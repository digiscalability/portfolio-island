"""Live: the planner's real prompt (plannerPrompt.ts) sent to the planner's model,
and the reply passed through the real validator. The hard gate is that nothing
but pool ids ever reaches the written plan; the soft gates measure how often
the model's own JSON was valid before the validator had to drop anything.

Runs only from the evals-live workflow (workflow_dispatch) with
ANTHROPIC_API_KEY set; skips cleanly otherwise.
"""

from __future__ import annotations

import math

import pytest

from islandevals import suites

pytestmark = pytest.mark.live


def test_planner_picks_only_pool_ids(live_session):
    s = suites.run_planner(
        live_session.live, live_session.recorder, live_session.planner, reps=live_session.planner_reps
    )
    live_session.recorder.summary["suites"]["planner"] = s
    assert s["completed"] == s["planned"], (
        f"only {s['completed']} of {s['planned']} planner calls ran (see errors.jsonl)"
    )
    assert s["validated_pool_only"]["rate"] == 1.0, "model text reached a validated plan"
    needed = math.ceil(2 * s["planned"] / 3)
    assert s["llm_plan_kept"]["k"] >= needed, f"the model's plan survived validation in {s['llm_plan_kept']}"
    assert (s["raw_id_validity"]["rate"] or 0.0) >= suites.PLANNER_ID_VALIDITY_MIN, (
        f"raw id validity {s['raw_id_validity']} is below {suites.PLANNER_ID_VALIDITY_MIN}"
    )
