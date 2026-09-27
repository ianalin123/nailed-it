import json

import pytest
from pydantic import ValidationError

from nailed_it_training.protocol import (
    PROTOCOL_VERSION,
    ChainKind,
    Deck,
    EvidenceDigest,
    Read,
    ReadCategory,
    SourceKind,
    Truth,
    VerdictRecord,
)

READ_JSON = {
    "id": "r1",
    "text": "You think by talking out loud, alone, into a recorder.",
    "category": "work_style",
    "confidence": 0.7,
    "evidenceIds": ["e1"],
    "hops": 2,
    "modelVersion": "teacher-v0",
}

DIGEST_JSON = """
{
  "protocolVersion": 1,
  "digestId": "d1",
  "displayName": "Wren Okafor",
  "createdAt": "2026-09-27T23:00:00.000Z",
  "items": [
    {"id": "e1", "source": "git_history", "text": "Committed at 02:14 again.", "observedAt": "2026-03-01T02:14:00Z"},
    {"id": "e2", "source": "meeting_notes", "text": "Asked to move standup later."}
  ]
}
"""

VERDICT_JSON = json.dumps(
    {
        "protocolVersion": 1,
        "roomCode": "ABCD",
        "recordedAt": "2026-09-27T23:00:00.000Z",
        "digestId": "d1",
        "read": READ_JSON,
        "truth": "nailed",
        "guessCounts": {"nailed": 2, "off": 3},
    }
)


def test_parses_digest_matching_typescript_schema() -> None:
    digest = EvidenceDigest.model_validate_json(DIGEST_JSON)
    assert digest.protocol_version == PROTOCOL_VERSION
    assert digest.items[0].source is SourceKind.GIT_HISTORY
    assert digest.items[0].observed_at is not None
    assert digest.items[1].observed_at is None


def test_parses_verdict_record_and_round_trips_with_camel_case() -> None:
    record = VerdictRecord.model_validate_json(VERDICT_JSON)
    assert record.truth is Truth.NAILED
    assert record.read.category is ReadCategory.WORK_STYLE
    assert record.read.evidence_ids == ["e1"]
    dumped = json.loads(record.model_dump_json(by_alias=True))
    assert dumped["read"]["evidenceIds"] == ["e1"]
    assert dumped["guessCounts"] == {"nailed": 2, "off": 3}
    assert VerdictRecord.model_validate(dumped) == record


def test_rejects_confidence_outside_unit_interval() -> None:
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "confidence": 1.2})


def test_rejects_non_integer_hops_and_hops_above_five() -> None:
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "hops": 1.5})
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "hops": 6})


def test_rejects_read_text_over_240_chars() -> None:
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "text": "x" * 241})


def test_deck_requires_three_to_thirty_reads() -> None:
    read = Read.model_validate(READ_JSON)
    with pytest.raises(ValidationError):
        Deck(protocolVersion=1, digestId="d1", reads=[read])
    Deck(protocolVersion=1, digestId="d1", reads=[read, read, read])


def test_rejects_wrong_protocol_version() -> None:
    data = json.loads(DIGEST_JSON)
    data["protocolVersion"] = 2
    with pytest.raises(ValidationError):
        EvidenceDigest.model_validate(data)


def test_rejects_datetime_without_utc_designator_like_zod() -> None:
    data = json.loads(DIGEST_JSON)
    data["items"][0]["observedAt"] = "2026-03-01T02:14:00"
    with pytest.raises(ValidationError):
        EvidenceDigest.model_validate(data)
    data["items"][0]["observedAt"] = "2026-03-01T02:14:00+02:00"
    with pytest.raises(ValidationError):
        EvidenceDigest.model_validate(data)


def test_rejects_unknown_source_kind() -> None:
    data = json.loads(DIGEST_JSON)
    data["items"][0]["source"] = "diary"
    with pytest.raises(ValidationError):
        EvidenceDigest.model_validate(data)


def test_read_accepts_optional_chain_matching_typescript() -> None:
    chain = [{"kind": "evidence", "text": "[e1] Committed at 02:14 again."}, {"kind": "inference", "text": "Works late."}]
    read = Read.model_validate({**READ_JSON, "chain": chain})
    assert read.chain is not None
    assert read.chain[0].kind is ChainKind.EVIDENCE
    assert Read.model_validate(READ_JSON).chain is None
    dumped = json.loads(read.model_dump_json(by_alias=True, exclude_none=True))
    assert dumped["chain"] == chain


def test_chain_is_capped_at_six_steps_and_240_chars() -> None:
    step = {"kind": "inference", "text": "x"}
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "chain": [step] * 7})
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "chain": [{"kind": "inference", "text": "x" * 241}]})
    with pytest.raises(ValidationError):
        Read.model_validate({**READ_JSON, "chain": [{"kind": "guess", "text": "x"}]})
