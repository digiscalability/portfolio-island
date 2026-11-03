"""Where the harness finds the repo, its fixtures, its data and its run records."""

from pathlib import Path

EVALS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = EVALS_DIR.parent
TOOLS_DIR = EVALS_DIR / "tools"
DATA_DIR = EVALS_DIR / "data"
GENERATED_DIR = EVALS_DIR / "fixtures" / "generated"
RUNS_DIR = EVALS_DIR / "runs"
