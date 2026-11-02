"""Load the fixtures ``tools/dump_personas.mjs`` writes, and refuse stale ones.

The fixtures are generated from the built Cloud Functions, never edited by
hand, and git-ignored. Each dump records a hash of every source file it came
from, so a suite run after an edit (without a rebuild and a fresh dump) fails
loudly instead of testing yesterday's prompts.
"""

from __future__ import annotations

import hashlib
import json
from functools import cache
from pathlib import Path
from typing import Any

from .paths import GENERATED_DIR, REPO_ROOT

DUMP_HINT = (
    "Build the functions and dump the fixtures first, from the repo root:\n"
    "  cd functions && npm ci && npm run build && cd ..\n"
    "  node evals/tools/dump_personas.mjs"
)


class FixtureError(RuntimeError):
    """A fixture is missing or older than the source it was dumped from."""


def text_sha256(path: Path) -> str:
    """sha256 of a text file with CRLF folded to LF (matches dump_personas.mjs)."""
    text = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@cache
def load(name: str) -> dict[str, Any]:
    """One generated fixture (personas, planner, surfaces, meta) as JSON."""
    path = GENERATED_DIR / f"{name}.json"
    if not path.exists():
        raise FixtureError(f"{path.relative_to(REPO_ROOT).as_posix()} is missing.\n{DUMP_HINT}")
    return json.loads(path.read_text(encoding="utf-8"))


def stale_sources() -> list[str]:
    """Source files that changed since the last dump (repo-relative paths)."""
    meta = load("meta")
    recorded = {**meta["src_sha256"], **meta["ui_sha256"]}
    stale = []
    for rel, sha in recorded.items():
        path = REPO_ROOT / rel
        if not path.exists() or text_sha256(path) != sha:
            stale.append(rel)
    return stale


def require_fresh() -> None:
    """Raise FixtureError unless every recorded source still matches the dump."""
    stale = stale_sources()
    if stale:
        raise FixtureError("The fixtures predate edits to: " + ", ".join(stale) + ".\n" + DUMP_HINT)
