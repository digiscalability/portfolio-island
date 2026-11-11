"""Scan public copy and NPC prompts for claims the fact sheet rules out.

The rules live in ``data/banned_claims.toml``: one regex each, with the fact
sheet line it enforces, examples it must and must not match, an optional
``exempt_sentence`` (a guard such as "Never say he graduated" may name the very
thing it forbids) and an optional ``surfaces`` list. Each rule reads either the
visible text of a surface (``target = "text"``: tags stripped, entities
decoded) or its raw strings (``target = "raw"``, which keeps hrefs, for link
and phone rules). A text surface is read a paragraph or list item at a time,
so a claim wrapped over two lines still matches.

Surfaces: index.html, public/llms.txt, public/hire.html (when present),
public/manifest.webmanifest, and the string literals of SimpleUI.ts, Share.ts,
api/z.js, Guide.ts and GuideCard.ts (parsed with the TypeScript compiler by
tools/dump_personas.mjs).

Files that predate the fact sheet carry known hits in
``data/claims_baseline.toml``. Those hits are tolerated only while the file is
byte-for-byte unchanged (by LF-normalised sha256): the first edit to such a
file must clear all of them. Run ``python -m islandevals.claims --baseline``
to print a fresh baseline.
"""

from __future__ import annotations

import html
import json
import re
import sys
import tomllib
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from . import fixtures
from .paths import DATA_DIR, REPO_ROOT

TEXT = "text"
RAW = "raw"

HTML_SURFACES = ["index.html", "public/hire.html"]
TEXT_SURFACES = ["public/llms.txt"]
JSON_SURFACES = ["public/manifest.webmanifest"]
# String-literal surfaces come from the dump (surfaces.json): SimpleUI.ts,
# Share.ts, api/z.js, Guide.ts, GuideCard.ts.

_FLAG_BITS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


@dataclass(frozen=True)
class Rule:
    id: str
    why: str
    pattern: re.Pattern[str]
    target: str = TEXT
    exempt_sentence: re.Pattern[str] | None = None
    surfaces: tuple[str, ...] | None = None  # None = every surface
    examples_bad: tuple[str, ...] = ()
    examples_ok: tuple[str, ...] = ()

    def applies_to(self, surface: str) -> bool:
        return self.surfaces is None or surface in self.surfaces


@dataclass(frozen=True)
class Chunk:
    """A piece of a surface: a text node, an attribute, a string literal."""

    line: int | None
    text: str  # visible text
    raw: str  # raw text, markup and attributes kept


@dataclass(frozen=True)
class Hit:
    rule: str
    surface: str
    line: int | None
    match: str = field(compare=False)

    def __str__(self) -> str:
        where = f"{self.surface}:{self.line}" if self.line else self.surface
        return f"{where} [{self.rule}] {self.match!r}"


def _compile(pattern: str, flags: str) -> re.Pattern[str]:
    bits = 0
    for f in flags:
        bits |= _FLAG_BITS[f]
    return re.compile(pattern, bits)


def load_rules(path: Path = DATA_DIR / "banned_claims.toml") -> list[Rule]:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    rules = []
    for r in data["rule"]:
        flags = r.get("flags", "")
        exempt = r.get("exempt_sentence")
        rules.append(
            Rule(
                id=r["id"],
                why=r["why"],
                pattern=_compile(r["pattern"], flags),
                target=r.get("target", TEXT),
                exempt_sentence=_compile(exempt, "i") if exempt else None,
                surfaces=tuple(r["surfaces"]) if "surfaces" in r else None,
                examples_bad=tuple(r.get("examples_bad", ())),
                examples_ok=tuple(r.get("examples_ok", ())),
            )
        )
    ids = [r.id for r in rules]
    if len(set(ids)) != len(ids):
        raise ValueError("rule ids must be unique")
    return rules


# --- Extracting surfaces ---------------------------------------------------------

_TAG = re.compile(r"<[^>]*>")


def visible(raw: str) -> str:
    """Strip tags and decode entities: what a reader sees of a markup string."""
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", raw))).strip()


class _HtmlChunks(HTMLParser):
    """Text nodes, attribute values and JSON-LD strings, with line numbers.

    Inline scripts and styles are code, so they are skipped, except JSON-LD,
    which is public metadata that search engines show.
    """

    TEXT_ATTRS = {"content", "alt", "title", "aria-label", "placeholder", "value"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.chunks: list[Chunk] = []
        self._skip = 0
        self._jsonld = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line = self.getpos()[0]
        for name, value in attrs:
            if value and value.strip():
                text = value if name in self.TEXT_ATTRS else ""
                self.chunks.append(Chunk(line, text, value))
        if tag in ("script", "style"):
            kind = (dict(attrs).get("type") or "").lower()
            if tag == "script" and kind == "application/ld+json":
                self._jsonld = True
            else:
                self._skip += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            if self._jsonld:
                self._jsonld = False
            else:
                self._skip = max(0, self._skip - 1)

    def handle_data(self, data: str) -> None:
        line = self.getpos()[0]
        if self._jsonld:
            for s in _json_strings(json.loads(data)):
                self.chunks.append(Chunk(line, s, s))
        elif not self._skip and data.strip():
            self.chunks.append(Chunk(line, data, data))


def _json_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _json_strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _json_strings(v)]
    return []


def html_chunks(text: str) -> list[Chunk]:
    parser = _HtmlChunks()
    parser.feed(text)
    parser.close()
    return parser.chunks


_BLOCK_START = re.compile(r"^\s*(?:#|[-*+]\s|\d+[.)]\s)")
_QUOTE_MARK = re.compile(r"^\s*>\s?")


def text_chunks(text: str) -> list[Chunk]:
    """One chunk per paragraph or list item of a Markdown-style text surface,
    so a claim wrapped over two lines is still one string. A heading, a list
    item or a blank line starts a new chunk; any other line continues the
    current one. ``raw`` keeps the lines; ``text`` drops the blockquote markers
    and indentation and joins the lines with a space."""
    chunks: list[Chunk] = []
    lines: list[str] = []
    start = 0

    def flush() -> None:
        if lines:
            joined = " ".join(_QUOTE_MARK.sub("", row).strip() for row in lines)
            chunks.append(Chunk(start, re.sub(r"\s+", " ", joined).strip(), "\n".join(lines)))
            lines.clear()

    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            flush()
            continue
        if not lines or _BLOCK_START.match(_QUOTE_MARK.sub("", line)):
            flush()
            start = n
        lines.append(line)
    flush()
    return chunks


def string_chunks(strings: list[dict[str, Any]]) -> list[Chunk]:
    return [Chunk(s["line"], visible(s["text"]), s["text"]) for s in strings]


def read_text(rel: str) -> str:
    return (REPO_ROOT / rel).read_bytes().decode("utf-8").replace("\r\n", "\n")


def public_surfaces() -> dict[str, list[Chunk]]:
    """Every public surface present in this checkout, as chunks."""
    out: dict[str, list[Chunk]] = {}
    for rel in HTML_SURFACES:
        if (REPO_ROOT / rel).exists():
            out[rel] = html_chunks(read_text(rel))
    for rel in TEXT_SURFACES:
        if (REPO_ROOT / rel).exists():
            out[rel] = text_chunks(read_text(rel))
    for rel in JSON_SURFACES:
        if (REPO_ROOT / rel).exists():
            strings = _json_strings(json.loads(read_text(rel)))
            out[rel] = [Chunk(None, s, s) for s in strings]
    for rel, entry in fixtures.load("surfaces")["files"].items():
        out[rel] = string_chunks(entry["strings"])
    return out


def surface_sha256(rel: str) -> str:
    return fixtures.text_sha256(REPO_ROOT / rel)


# --- Scanning -----------------------------------------------------------------------

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")


def _sentence_around(text: str, start: int, end: int) -> str:
    left = max((m.end() for m in _SENTENCE_END.finditer(text, 0, start)), default=0)
    right_match = _SENTENCE_END.search(text, end)
    right = right_match.start() if right_match else len(text)
    return text[left:right]


def scan_text(rule: Rule, text: str) -> list[str]:
    """Matches of one rule in one string, minus exempt sentences."""
    found = []
    for m in rule.pattern.finditer(text):
        if rule.exempt_sentence and rule.exempt_sentence.search(_sentence_around(text, m.start(), m.end())):
            continue
        found.append(m.group(0))
    return found


def scan(surface: str, chunks: list[Chunk], rules: list[Rule]) -> list[Hit]:
    hits = []
    for rule in rules:
        if not rule.applies_to(surface):
            continue
        for chunk in chunks:
            text = chunk.raw if rule.target == RAW else chunk.text
            if not text:
                continue
            for match in scan_text(rule, text):
                hits.append(Hit(rule.id, surface, chunk.line, match))
    return hits


def counts(hits: list[Hit]) -> dict[str, int]:
    return dict(sorted(Counter(h.rule for h in hits).items()))


# --- Baseline ------------------------------------------------------------------------


def load_baseline(path: Path = DATA_DIR / "claims_baseline.toml") -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    return tomllib.loads(path.read_text(encoding="utf-8")).get("files", {})


def render_baseline(rules: list[Rule]) -> str:
    """A claims_baseline.toml for the current checkout (for --baseline)."""
    lines = [
        "# Known claims-rule hits in public files that predate the fact sheet.",
        "# A file's entry applies only while its LF-normalised sha256 is unchanged:",
        "# the first edit to the file must clear every hit (CI fails otherwise).",
        "# Regenerate: cd evals && uv run python -m islandevals.claims --baseline",
        "",
    ]
    for rel, chunks in sorted(public_surfaces().items()):
        hits = counts(scan(rel, chunks, rules))
        if not hits:
            continue
        lines.append(f'[files."{rel}"]')
        lines.append(f'sha256 = "{surface_sha256(rel)}"')
        lines.append("hits = { " + ", ".join(f'"{k}" = {v}' for k, v in hits.items()) + " }")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    rules = load_rules()
    if "--baseline" in argv:
        # Bytes, so the file gets LF line endings on Windows too.
        sys.stdout.buffer.write(render_baseline(rules).encode("utf-8"))
        return 0
    for rel, chunks in sorted(public_surfaces().items()):
        for hit in scan(rel, chunks, rules):
            print(hit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
