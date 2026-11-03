"""Run the repo's Node shims (``tools/*.mjs``) over JSON lines.

The shims load the built Cloud Functions (``functions/lib``), so every verdict
comes from the code that ships. Input goes over stdin as ASCII-escaped JSON,
which keeps zero-width and full-width test characters intact on every OS.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

from .paths import REPO_ROOT, TOOLS_DIR


class ShimError(RuntimeError):
    """A shim failed, or returned the wrong number of verdicts."""


def _node() -> str:
    exe = shutil.which("node")
    if not exe:
        raise ShimError("node is not on PATH; the shims run the built Cloud Functions.")
    return exe


def _run(tool: str, args: list[str], payload: bytes, timeout: float) -> bytes:
    # Hidden from pytest tracebacks: the arguments hold case text, which may
    # include listed terms. The shims never echo it.
    __tracebackhide__ = True
    proc = subprocess.run(
        [_node(), str(TOOLS_DIR / tool), *args],
        input=payload,
        capture_output=True,
        timeout=timeout,
        cwd=REPO_ROOT,
        check=False,
    )
    if proc.returncode != 0:
        # The shims never echo case text, so stderr is safe to show.
        err = proc.stderr.decode("utf-8", "replace").strip()[:600]
        raise ShimError(f"{tool} exited {proc.returncode}: {err}")
    return proc.stdout


def run_jsonl(tool: str, records: list[dict[str, Any]], *, timeout: float = 120) -> list[dict[str, Any]]:
    """Send one JSON object per line; get one verdict per line, in order."""
    __tracebackhide__ = True  # the records hold case text
    payload = "".join(json.dumps(r, ensure_ascii=True) + "\n" for r in records).encode("ascii")
    out = _run(tool, [], payload, timeout)
    verdicts = [json.loads(line) for line in out.decode("utf-8").splitlines() if line.strip()]
    if [v.get("id") for v in verdicts] != [r.get("id") for r in records]:
        raise ShimError(f"{tool} returned {len(verdicts)} verdicts for {len(records)} cases, or out of order")
    return verdicts


def run_json(tool: str, *args: str, timeout: float = 60) -> Any:
    """Run a shim mode that prints one JSON document (e.g. ``moderate.mjs --terms``)."""
    __tracebackhide__ = True  # the document may be the term list
    return json.loads(_run(tool, list(args), b"", timeout).decode("utf-8"))
