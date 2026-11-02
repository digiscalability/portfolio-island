"""Precision and recall of npcChat's server moderation (functions/lib/moderation.js).

The input gate (containsSlur) refuses a visitor's message before the model sees
it; the output gate (scrubReply) drops a model reply before it is published
above an avatar. Gated categories must be 100% right in both gates. Known gaps
and by-design costs are measured and reported, never silently passed.

No listed term is written in this file or printed by it: positives are built
in memory from the live list and named by transform and term index, and the
fixture below withholds the list and every text from reprs, so even a failing
run with -vv -l prints ids only.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from islandevals import moderation as m

pytestmark = pytest.mark.offline


@dataclass(frozen=True, repr=False)
class Corpus:
    cases: list[m.Case]
    verdicts: dict[str, m.Verdict]
    n_terms: int

    def __repr__(self) -> str:
        return f"<Corpus: {len(self.cases)} cases over {self.n_terms} listed terms>"


@pytest.fixture(scope="module")
def corpus(generated):
    terms = m.term_list()
    cases = (
        m.benign_cases()
        + m.authored_cases(generated["personas"])
        + m.positive_cases(terms)
        + m.known_cost_cases(terms)
    )
    return Corpus(cases, m.evaluate(cases), len(terms))


def test_term_list_is_loaded(corpus):
    assert corpus.n_terms >= 10, "moderate.mjs --terms returned a short list"


def test_case_text_never_shows_in_a_repr(corpus):
    positives = [c for c in corpus.cases if c.expected == m.BLOCK]
    assert positives and all(repr(c.text).startswith("<text withheld") for c in positives)
    # The known-cost phrases are expected to pass, but they hold a term too.
    costs = [c for c in corpus.cases if c.category == m.KNOWN_COST_CATEGORY]
    assert costs and all(repr(c.text).startswith("<text withheld") for c in costs)
    assert all("text=" not in repr(c) for c in corpus.cases[:5])
    assert "listed terms" in repr(corpus)


def test_corpus_is_well_formed(corpus):
    cases = corpus.cases
    assert len({c.id for c in cases}) == len(cases), "case ids must be unique"
    by_cat: dict[str, set[tuple[str, bool]]] = {}
    for c in cases:
        by_cat.setdefault(c.category, set()).add((c.expected, c.gated))
    mixed = sorted(cat for cat, kinds in by_cat.items() if len(kinds) > 1)
    assert not mixed, f"each category needs one label and one gated flag: {mixed}"


def test_every_message_fits_npcchat_input_clamp(corpus, generated):
    # npcChat clamps a visitor message to msg_max_chars before moderating it,
    # so a longer case would test text the gate never sees.
    limit = generated["personas"]["chat"]["msg_max_chars"]
    long_ids = [c.id for c in corpus.cases if not c.category.startswith("authored") and len(c.text) > limit]
    assert not long_ids, f"cases longer than the {limit}-char clamp: {long_ids}"


@pytest.mark.parametrize("gate", [m.INPUT, m.OUTPUT])
def test_no_false_positives_on_benign_text(corpus, gate):
    allowed = [c for c in corpus.cases if c.expected == m.ALLOW]
    wrong = m.wrong(allowed, corpus.verdicts, gate)
    assert not wrong, f"the {gate} gate blocked benign cases: {wrong}"


@pytest.mark.parametrize("gate", [m.INPUT, m.OUTPUT])
def test_every_common_obfuscation_is_blocked(corpus, gate):
    positives = [c for c in corpus.cases if c.expected == m.BLOCK]
    missed = m.wrong(positives, corpus.verdicts, gate)
    # Ids name the transform and the term's index, never the term.
    assert not missed, f"the {gate} gate missed: {missed}"


def test_known_gaps_and_costs_are_measured(corpus, summary):
    result = m.summarise(corpus.cases, corpus.verdicts)
    summary.record("moderation", "summary", result)
    reported = {cat: v for cat, v in result["categories"].items() if not v["gated"]}
    assert reported, "the corpus should measure at least one known gap"
    for cat, v in reported.items():
        assert v["input_gate_blocked"]["n"] > 0, f"empty category: {cat}"
    # A known gap that the filter now closes completely should move to the
    # gated transforms, so CI protects it from then on.
    closed = [
        cat
        for cat, v in reported.items()
        if v["expected"] == m.BLOCK and v["input_gate_blocked"]["rate"] == 1.0
    ]
    assert not closed, f"known gaps now fully blocked; move them to GATED_TRANSFORMS: {closed}"
    # Likewise a known cost the filter no longer pays at all belongs in the
    # gated benign corpus.
    freed = [
        cat
        for cat, v in reported.items()
        if v["expected"] == m.ALLOW and v["input_gate_blocked"]["rate"] == 0.0
    ]
    assert not freed, f"known costs no longer blocked; move them to the gated benign corpus: {freed}"
