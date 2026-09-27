import json
from pathlib import Path

import numpy as np
import pytest

from nailed_it_training.critic import (
    AUDIT_STOP_THRESHOLD,
    AuditStatus,
    Critic,
    CriticEstimate,
    VerdictFileError,
    audit_verifier,
    hashing_embedder,
    load_verdicts_jsonl,
    truth_to_target,
)
from nailed_it_training.protocol import Read, ReadCategory, Truth, VerdictRecord
from nailed_it_training.verifier import VerdictLabel, VerifierVerdict


def make_record(read_id: str, text: str, truth: Truth, digest: str = "d1", confidence: float = 0.6) -> VerdictRecord:
    read = Read(
        id=read_id, text=text, category=ReadCategory.WORK_STYLE, confidence=confidence, evidenceIds=["e1"], hops=1, modelVersion="m"
    )
    return VerdictRecord(
        protocolVersion=1,
        roomCode="ABCD",
        recordedAt="2026-09-27T23:00:00Z",
        digestId=digest,
        read=read,
        truth=truth,
        guessCounts={"nailed": 1, "off": 1},
    )


def test_truth_mapping_matches_spec() -> None:
    assert truth_to_target(Truth.NAILED) == 1.0
    assert truth_to_target(Truth.PARTLY) == 0.5
    assert truth_to_target(Truth.OFF) == 0.0


def test_audit_threshold_is_spec_value() -> None:
    assert AUDIT_STOP_THRESHOLD == 0.75


class TestLoadVerdicts:
    def test_loads_valid_jsonl(self, tmp_path: Path) -> None:
        path = tmp_path / "v.jsonl"
        rows = [make_record("r1", "a", Truth.NAILED), make_record("r2", "b", Truth.OFF)]
        path.write_text("\n".join(r.model_dump_json(by_alias=True) for r in rows) + "\n\n")
        assert load_verdicts_jsonl(path) == rows

    def test_reports_line_number_of_bad_row(self, tmp_path: Path) -> None:
        path = tmp_path / "v.jsonl"
        good = make_record("r1", "a", Truth.NAILED).model_dump_json(by_alias=True)
        bad = json.dumps({"protocolVersion": 1, "truth": "maybe"})
        path.write_text(f"{good}\n{bad}\n")
        with pytest.raises(VerdictFileError, match="line 2"):
            load_verdicts_jsonl(path)


class TestCritic:
    def training_set(self) -> list[VerdictRecord]:
        hits = [make_record(f"h{i}", f"You refactor late at night variant {i}", Truth.NAILED) for i in range(20)]
        misses = [make_record(f"m{i}", f"You love morning meetings variant {i}", Truth.OFF) for i in range(20)]
        partial = [make_record(f"p{i}", f"You journal sometimes variant {i}", Truth.PARTLY) for i in range(6)]
        return hits + misses + partial

    def test_learns_to_separate_confirmed_from_denied_reads(self) -> None:
        critic = Critic.fit(self.training_set(), hashing_embedder(64), seed=0)
        hit = critic.predict(make_record("x", "You refactor late at night again", Truth.NAILED).read)
        miss = critic.predict(make_record("y", "You love morning meetings again", Truth.OFF).read)
        assert hit.p_confirm > 0.7 > 0.3 > miss.p_confirm

    def test_uncertainty_is_highest_near_one_half(self) -> None:
        assert CriticEstimate.from_probability(0.5).uncertainty == pytest.approx(1.0)
        assert CriticEstimate.from_probability(0.99).uncertainty < 0.1

    def test_fit_is_deterministic(self) -> None:
        a = Critic.fit(self.training_set(), hashing_embedder(64), seed=3)
        b = Critic.fit(self.training_set(), hashing_embedder(64), seed=3)
        np.testing.assert_array_equal(a.weights, b.weights)

    def test_fit_rejects_empty_training_set(self) -> None:
        with pytest.raises(ValueError):
            Critic.fit([], hashing_embedder(16), seed=0)

    def test_hashing_embedder_is_deterministic_and_normalised(self) -> None:
        embed = hashing_embedder(32)
        v = embed("You refactor late at night")
        assert v.shape == (32,)
        np.testing.assert_allclose(v, embed("You refactor late at night"))
        assert np.linalg.norm(v) == pytest.approx(1.0)


def vv(label: VerdictLabel) -> VerifierVerdict:
    cited = [] if label is VerdictLabel.UNVERIFIABLE else ["h1"]
    return VerifierVerdict(label=label, strength=0.9, cited_ids=cited, rationale="")


class TestAudit:
    def test_agreement_with_partly_as_half_credit(self) -> None:
        records = [
            make_record("a", "t", Truth.NAILED),
            make_record("b", "t", Truth.OFF),
            make_record("c", "t", Truth.PARTLY),
            make_record("d", "t", Truth.NAILED),
        ]
        verdicts = {
            ("d1", "a"): vv(VerdictLabel.SUPPORTED),
            ("d1", "b"): vv(VerdictLabel.CONTRADICTED),
            ("d1", "c"): vv(VerdictLabel.SUPPORTED),
            ("d1", "d"): vv(VerdictLabel.CONTRADICTED),
        }
        result = audit_verifier(records, verdicts, min_overlap=1)
        assert result.overlap == 4
        assert result.agreement == pytest.approx((1 + 1 + 0.5 + 0) / 4)
        assert result.status is AuditStatus.STOP

    def test_unverifiable_and_unmatched_reads_are_outside_the_overlap(self) -> None:
        records = [make_record("a", "t", Truth.NAILED), make_record("b", "t", Truth.OFF), make_record("z", "t", Truth.OFF)]
        verdicts = {("d1", "a"): vv(VerdictLabel.SUPPORTED), ("d1", "b"): vv(VerdictLabel.UNVERIFIABLE)}
        result = audit_verifier(records, verdicts, min_overlap=1)
        assert result.overlap == 1
        assert result.agreement == 1.0
        assert result.status is AuditStatus.OK

    def test_small_overlap_is_insufficient_not_ok(self) -> None:
        records = [make_record("a", "t", Truth.NAILED)]
        result = audit_verifier(records, {("d1", "a"): vv(VerdictLabel.SUPPORTED)}, min_overlap=10)
        assert result.status is AuditStatus.INSUFFICIENT_DATA

    def test_exactly_at_threshold_is_ok(self) -> None:
        records = [make_record(str(i), "t", Truth.NAILED) for i in range(4)]
        verdicts = {("d1", str(i)): vv(VerdictLabel.SUPPORTED if i < 3 else VerdictLabel.CONTRADICTED) for i in range(4)}
        assert audit_verifier(records, verdicts, min_overlap=4).status is AuditStatus.OK
