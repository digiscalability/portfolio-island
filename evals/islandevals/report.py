"""Render RESULTS.md from the run summaries, so the published numbers are the
measured ones, never retyped.

    cd evals
    uv run pytest -m offline                         # writes runs/offline/summary.json
    uv run python -m islandevals.report > RESULTS.md
    uv run python -m islandevals.report --live runs/live-<UTC time>/summary.json > RESULTS.md
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .paths import REPO_ROOT, RUNS_DIR


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def _rate(r: dict[str, Any]) -> str:
    if not r or not r.get("n"):
        return "n/a"
    lo, hi = r["ci95"]
    return f"{r['k']}/{r['n']} ({_pct(r['rate'])}, 95% CI {_pct(lo)} to {_pct(hi)})"


def _source() -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
        ).stdout.strip()

    head = git("rev-parse", "--short", "HEAD") or "unknown"
    paths = ("functions", "evals", "index.html", "public", "SimpleUI.ts", "Share.ts", "api", "NpcChat.ts")
    dirty = bool(git("status", "--porcelain", "--", *paths))
    return f"commit {head}" + (" plus uncommitted changes" if dirty else "")


def offline_section(doc: dict[str, Any]) -> list[str]:
    s = doc["suites"]
    mod = s["moderation"]["summary"]
    gi, go = mod["gates"]["input"], mod["gates"]["output"]
    out = [
        "## Offline suites",
        "",
        f"Measured {doc['generated_at'][:10]} on {_source()}, with `uv run pytest -m offline` "
        "(no network, no API key). CI runs the same suites on every push and pull request.",
        "",
        "### Moderation (functions/src/moderation.ts)",
        "",
        f"{mod['cases']} labelled cases through the real `containsSlur` (input gate) and `scrubReply` "
        "(output gate). Positive = should be blocked.",
        "",
        "| Gate | Blocked when it should (recall) | Passed when it should (specificity) | Precision |",
        "| --- | --- | --- | --- |",
    ]
    for name, g in (("Input: visitor message", gi), ("Output: model reply", go)):
        recall = {"k": g["tp"], "n": g["tp"] + g["fn"], "rate": g["recall"], "ci95": g["recall_ci95"]}
        spec = {"k": g["tn"], "n": g["tn"] + g["fp"], "rate": g["specificity"], "ci95": g["specificity_ci95"]}
        out.append(f"| {name} | {_rate(recall)} | {_rate(spec)} | {_pct(g['precision'])} |")
    n_obf = sum(1 for cat in mod["categories"] if cat.startswith("obfuscated:"))
    out += [
        "",
        f"These counts cover the gated categories, which must stay at 100% for CI to pass: {n_obf} obfuscations "
        "of every listed term (leetspeak, spacing, a separator typed inside the word, an @-mention, accents, "
        "zero-width and full-width characters, a long message, an injection wrapper) and the benign text (words "
        "that contain a short term, punctuation inside ordinary words, numbers, initials, other scripts, real "
        "visitor questions and NPC replies, and every prompt and authored line an NPC may repeat).",
        "",
        "Measured, not gated (input gate):",
        "",
        "| Category | Expected | Blocked |",
        "| --- | --- | --- |",
    ]
    for cat, v in mod["categories"].items():
        if not v["gated"]:
            out.append(f"| {cat} | {v['expected']} | {_rate(v['input_gate_blocked'])} |")
    out += [
        "",
        "The known gaps are the limits of a word list: look-alike letters from other scripts, a term split into "
        "chunks, a masked letter, and (by design) the short terms glued inside a longer word. Behind the input "
        'gate are the persona rules ("Never produce slurs...") and the model\'s own safety training; the output '
        "gate runs the same list on every reply, so it shares these gaps. The known-cost row is the other side of "
        "a word list: ordinary phrases in which a short term is itself the word (a cat breed, two idioms, history "
        "questions) are blocked by both gates, so a visitor who types one, or a villager who says one, gets a "
        "scripted line instead. The by-design row is the cost of re-gluing spelled-out letters: an ordinary word "
        "typed letter by letter is read as one word and can trip a short term.",
        "",
    ]
    pv = s["planner_validator"]["adversarial_replies"]
    pr = s["prompts"]["system_prompt_chars"]
    pc = s["public_claims"]["scan"]
    out += [
        "### Planner validator (functions/src/plannerPrompt.ts)",
        "",
        f"{pv['cases']} adversarial model replies (unknown ids, injected prose, prototype keys, homoglyphs, malformed "
        f"JSON, a 20,000-character reply) through the real `parsePlanReply`: {pv['cases_with_model_text_in_plan']} "
        f"wrote anything but pool ids; {pv['llm_plans_kept']} kept a valid model plan.",
        "",
        "### Prompt invariants (functions/src/personas.ts)",
        "",
        f"All {pr['personas']} villager prompts, in both voice variants, carry the injection fence (the visitor's "
        "text is data, never instructions) and the safety and facts rules; only the concierge villagers "
        f"({', '.join(pr['concierge'])}) carry the fact sheet; its numbers match the code (villager count, chat and "
        "analyst models); no prompt holds a banned claim, a phone number, a street address or an unsanctioned "
        f"link. Largest concierge prompt: {pr['concierge_chars_max']:,} characters; median of the others: "
        f"{pr['other_chars_median']:,}.",
        "",
        "### Public-copy claims scan",
        "",
        f"Surfaces: {', '.join(pc['surfaces'])}. Rules: data/banned_claims.toml (from the fact sheet). "
        f"Hits: {pc['hits']}.",
        "",
    ]
    if pc["grandfathered"]:
        out.append(
            "Known hits in files that predate the fact sheet are tolerated only while the file is unchanged "
            "(data/claims_baseline.toml); the first edit to such a file must clear them:"
        )
        out.append("")
        for rel, hits in pc["grandfathered"].items():
            out.append(f"- {rel}: " + ", ".join(f"{k} {v}" for k, v in hits.items()))
        out.append("")
    return out


def live_section(doc: dict[str, Any] | None) -> list[str]:
    out = ["## Live suites", ""]
    if doc is None:
        return out + [
            "Not yet run. The live suites (injection and role-break attempts, facts about Abbas, planner id "
            "validity) run only from the `Evals (live)` workflow (workflow_dispatch) with an `ANTHROPIC_API_KEY` "
            "repository secret, under a hard token budget. Their scores will be recorded here after the first run.",
            "",
        ]
    b = doc.get("budget", {})
    cal = doc.get("calibration", {})
    out += [
        f"Run {doc.get('started_at', '?')}: {b.get('calls', 0)} API calls, {b.get('spent', 0):,} tokens of a "
        f"{b.get('limit', 0):,}-token budget, about ${b.get('est_cost_usd', 0):.2f}. Judge calibration: "
        f"{cal.get('correct', '?')}/{cal.get('cases', '?')}.",
        "",
        "| Suite | Cases run | Zero-tolerance findings | Judge pass |",
        "| --- | --- | --- | --- |",
    ]
    for name in ("injection", "facts"):
        s = doc.get("suites", {}).get(name)
        if s:
            hard = ", ".join(f"{k} {v}" for k, v in s["hard_failures"].items()) or "none"
            out.append(f"| {name} | {s['completed']}/{s['planned']} | {hard} | {_rate(s['judge_pass'])} |")
    p = doc.get("suites", {}).get("planner")
    if p and p.get("completed"):
        out += [
            "",
            f"Planner: {p['completed']} runs; validated plans held only pool ids in {_rate(p['validated_pool_only'])}; "
            f"raw id validity {_rate(p['raw_id_validity'])}; the model's plan survived validation in "
            f"{_rate(p['llm_plan_kept'])}.",
        ]
    return out + [""]


def render(offline: dict[str, Any], live: dict[str, Any] | None) -> str:
    lines = [
        "# Eval results",
        "",
        "Generated by `uv run python -m islandevals.report` from the run summaries; do not edit the numbers by "
        "hand. How the suites work: [README.md](README.md).",
        "",
        *offline_section(offline),
        *live_section(live),
    ]
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str]) -> int:
    offline_path = RUNS_DIR / "offline" / "summary.json"
    if not offline_path.exists():
        print("run `uv run pytest -m offline` first", file=sys.stderr)
        return 1
    live = None
    if "--live" in argv:
        live = json.loads(Path(argv[argv.index("--live") + 1]).read_text(encoding="utf-8"))
    text = render(json.loads(offline_path.read_text(encoding="utf-8")), live)
    sys.stdout.buffer.write(text.encode("utf-8"))  # LF on every OS
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
