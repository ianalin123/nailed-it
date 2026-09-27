import random

import pytest

from nailed_it_training.critic import CriticEstimate
from nailed_it_training.protocol import Read, ReadCategory, Truth
from nailed_it_training.selection import (
    CONFIDENCE_BAND,
    BanditState,
    Candidate,
    InsufficientCardsError,
    eligible,
    select_cards,
    update_state,
)
from nailed_it_training.verifier import VerdictLabel


def cand(
    read_id: str,
    confidence: float = 0.6,
    p: float = 0.5,
    label: VerdictLabel = VerdictLabel.UNVERIFIABLE,
    category: ReadCategory = ReadCategory.WORK_STYLE,
) -> Candidate:
    read = Read(id=read_id, text=f"read {read_id}", category=category, confidence=confidence, evidenceIds=["e1"], hops=1, modelVersion="m")
    return Candidate(read=read, critic=CriticEstimate.from_probability(p), verifier_label=label)


def test_band_is_spec_value() -> None:
    assert CONFIDENCE_BAND == (0.45, 0.8)


@pytest.mark.parametrize(("confidence", "ok"), [(0.44, False), (0.45, True), (0.6, True), (0.8, True), (0.81, False)])
def test_eligibility_band_is_inclusive(confidence: float, ok: bool) -> None:
    assert eligible(cand("a", confidence=confidence)) is ok


def test_prefers_uncertain_critic_and_undecided_verifier() -> None:
    cards = [
        cand("sure_decided", p=0.97, label=VerdictLabel.SUPPORTED),
        cand("unsure_decided", p=0.5, label=VerdictLabel.SUPPORTED),
        cand("sure_undecided", p=0.97, label=VerdictLabel.UNVERIFIABLE),
        cand("unsure_undecided", p=0.5, label=VerdictLabel.UNVERIFIABLE),
    ]
    picked = select_cards(cards, 2, BanditState.uniform(), random.Random(0))
    assert [c.read.id for c in picked][0] == "unsure_undecided"
    assert "sure_decided" not in [c.read.id for c in picked]


def test_never_selects_out_of_band_cards() -> None:
    cards = [cand("low", confidence=0.2), cand("high", confidence=0.95), *(cand(f"ok{i}") for i in range(3))]
    picked = select_cards(cards, 3, BanditState.uniform(), random.Random(1))
    assert all(eligible(c) for c in picked)


def test_raises_when_not_enough_eligible_cards() -> None:
    with pytest.raises(InsufficientCardsError):
        select_cards([cand("a"), cand("b", confidence=0.1)], 2, BanditState.uniform(), random.Random(0))


def test_deterministic_under_seeded_rng() -> None:
    cats = list(ReadCategory)
    cards = [cand(f"c{i}", p=0.3 + 0.02 * i, category=cats[i % len(cats)]) for i in range(20)]
    a = select_cards(cards, 5, BanditState.uniform(), random.Random(42))
    b = select_cards(cards, 5, BanditState.uniform(), random.Random(42))
    assert a == b


def test_update_rewards_categories_whose_labels_surprised_the_critic() -> None:
    state = BanditState.uniform()
    surprising = cand("s", p=0.9, category=ReadCategory.RISKY_READ)
    boring = cand("b", p=0.9, category=ReadCategory.WORK_STYLE)
    state = update_state(state, surprising, Truth.OFF)
    state = update_state(state, boring, Truth.NAILED)
    assert state.mean(ReadCategory.RISKY_READ) > state.mean(ReadCategory.WORK_STYLE)
