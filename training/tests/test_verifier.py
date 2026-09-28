import json
from datetime import UTC, datetime

import pytest

from nailed_it_training.protocol import EvidenceItem, SourceKind
from nailed_it_training.verifier import (
    CachingVerifier,
    KeywordVerifier,
    LlmCallError,
    LlmVerifier,
    OverCitedVerdictError,
    TraitRule,
    UngroundedVerdictError,
    VerdictLabel,
    VerifierResponseError,
    build_verifier_prompt,
    detect_restatement,
    evidence_set_hash,
    select_relevant,
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


def verdict_json(claim: str, label: str, cited: list[str], strength: float = 0.8) -> dict:
    return {"claim": claim, "label": label, "strength": strength, "citedIds": cited, "rationale": "because"}


def reply(label: str, cited: list[str], strength: float = 0.8) -> str:
    return json.dumps({"verdicts": [verdict_json("c0", label, cited, strength)]})


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
        [
            "not json",
            json.dumps({"verdicts": [{"claim": "c0", "label": "maybe", "strength": 0.5, "citedIds": [], "rationale": ""}]}),
            json.dumps({"verdicts": [{"claim": "c0", "label": "supported"}]}),
            json.dumps({"verdicts": []}),
            json.dumps({"label": "supported", "strength": 0.5, "citedIds": ["h1"], "rationale": ""}),
        ],
    )
    def test_malformed_response_raises(self, raw: str) -> None:
        with pytest.raises(VerifierResponseError):
            LlmVerifier(ScriptedClient(raw)).verify("x", HIDDEN)

    def test_empty_hidden_set_raises(self) -> None:
        with pytest.raises(ValueError):
            LlmVerifier(ScriptedClient(reply("unverifiable", []))).verify("x", [])

    def test_prompt_lists_every_hidden_id_and_demands_citations(self) -> None:
        system, user = build_verifier_prompt(["You work late at night.", "You skip standups."], HIDDEN)
        assert "h1" in user and "h2" in user
        assert "You work late at night." in user and "c1" in user
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


class TestBatching:
    def test_one_call_judges_several_claims(self) -> None:
        client = ScriptedClient(
            json.dumps({"verdicts": [verdict_json("c1", "contradicted", ["h2"]), verdict_json("c0", "supported", ["h1"])]})
        )
        verifier = LlmVerifier(client, batch_size=8)
        verdicts = verifier.verify_many(["You work late.", "You love 8am meetings."], HIDDEN)
        assert [v.label for v in verdicts] == [VerdictLabel.SUPPORTED, VerdictLabel.CONTRADICTED]
        assert len(client.calls) == 1
        assert verifier.stats.calls == 1 and verifier.stats.items == 2

    def test_missing_or_duplicate_claims_raise(self) -> None:
        missing = ScriptedClient(json.dumps({"verdicts": [verdict_json("c0", "supported", ["h1"])]}))
        with pytest.raises(VerifierResponseError, match="c1"):
            LlmVerifier(missing).verify_many(["a", "b"], HIDDEN)
        dup = ScriptedClient(json.dumps({"verdicts": [verdict_json("c0", "supported", ["h1"])] * 2}))
        with pytest.raises(VerifierResponseError):
            LlmVerifier(dup).verify_many(["a"], HIDDEN)

    def test_batches_are_split_by_batch_size(self) -> None:
        class Echo:
            def __init__(self) -> None:
                self.calls = 0

            def complete(self, system: str, user: str) -> str:
                self.calls += 1
                n = user.count('"claim": "c')
                return json.dumps({"verdicts": [verdict_json(f"c{i}", "unverifiable", [], 0.0) for i in range(n)]})

        client = Echo()
        assert len(LlmVerifier(client, batch_size=2).verify_many(["a", "b", "c", "d", "e"], HIDDEN)) == 5
        assert client.calls == 3


class TestCaching:
    def test_repeated_judgements_hit_the_cache(self) -> None:
        inner = KeywordVerifier(RULES)
        cached = CachingVerifier(inner)
        first = cached.verify_many(["after midnight", "collect stamps"], HIDDEN)
        second = cached.verify_many(["collect stamps", "after midnight"], HIDDEN)
        assert first == second[::-1]
        assert cached.stats.misses == 2 and cached.stats.hits == 2

    def test_different_evidence_set_is_a_different_key(self) -> None:
        cached = CachingVerifier(KeywordVerifier(RULES))
        cached.verify("after midnight", HIDDEN)
        cached.verify("after midnight", HIDDEN[:1])
        assert cached.stats.misses == 2

    def test_evidence_set_hash_ignores_order(self) -> None:
        assert evidence_set_hash(HIDDEN) == evidence_set_hash(list(reversed(HIDDEN)))


class TestRejectionMode:
    def test_training_mode_turns_an_ungrounded_verdict_into_a_counted_rejection(self) -> None:
        client = ScriptedClient(json.dumps({"verdicts": [verdict_json("c0", "supported", ["e5"]), verdict_json("c1", "supported", ["h1"])]}))
        verifier = LlmVerifier(client, on_ungrounded="reject")
        first, second = verifier.verify_many(["a", "b"], HIDDEN)
        assert first.label is VerdictLabel.UNVERIFIABLE
        assert first.cited_ids == []
        assert "rejected" in first.rationale and "e5" in first.rationale
        assert second.label is VerdictLabel.SUPPORTED
        assert verifier.stats.rejected == 1

    def test_default_mode_still_raises(self) -> None:
        client = ScriptedClient(json.dumps({"verdicts": [verdict_json("c0", "supported", ["e5"])]}))
        with pytest.raises(UngroundedVerdictError):
            LlmVerifier(client).verify_many(["a"], HIDDEN)

    def test_unknown_mode_is_an_error(self) -> None:
        with pytest.raises(ValueError):
            LlmVerifier(ScriptedClient("{}"), on_ungrounded="ignore")  # type: ignore[arg-type]


class TestStrictness:
    def test_more_than_three_citations_is_rejected(self) -> None:
        hidden = [EvidenceItem(id=f"h{i}", source=SourceKind.OTHER, text=f"item {i}") for i in range(6)]
        client = ScriptedClient(reply("supported", ["h0", "h1", "h2", "h3"]))
        with pytest.raises(OverCitedVerdictError):
            LlmVerifier(client).verify("x", hidden)

    def test_over_citation_in_reject_mode_becomes_unverifiable(self) -> None:
        hidden = [EvidenceItem(id=f"h{i}", source=SourceKind.OTHER, text=f"item {i}") for i in range(6)]
        client = ScriptedClient(reply("supported", ["h0", "h1", "h2", "h3"]))
        verifier = LlmVerifier(client, on_ungrounded="reject")
        assert verifier.verify("x", hidden).label is VerdictLabel.UNVERIFIABLE
        assert verifier.stats.rejected == 1

    def test_three_citations_are_fine(self) -> None:
        hidden = [EvidenceItem(id=f"h{i}", source=SourceKind.OTHER, text=f"item {i}") for i in range(6)]
        client = ScriptedClient(reply("supported", ["h0", "h1", "h2"]))
        assert LlmVerifier(client).verify("x", hidden).label is VerdictLabel.SUPPORTED

    def test_prompt_states_the_strict_contract(self) -> None:
        system, _ = build_verifier_prompt(["claim"], HIDDEN)
        lowered = system.lower()
        assert "at most 3" in lowered
        assert "surprising" in lowered
        assert "compatible" in lowered


class TestRelevanceSelection:
    def pool(self, prefix: str, texts: list[str]) -> list[EvidenceItem]:
        return [EvidenceItem(id=f"{prefix}{i}", source=SourceKind.OTHER, text=t) for i, t in enumerate(texts)]

    def test_returns_pool_unchanged_when_small(self) -> None:
        pool = self.pool("h", ["a", "b"])
        assert select_relevant(["claim"], pool, k=80) == pool

    def test_prefers_items_sharing_words_with_the_claims(self) -> None:
        pool = self.pool("h", ["weather report", "sea swim at dawn", "tax forms", "cold sea swim again", "lunch"])
        chosen = select_relevant(["You love a sea swim."], pool, k=2)
        assert {i.id for i in chosen} == {"h1", "h3"}

    def test_round_robin_gives_every_claim_its_best_items(self) -> None:
        pool = self.pool("h", ["cello lesson", "cello rosin", "cello strings", "marathon bib", "dog vet"])
        chosen = select_relevant(["You play the cello.", "You run a marathon."], pool, k=2)
        assert {i.id for i in chosen} == {"h0", "h3"}

    def test_is_deterministic_and_order_preserving(self) -> None:
        pool = self.pool("h", [f"word{i % 7} filler" for i in range(200)])
        a = select_relevant(["word3 word5"], pool, k=80)
        assert a == select_relevant(["word3 word5"], pool, k=80)
        assert len(a) == 80
        idx = [pool.index(i) for i in a]
        assert idx == sorted(idx)

    def test_selection_draws_only_from_the_hidden_pool_never_visible(self) -> None:
        from nailed_it_training.episodes import SplitConfig, build_episodes
        from nailed_it_training.synthetic import generate_personas

        digest = generate_personas(1, seed=3)[0].digest
        for episode in build_episodes(digest, SplitConfig(), seed=0):
            claims = [item.text for item in episode.visible[:5]]
            chosen = select_relevant(claims, episode.hidden, k=5)
            ids = {i.id for i in chosen}
            assert ids <= {i.id for i in episode.hidden}
            assert not ids & episode.visible_ids


class SequenceClient:
    def __init__(self, replies: list[str]) -> None:
        self.replies = replies
        self.calls = 0

    def complete(self, system: str, user: str) -> str:
        self.calls += 1
        return self.replies[min(self.calls - 1, len(self.replies) - 1)]


class TestBatchFailures:
    def test_reject_mode_retries_a_malformed_batch_once(self) -> None:
        client = SequenceClient(["garbage", reply("supported", ["h1"])])
        verifier = LlmVerifier(client, on_ungrounded="reject")
        assert verifier.verify("x", HIDDEN).label is VerdictLabel.SUPPORTED
        assert client.calls == 2 and verifier.stats.retries == 1

    def test_reject_mode_gives_up_after_one_retry_and_counts_it(self) -> None:
        client = SequenceClient(["garbage", "still garbage"])
        verifier = LlmVerifier(client, on_ungrounded="reject")
        verdicts = verifier.verify_many(["a", "b"], HIDDEN)
        assert [v.label for v in verdicts] == [VerdictLabel.UNVERIFIABLE] * 2
        assert all(v.rationale.startswith("rejected batch") for v in verdicts)
        assert client.calls == 2 and verifier.stats.rejected_batches == 1

    def test_raise_mode_does_not_retry(self) -> None:
        client = SequenceClient(["garbage", reply("supported", ["h1"])])
        with pytest.raises(VerifierResponseError):
            LlmVerifier(client).verify("x", HIDDEN)
        assert client.calls == 1


class FailingThenGood:
    def __init__(self, good: str, failures: int) -> None:
        self.good = good
        self.failures = failures
        self.calls = 0

    def complete(self, system: str, user: str) -> str:
        self.calls += 1
        if self.calls <= self.failures:
            raise LlmCallError("timed out")
        return self.good


class TestCallFailures:
    def test_reject_mode_retries_a_failed_call(self) -> None:
        client = FailingThenGood(reply("supported", ["h1"]), failures=1)
        verifier = LlmVerifier(client, on_ungrounded="reject")
        assert verifier.verify("x", HIDDEN).label is VerdictLabel.SUPPORTED
        assert verifier.stats.retries == 1

    def test_reject_mode_marks_batch_unverifiable_after_two_failures(self) -> None:
        verifier = LlmVerifier(FailingThenGood("", failures=5), on_ungrounded="reject")
        assert verifier.verify("x", HIDDEN).label is VerdictLabel.UNVERIFIABLE
        assert verifier.stats.rejected_batches == 1

    def test_raise_mode_propagates_call_errors(self) -> None:
        with pytest.raises(LlmCallError):
            LlmVerifier(FailingThenGood("", failures=1)).verify("x", HIDDEN)
