"""Spend ledger with a hard cap. Every River call is checked before it is made and recorded after.

Prices are River Cloud preview rates in USD per 1M tokens, copied from https://river.ai on 2026-09-27
(docs/working/river-notes.md). Costs are estimates: River bills what River bills.
"""

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path


class SpendCapExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class Price:
    prompt: float
    cached: float
    completion: float
    training: float


PRICING: dict[str, Price] = {
    "Qwen/Qwen3.8-27B-FP8": Price(1.80, 0.360, 5.50, 4.10),
    "Qwen/Qwen3.5-9B": Price(0.66, 0.132, 1.99, 1.46),
    "Qwen/Qwen3.6-35B-A3B-FP8": Price(0.33, 0.066, 0.82, 1.00),
    "Qwen/Qwen3.5-122B-A10B-FP8": Price(1.00, 0.200, 3.00, 4.00),
    "Qwen/Qwen3.5-397B-A17B-FP8": Price(3.32, 0.664, 8.30, 10.00),
    "nvidia/Kimi-K2.6-NVFP4": Price(1.22, 0.244, 3.06, 3.67),
    "nvidia/Kimi-K2.6-NVFP4-262K": Price(4.28, 0.856, 10.70, 12.84),
    "nvidia/GLM-5.2-NVFP4": Price(1.46, 0.292, 3.67, 4.40),
    "nvidia/GLM-5.2-NVFP4-262K": Price(5.14, 1.028, 12.84, 15.41),
    "zai-org/GLM-5.3-Flash": Price(1.50, 0.300, 3.00, 8.00),
    "deepseek-ai/DeepSeek-V4-Flash-0731": Price(1.50, 0.300, 3.00, 8.00),
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4": Price(0.30, 0.060, 0.80, 1.00),
}


@dataclass(frozen=True)
class Usage:
    model: str
    label: str
    prompt_tokens: int = 0
    cached_prompt_tokens: int = 0
    completion_tokens: int = 0
    training_tokens: int = 0


_TOKEN_FIELDS = ("prompt_tokens", "cached_prompt_tokens", "completion_tokens", "training_tokens")


class SpendLedger:
    def __init__(self, cap_usd: float, pricing: Mapping[str, Price] = PRICING, path: Path | None = None) -> None:
        if cap_usd <= 0:
            raise ValueError("cap_usd must be positive")
        self.cap_usd = cap_usd
        self._pricing = pricing
        self._path = path
        self._spent = 0.0
        self._tokens = dict.fromkeys(_TOKEN_FIELDS, 0)
        self._calls = 0
        if path is not None and path.exists():
            self._load(path)

    def _load(self, path: Path) -> None:
        for line_no, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                self._spent += float(row["cost_usd"])
                for f in _TOKEN_FIELDS:
                    self._tokens[f] += int(row[f])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as err:
                raise ValueError(f"{path}: line {line_no} is not a valid ledger row") from err
            self._calls += 1

    @property
    def spent(self) -> float:
        return self._spent

    @property
    def remaining(self) -> float:
        return self.cap_usd - self._spent

    def cost(self, usage: Usage) -> float:
        if usage.model not in self._pricing:
            raise KeyError(f"no price for model {usage.model!r}; add it to the pricing table before spending on it")
        price = self._pricing[usage.model]
        if usage.cached_prompt_tokens > usage.prompt_tokens:
            raise ValueError("cached_prompt_tokens cannot exceed prompt_tokens")
        uncached = usage.prompt_tokens - usage.cached_prompt_tokens
        return (
            uncached * price.prompt
            + usage.cached_prompt_tokens * price.cached
            + usage.completion_tokens * price.completion
            + usage.training_tokens * price.training
        ) / 1_000_000

    def check(self, estimate: Usage) -> float:
        """Raise before a call whose worst-case estimate would take total spend over the cap."""
        projected = self.cost(estimate)
        if self._spent + projected > self.cap_usd:
            raise SpendCapExceeded(
                f"{estimate.label}: estimated ${projected:.4f} on top of ${self._spent:.4f} spent exceeds the ${self.cap_usd:.2f} cap"
            )
        return projected

    def record(self, usage: Usage) -> float:
        cost = self.cost(usage)
        self._spent += cost
        self._calls += 1
        for f in _TOKEN_FIELDS:
            self._tokens[f] += getattr(usage, f)
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            row = {"at": datetime.now(UTC).isoformat(), **asdict(usage), "cost_usd": cost}
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row) + "\n")
        return cost

    def totals(self) -> dict[str, float]:
        return {**self._tokens, "calls": self._calls, "cost_usd": self._spent, "cap_usd": self.cap_usd}


def estimate_tokens(text: str) -> int:
    """Conservative pre-call estimate (about 3 characters per token). Actual counts come from River's response."""
    return len(text) // 3 + 1
