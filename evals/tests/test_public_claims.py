"""Public copy says only what the fact sheet allows.

Scans index.html, public/llms.txt, public/hire.html (when present),
public/manifest.webmanifest and the string literals of SimpleUI.ts, Share.ts
and api/z.js with the rules in data/banned_claims.toml.

Hits in files that predate the fact sheet are listed in
data/claims_baseline.toml and tolerated only while the file is unchanged: the
first edit to such a file must clear every hit in it.
"""

from __future__ import annotations

import pytest

from islandevals import claims

pytestmark = pytest.mark.offline


@pytest.fixture(scope="module")
def rules():
    return claims.load_rules()


@pytest.fixture(scope="module")
def scanned(generated, rules):
    return {rel: claims.scan(rel, chunks, rules) for rel, chunks in claims.public_surfaces().items()}


def test_every_rule_matches_its_examples(rules):
    broken = {}
    for r in rules:
        missed = [e for e in r.examples_bad if not claims.scan_text(r, e)]
        false = [e for e in r.examples_ok if claims.scan_text(r, e)]
        if missed or false:
            broken[r.id] = {"should match": missed, "should not match": false}
        assert r.examples_bad, f"{r.id} needs at least one example it must match"
    assert not broken, f"rules disagree with their own examples: {broken}"


def test_a_text_surface_is_read_a_paragraph_at_a_time():
    # llms.txt wraps its lines, so a claim can straddle a line break.
    text = "# Title\n\n> A quote that\n> wraps.\n\n- An item, 18\n  conversational LLM NPCs.\n- Next\n"
    chunks = claims.text_chunks(text)
    assert [(c.line, c.text) for c in chunks] == [
        (1, "# Title"),
        (3, "A quote that wraps."),
        (6, "- An item, 18 conversational LLM NPCs."),
        (8, "- Next"),
    ]
    assert chunks[2].raw == "- An item, 18\n  conversational LLM NPCs."


def test_the_core_surfaces_are_scanned(scanned):
    for rel in ("index.html", "public/llms.txt", "SimpleUI.ts"):
        assert rel in scanned, f"{rel} was not scanned"


def test_no_new_banned_claims_on_public_surfaces(scanned, summary):
    baseline = claims.load_baseline()
    new_hits: list[str] = []
    grandfathered: dict[str, dict[str, int]] = {}
    obsolete: list[str] = []
    for rel, hits in sorted(scanned.items()):
        known = baseline.get(rel)
        if known and known["sha256"] == claims.surface_sha256(rel):
            # Unchanged since the baseline: exactly the recorded hits, no more.
            if claims.counts(hits) != dict(sorted(known["hits"].items())):
                new_hits += [f"{h}  (baseline for this file: {known['hits']})" for h in hits]
            else:
                grandfathered[rel] = known["hits"]
        else:
            if known:
                obsolete.append(rel)
            new_hits += [str(h) for h in hits]
    summary.record(
        "public_claims",
        "scan",
        {
            "surfaces": sorted(scanned),
            "hits": sum(len(h) for h in scanned.values()),
            "grandfathered": grandfathered,
            "baseline_entries_for_edited_files": obsolete,
        },
    )
    assert not new_hits, (
        "banned claims on public surfaces (fix the copy; a file that changed since "
        "data/claims_baseline.toml must be clean):\n" + "\n".join(new_hits)
    )
