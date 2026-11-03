"""Invariants of the prompts npcChat and the planner send, read from the dump of
the built functions (personas.ts, constants.ts, plannerPrompt.ts).

Every villager fences the visitor's text as data; only the concierge villagers
carry the fact sheet, and it says only what the fact sheet says; the numbers in
it match the code; no prompt holds a banned claim or an unsanctioned contact
detail; the day context npcChat appends is clamped server text.
"""

from __future__ import annotations

import re
import statistics
import tomllib

import pytest

from islandevals import checks, claims
from islandevals.paths import DATA_DIR, REPO_ROOT

pytestmark = pytest.mark.offline

FACTS = tomllib.loads((DATA_DIR / "fact_sheet.toml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def p(generated):
    return generated["personas"]


def prompts(p, variant=None):
    """(variant, persona id, name, system prompt) for every prompt."""
    for v, cast in p["personas"].items():
        if variant in (None, v):
            for pid, persona in cast.items():
                yield v, pid, persona["name"], persona["system"]


def client_roster() -> list[str]:
    src = (REPO_ROOT / "NpcChat.ts").read_text(encoding="utf-8")
    return re.findall(r"id: '([a-z_]+)'", src[src.index("AI_NPC_DEFS") :])


def test_one_cast_everywhere(p, generated):
    roles = [r["id"] for r in p["npc_roles"]]
    assert len(roles) == len(set(roles)), "persona ids must be unique"
    assert roles == client_roster(), "personas.ts NPC_ROLES must match the client's AI_NPC_DEFS, in order"
    assert roles == generated["planner"]["pools"]["personas"], "the planner must plan for the same cast"
    for variant, cast in p["personas"].items():
        assert list(cast) == roles, f"{variant}: the prompt map must follow NPC_ROLES"


def test_every_prompt_fences_the_visitor_text(p):
    missing = {}
    for variant, pid, name, system in prompts(p):
        lacks = [c for c in FACTS["fence"]["required"] if c.format(name=name) not in system]
        if lacks:
            missing[f"{variant}/{pid}"] = lacks
    assert not missing, f"prompts missing fence or safety clauses: {missing}"


def test_the_rules_come_after_the_character_line(p):
    for _variant, pid, name, system in prompts(p):
        assert system.startswith(f"You are {name}, "), pid
        assert system.index("RULES (always obey)") > system.index("who lives on"), pid


def test_only_concierge_villagers_carry_the_fact_sheet(p):
    concierge = {r["id"] for r in p["npc_roles"] if r.get("concierge")}
    assert concierge, "at least one villager should be a concierge"
    about = p["about_abbas"]
    leaked = {}
    for variant, pid, _name, system in prompts(p):
        if pid in concierge:
            assert system.endswith(about), f"{variant}/{pid} must end with the fact sheet"
        else:
            # Case-sensitive: "Do not invent specific facts about Abbas" is a
            # rule every villager carries; "FACTS ABOUT ABBAS" is the sheet's header.
            found = [t for t in FACTS["non_concierge"]["forbidden"] if t in system]
            if found:
                leaked[f"{variant}/{pid}"] = found
    assert not leaked, f"non-concierge prompts carry concierge-only facts: {leaked}"


def test_the_fact_sheet_says_what_the_fact_sheet_says(p):
    about = p["about_abbas"]
    missing = [phrase for phrase in FACTS["concierge"]["required"] if phrase not in about]
    assert not missing, f"ABOUT_ABBAS lacks fact-sheet lines: {missing}"


def test_the_fact_sheet_numbers_match_the_code(p, generated):
    about = p["about_abbas"]
    villagers = re.search(r"\b(\d+) villagers\b", about)
    assert villagers, "ABOUT_ABBAS should state how many villagers talk"
    assert int(villagers.group(1)) == len(p["npc_roles"]) == len(generated["planner"]["pools"]["personas"])
    # "Claude Haiku 4.5" in the prompt <-> the model npcChat actually calls.
    assert "Claude Haiku 4.5" in about
    assert p["chat"]["model"].startswith("claude-haiku-4-5"), p["chat"]["model"]
    assert generated["planner"]["model"] == p["chat"]["model"]
    # "nightly analyst agent (Claude Sonnet)" <-> the analyst's model.
    assert "(Claude Sonnet)" in about
    assert p["analyst_model"].startswith("claude-sonnet"), p["analyst_model"]


def test_the_voice_tag_rule_follows_the_tts_flag(p):
    flag = "bracketed delivery tag"
    for _v, pid, _n, system in prompts(p, "audio_tags_on"):
        assert flag in system, pid
    for _v, pid, _n, system in prompts(p, "audio_tags_off"):
        assert flag not in system, pid
    assert isinstance(p["audio_tags_in_production"], bool)


def test_no_prompt_holds_a_banned_claim(p, generated):
    rules = claims.load_rules()
    texts = [system for *_rest, system in prompts(p)]
    texts += list(p["day_context"]["by_persona"].values())
    texts += [generated["planner"]["system"], generated["planner"]["user"]]
    hits = claims.scan("prompts", [claims.Chunk(None, t, t) for t in texts], rules)
    assert not hits, "banned claims in prompts:\n" + "\n".join(str(h) for h in hits)


def test_prompts_hold_only_sanctioned_contacts(p):
    emails_ok = set(FACTS["contacts"]["emails"])
    urls_ok = tuple(FACTS["contacts"]["urls"])
    bad = set()
    found = set()
    for _v, _pid, _n, system in prompts(p):
        emails, urls = checks.EMAIL.findall(system), checks.links(system)
        found |= set(emails) | set(urls)
        bad |= {e for e in emails if e not in emails_ok}
        bad |= {u for u in urls if not checks.link_allowed(u, urls_ok)}
        assert not checks.private_details(system.replace("\n", " ")), (
            "a prompt holds a phone number or address"
        )
    assert found, "the concierge prompts should carry the sanctioned contacts"
    assert not bad, f"unsanctioned contact details in prompts: {sorted(bad)}"


def test_the_day_context_is_clamped_server_text(p):
    dc = p["day_context"]
    rumor = p["rumors"][dc["rumor_index"]]
    rumor_line = f'\n\nISLAND RUMOR OF THE DAY: "{rumor}"'
    assert dc["no_world"].startswith(rumor_line), "with no world state only the rumor line is added"
    for pid, ctx in dc["by_persona"].items():
        assert rumor_line in ctx, pid
    probe = dc["clamp_probe"]
    assert "a" * 32 in probe and "a" * 33 not in probe, "the planner task is clamped to 32 chars"
    assert "e" * 24 in probe and "e" * 25 not in probe, "the day-theme is clamped to 24 chars"
    assert "m" * 16 in probe and "m" * 17 not in probe, "the mood is clamped to 16 chars"


def test_the_planner_offers_each_pool_id_once(generated):
    planner = generated["planner"]
    user = planner["user"]
    for key, label in (
        ("personas", "Personas: "),
        ("activities", "Activities (choose one per persona): "),
        ("events", "Events (choose one): "),
    ):
        line = next(ln for ln in user.splitlines() if ln.startswith(label))
        offered = line[len(label) :].split(", ")
        assert offered == planner["pools"][key], key
    assert "Use only ids from the lists." in user
    assert "ONLY minified JSON" in planner["system"]


def test_prompt_sizes_are_recorded(p, summary):
    sizes = {pid: len(system) for _v, pid, _n, system in prompts(p, "audio_tags_on")}
    concierge = {r["id"] for r in p["npc_roles"] if r.get("concierge")}
    summary.record(
        "prompts",
        "system_prompt_chars",
        {
            "personas": len(sizes),
            "concierge": sorted(concierge),
            "concierge_chars_max": max(sizes[c] for c in concierge),
            "other_chars_median": int(statistics.median(v for k, v in sizes.items() if k not in concierge)),
            "audio_tags_in_production": p["audio_tags_in_production"],
        },
    )
    assert max(sizes.values()) < 8000, "a persona prompt grew past 8,000 characters"
