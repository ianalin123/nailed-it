"""Critic trained on game verdicts, and the verifier audit (spec Idea 5)."""

import hashlib
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from nailed_it_training.protocol import Read, ReadCategory, Truth, VerdictRecord
from nailed_it_training.verifier import VerdictLabel, VerifierVerdict

AUDIT_STOP_THRESHOLD = 0.75

Vector = NDArray[np.float64]
Embedder = Callable[[str], Vector]
ReadKey = tuple[str, str]

_CATEGORIES = list(ReadCategory)


class VerdictFileError(ValueError):
    pass


class AuditStatus(StrEnum):
    OK = "ok"
    STOP = "stop"
    INSUFFICIENT_DATA = "insufficient_data"


@dataclass(frozen=True)
class CriticEstimate:
    p_confirm: float
    uncertainty: float

    @classmethod
    def from_probability(cls, p: float) -> "CriticEstimate":
        q = min(max(p, 1e-12), 1 - 1e-12)
        entropy_bits = -(q * math.log2(q) + (1 - q) * math.log2(1 - q))
        return cls(p_confirm=p, uncertainty=entropy_bits)


@dataclass(frozen=True)
class AuditResult:
    overlap: int
    agreement: float | None
    threshold: float
    status: AuditStatus


def truth_to_target(truth: Truth) -> float:
    match truth:
        case Truth.NAILED:
            return 1.0
        case Truth.PARTLY:
            return 0.5
        case Truth.OFF:
            return 0.0


def load_verdicts_jsonl(path: Path) -> list[VerdictRecord]:
    records: list[VerdictRecord] = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(VerdictRecord.model_validate_json(line))
            except ValidationError as err:
                raise VerdictFileError(f"{path}: line {line_no} is not a valid VerdictRecord: {err}") from err
    return records


def hashing_embedder(dim: int) -> Embedder:
    if dim < 1:
        raise ValueError("dim must be positive")

    def embed(text: str) -> Vector:
        vec = np.zeros(dim, dtype=np.float64)
        tokens = "".join(ch if ch.isalnum() else " " for ch in text.lower()).split()
        for token in tokens:
            digest = hashlib.blake2b(token.encode(), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "little") % dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[bucket] += sign
        norm = np.linalg.norm(vec)
        return vec / norm if norm > 0 else vec

    return embed


def _features(read: Read, embed: Embedder) -> Vector:
    category = np.zeros(len(_CATEGORIES), dtype=np.float64)
    category[_CATEGORIES.index(read.category)] = 1.0
    scalars = np.array([read.confidence, read.hops / 5.0, 1.0], dtype=np.float64)
    return np.concatenate([embed(read.text), category, scalars])


def _sigmoid(z: Vector) -> Vector:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30.0, 30.0)))


@dataclass(frozen=True)
class Critic:
    weights: Vector
    embed: Embedder

    @classmethod
    def fit(
        cls,
        records: Sequence[VerdictRecord],
        embed: Embedder,
        *,
        seed: int,
        l2: float = 1e-2,
        lr: float = 0.5,
        epochs: int = 500,
    ) -> "Critic":
        """Logistic regression with soft targets (partly = 0.5), full-batch gradient descent."""
        if not records:
            raise ValueError("cannot fit a critic on zero verdicts")
        x = np.stack([_features(r.read, embed) for r in records])
        y = np.array([truth_to_target(r.truth) for r in records], dtype=np.float64)
        rng = np.random.default_rng(seed)
        w: Vector = np.asarray(rng.normal(0.0, 0.01, size=x.shape[1]), dtype=np.float64)
        n = len(records)
        for _ in range(epochs):
            grad = x.T @ (_sigmoid(x @ w) - y) / n + l2 * w
            w = w - lr * grad
        return cls(weights=w, embed=embed)

    def predict(self, read: Read) -> CriticEstimate:
        p = float(_sigmoid(np.array([_features(read, self.embed) @ self.weights]))[0])
        return CriticEstimate.from_probability(p)


def _verifier_value(verdict: VerifierVerdict) -> float | None:
    match verdict.label:
        case VerdictLabel.SUPPORTED:
            return 1.0
        case VerdictLabel.CONTRADICTED:
            return 0.0
        case VerdictLabel.UNVERIFIABLE:
            return None


def audit_verifier(
    records: Sequence[VerdictRecord],
    verifier_verdicts: Mapping[ReadKey, VerifierVerdict],
    *,
    threshold: float = AUDIT_STOP_THRESHOLD,
    min_overlap: int = 20,
) -> AuditResult:
    """Agreement = mean(1 - |verifier - human|) over reads both judged; partly counts as half credit either way."""
    scores: list[float] = []
    for record in records:
        verdict = verifier_verdicts.get((record.digest_id, record.read.id))
        if verdict is None:
            continue
        value = _verifier_value(verdict)
        if value is None:
            continue
        scores.append(1.0 - abs(value - truth_to_target(record.truth)))
    if len(scores) < min_overlap:
        agreement = sum(scores) / len(scores) if scores else None
        return AuditResult(len(scores), agreement, threshold, AuditStatus.INSUFFICIENT_DATA)
    agreement = sum(scores) / len(scores)
    status = AuditStatus.OK if agreement >= threshold else AuditStatus.STOP
    return AuditResult(len(scores), agreement, threshold, status)
