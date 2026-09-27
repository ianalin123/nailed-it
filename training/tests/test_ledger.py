from pathlib import Path

import pytest

from nailed_it_training.fake_backend import FAKE_BASE, FakeBackend
from nailed_it_training.ledger import PRICING, Price, SpendCapExceeded, SpendLedger, Usage
from nailed_it_training.river_adapter import ModelRef, RlConfig, RlRow

FAKE_PRICES = {FAKE_BASE: Price(prompt=1.0, cached=0.2, completion=2.0, training=3.0)}


def test_pricing_table_matches_river_notes_for_chosen_base() -> None:
    assert PRICING["Qwen/Qwen3.6-35B-A3B-FP8"] == Price(prompt=0.33, cached=0.066, completion=0.82, training=1.00)


def test_cost_per_million_tokens() -> None:
    ledger = SpendLedger(cap_usd=5.0, pricing=FAKE_PRICES)
    usage = Usage(
        model=FAKE_BASE, label="x", prompt_tokens=1_000_000, cached_prompt_tokens=500_000, completion_tokens=1_000_000, training_tokens=1_000_000
    )
    assert ledger.cost(usage) == pytest.approx(0.5 * 1.0 + 0.5 * 0.2 + 2.0 + 3.0)


def test_unknown_model_is_an_error_not_free() -> None:
    with pytest.raises(KeyError):
        SpendLedger(cap_usd=5.0, pricing=FAKE_PRICES).cost(Usage(model="mystery/model", label="x", prompt_tokens=1))


def test_check_raises_before_a_call_that_would_exceed_the_cap() -> None:
    ledger = SpendLedger(cap_usd=1.0, pricing=FAKE_PRICES)
    ledger.record(Usage(model=FAKE_BASE, label="a", prompt_tokens=900_000))
    with pytest.raises(SpendCapExceeded):
        ledger.check(Usage(model=FAKE_BASE, label="b", prompt_tokens=200_000))
    assert ledger.spent == pytest.approx(0.9)


def test_ledger_persists_across_instances(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    SpendLedger(cap_usd=1.0, pricing=FAKE_PRICES, path=path).record(Usage(model=FAKE_BASE, label="a", completion_tokens=100_000))
    again = SpendLedger(cap_usd=1.0, pricing=FAKE_PRICES, path=path)
    assert again.spent == pytest.approx(0.2)
    assert again.totals()["completion_tokens"] == 100_000


def user_prompt() -> str:
    return 'Person: X\n\nEvidence items (JSON):\n[{"id": "e1", "source": "other", "observedAt": null, "text": "hello"}]'


class TestCapWithFakeBackend:
    def test_sampling_records_usage(self) -> None:
        ledger = SpendLedger(cap_usd=5.0, pricing=FAKE_PRICES)
        backend = FakeBackend(seed=0, ledger=ledger)
        backend.sample(ModelRef(FAKE_BASE), system="s", user=user_prompt(), n=2, max_tokens=100, temperature=1.0, seed=0)
        assert ledger.totals()["prompt_tokens"] > 0 and ledger.totals()["completion_tokens"] > 0
        assert ledger.spent > 0

    def test_sampling_over_cap_raises_before_any_spend(self) -> None:
        ledger = SpendLedger(cap_usd=1e-9, pricing=FAKE_PRICES)
        backend = FakeBackend(seed=0, ledger=ledger)
        with pytest.raises(SpendCapExceeded):
            backend.sample(ModelRef(FAKE_BASE), system="s", user=user_prompt(), n=2, max_tokens=100, temperature=1.0, seed=0)
        assert ledger.spent == 0.0

    def test_rl_run_is_refused_up_front_when_worst_case_exceeds_cap(self) -> None:
        ledger = SpendLedger(cap_usd=0.001, pricing=FAKE_PRICES)
        backend = FakeBackend(seed=0, ledger=ledger)
        calls: list[str] = []

        def reward(row: RlRow, completion: str) -> float:
            calls.append(row.row_id)
            return 0.0

        config = RlConfig(name="rl", base_model=FAKE_BASE, steps=50, group_size=8, groups_per_step=8, max_generated_tokens=4096)
        with pytest.raises(SpendCapExceeded):
            backend.run_rl([RlRow("r", "s", user_prompt())], reward, config)
        assert calls == []
        assert ledger.spent == 0.0
