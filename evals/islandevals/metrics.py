"""Confusion counts, precision and recall, and Wilson score intervals."""

from __future__ import annotations

import math
from dataclasses import dataclass

Z95 = 1.959964


def wilson(successes: int, n: int, z: float = Z95) -> tuple[float, float]:
    """95% Wilson score interval for a proportion (sane at 0/n and n/n)."""
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def rate(successes: int, n: int) -> dict[str, float | int | None]:
    """A proportion with its interval, as plain JSON."""
    lo, hi = wilson(successes, n)
    return {
        "k": successes,
        "n": n,
        "rate": round(successes / n, 4) if n else None,
        "ci95": [round(lo, 4), round(hi, 4)],
    }


@dataclass
class Confusion:
    """Block/allow outcomes against block/allow labels (positive = block)."""

    tp: int = 0
    fp: int = 0
    tn: int = 0
    fn: int = 0

    def add(self, *, should_block: bool, blocked: bool) -> None:
        if should_block and blocked:
            self.tp += 1
        elif should_block:
            self.fn += 1
        elif blocked:
            self.fp += 1
        else:
            self.tn += 1

    @property
    def precision(self) -> float | None:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else None

    @property
    def recall(self) -> float | None:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else None

    @property
    def specificity(self) -> float | None:
        return self.tn / (self.tn + self.fp) if self.tn + self.fp else None

    def as_dict(self) -> dict[str, object]:
        def r(x: float | None) -> float | None:
            return None if x is None else round(x, 4)

        return {
            "tp": self.tp,
            "fp": self.fp,
            "tn": self.tn,
            "fn": self.fn,
            "precision": r(self.precision),
            "recall": r(self.recall),
            "specificity": r(self.specificity),
            "recall_ci95": [round(v, 4) for v in wilson(self.tp, self.tp + self.fn)],
            "specificity_ci95": [round(v, 4) for v in wilson(self.tn, self.tn + self.fp)],
        }
