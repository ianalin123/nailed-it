import json
from datetime import UTC, datetime

import pytest

from nailed_it_training.protocol import EvidenceItem, SourceKind
from nailed_it_training.verifier import (
    KeywordVerifier,
    LlmVerifier,
    TraitRule,
    UngroundedVerdictError,
    VerdictLabel,
    VerifierResponseError,
    build_verifier_prompt,
    detect_restatement,
)

HIDDEN = [
    EvidenceItem(id="h1", source=SourceKind.GIT_HISTORY, text="Pushed a fix at 03:10.", observedAt=datetime(2026, 5, 1, tzinfo=UTC)),
    EvidenceItem(id="h2", source=SourceKind.CALENDAR, text="Declined the 8am sync."),
]


class ScriptedClient:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.reply


def reply(label: str, cited: list[str], strength: float = 0.8) -> str:
    return json.dumps({"label": label, "strength": strength, "citedIds": cited, "rationale": "because"})


class TestLlmVerifier:
    def test_parses_supported_verdict_with_valid_citations(self) -> None:
        client = ScriptedClient(reply("supported", ["h1"]))
        verdict = LlmVerifier(client).verify("You work late at night.", HIDDEN)
        assert verdict.label is VerdictLabel.SUPPORTED
        assert verdict.cited_ids == ["h1"]
        assert verdict.strength == 0.8

    def test_accepts_json_inside_a_code_fence(self) -> None:
        client = ScriptedClient("```json\n" + reply("contradicted", ["h2"]) + "\n```")
        assert LlmVerifier(client).verify("You love early meetings.", HIDDEN).label is VerdictLabel.CONTRADICTED

    def test_rejects_citation_outside_hidden_set(self) -> None:
        client = ScriptedClient(reply("supported", ["h1", "v9"]))
        with pytest.raises(UngroundedVerdictError, match="v9"):
            LlmVerifier(client).verify("You work late.", HIDDEN)

    def test_rejects_decided_verdict_without_citations(self) -> None:
        client = ScriptedClient(reply("supported", []))
        with pytest.raises(UngroundedVerdictError):
            LlmVerifier(client).verify("You work late.", HIDDEN)

    def test_unverifiable_may_cite_nothing(self) -> None:
        client = ScriptedClient(reply("unverifiable", [], 0.0))
        assert LlmVerifier(client).verify("You own a cat.", HIDDEN).label is VerdictLabel.UNVERIFIABLE

    @pytest.mark.parametrize(
        "raw",
        ["not json", json.dumps({"label": "maybe", "strength": 0.5, "citedIds": [], "rationale": ""}), json.dumps({"label": "supported"})],
    )
    def test_malformed_response_raises(self, raw: str) -> None:
        with pytest.raises(VerifierResponseError):
            LlmVerifier(ScriptedClient(raw)).verify("x", HIDDEN)

    def test_empty_hidden_set_raises(self) -> None:
        with pytest.raises(ValueError):
            LlmVerifier(ScriptedClient(reply("unverifiable", []))).verify("x", [])

    def test_prompt_lists_every_hidden_id_and_demands_citations(self) -> None:
        system, user = build_verifier_prompt("You work late at night.", HIDDEN)
        assert "h1" in user and "h2" in user
        assert "You work late at night." in user
        assert "citedIds" in system
        assert "only" in system.lower()
        assert "not instructions" in system.lower()


RULES = [
    TraitRule(
        read_phrase="after midnight",
        support_phrases=("pushed a fix at 03", "committed at 02"),
        contradict_phrases=("asleep by 10pm",),
    )
]


class TestKeywordVerifier:
    def test_supported_when_hidden_contains_support_phrase(self) -> None:
        verdict = KeywordVerifier(RULES).verify("You do your best work after midnight.", HIDDEN)
        assert verdict.label is VerdictLabel.SUPPORTED
        assert verdict.cited_ids == ["h1"]

    def test_contradicted_when_hidden_contains_contradicting_phrase(self) -> None:
        hidden = [EvidenceItem(id="h9", source=SourceKind.OTHER, text="Always asleep by 10pm.")]
        assert KeywordVerifier(RULES).verify("You do your best work after midnight.", hidden).label is VerdictLabel.CONTRADICTED

    def test_unverifiable_when_no_rule_matches_read(self) -> None:
        assert KeywordVerifier(RULES).verify("You collect stamps.", HIDDEN).label is VerdictLabel.UNVERIFIABLE

    def test_is_deterministic(self) -> None:
        v = KeywordVerifier(RULES)
        assert v.verify("after midnight", HIDDEN) == v.verify("after midnight", HIDDEN)


def test_detect_restatement_requires_single_strong_citation() -> None:
    visible = [EvidenceItem(id="v1", source=SourceKind.GIT_HISTORY, text="Committed at 02:40.")]
    assert detect_restatement("You work after midnight.", visible, KeywordVerifier(RULES), min_strength=0.5)
    two = visible + [EvidenceItem(id="v2", source=SourceKind.GIT_HISTORY, text="Pushed a fix at 03:15.")]
    assert not detect_restatement("You work after midnight.", two, KeywordVerifier(RULES), min_strength=0.5)
    assert not detect_restatement("You collect stamps.", visible, KeywordVerifier(RULES), min_strength=0.5)
