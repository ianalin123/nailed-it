import pytest

from nailed_it_training.calibration import CALIBRATION_SET, CalibrationKind, calibration_rules, score_verifier
from nailed_it_training.protocol import EvidenceItem
from nailed_it_training.verifier import KeywordVerifier, VerdictLabel, VerifierVerdict


def test_set_covers_all_four_kinds_with_expected_labels() -> None:
    kinds = {item.kind for item in CALIBRATION_SET}
    assert kinds == set(CalibrationKind)
    for item in CALIBRATION_SET:
        expected = {
            CalibrationKind.SUPPORTED: VerdictLabel.SUPPORTED,
            CalibrationKind.CONTRADICTED: VerdictLabel.CONTRADICTED,
            CalibrationKind.COMPATIBLE: VerdictLabel.UNVERIFIABLE,
            CalibrationKind.UNRELATED: VerdictLabel.UNVERIFIABLE,
        }[item.kind]
        assert item.expected is expected
        assert len(item.evidence) >= 3
        assert len({e.id for e in item.evidence}) == len(item.evidence)


def test_set_has_at_least_four_items_per_kind() -> None:
    for kind in CalibrationKind:
        assert sum(i.kind is kind for i in CALIBRATION_SET) >= 4


def test_fake_verifier_with_calibration_rules_scores_perfectly() -> None:
    result = score_verifier(KeywordVerifier(calibration_rules()))
    assert result.correct == result.total == len(CALIBRATION_SET)
    assert result.accuracy == 1.0
    assert all(v == 1.0 for v in result.by_kind.values())


class Lenient:
    def verify(self, read_text: str, hidden: list[EvidenceItem]) -> VerifierVerdict:
        return VerifierVerdict(label=VerdictLabel.SUPPORTED, strength=0.9, cited_ids=[hidden[0].id], rationale="")

    def verify_many(self, read_texts: list[str], hidden: list[EvidenceItem]) -> list[VerifierVerdict]:
        return [self.verify(t, hidden) for t in read_texts]


def test_lenient_verifier_scores_badly_on_compatible_and_unrelated() -> None:
    result = score_verifier(Lenient())
    assert result.by_kind[CalibrationKind.SUPPORTED] == 1.0
    assert result.by_kind[CalibrationKind.COMPATIBLE] == 0.0
    assert result.by_kind[CalibrationKind.UNRELATED] == 0.0
    assert result.accuracy < 0.5


class Raising:
    def verify(self, read_text: str, hidden: list[EvidenceItem]) -> VerifierVerdict:
        raise ValueError("boom")

    def verify_many(self, read_texts: list[str], hidden: list[EvidenceItem]) -> list[VerifierVerdict]:
        raise ValueError("boom")


def test_verifier_errors_count_as_wrong_and_are_reported() -> None:
    result = score_verifier(Raising())
    assert result.correct == 0
    assert len(result.errors) == len(CALIBRATION_SET)
    assert "boom" in result.errors[0]


def test_accuracy_threshold_constant() -> None:
    from nailed_it_training.calibration import PASS_THRESHOLD

    assert pytest.approx(0.8) == PASS_THRESHOLD
