from nailed_it_training.protocol import EvidenceDigest, Truth
from nailed_it_training.synthetic import LEXICON, generate_personas, keyword_rules, synthetic_verdicts, trait_by_key
from nailed_it_training.synthetic.lexicon import Prevalence
from nailed_it_training.verifier import KeywordVerifier, VerdictLabel


def test_generation_is_deterministic_by_seed() -> None:
    a = generate_personas(5, seed=11)
    b = generate_personas(5, seed=11)
    c = generate_personas(5, seed=12)
    assert a == b
    assert a != c


def test_digests_validate_against_protocol() -> None:
    for persona in generate_personas(8, seed=0):
        digest = EvidenceDigest.model_validate_json(persona.digest.model_dump_json(by_alias=True))
        assert 1 <= len(digest.items) <= 400
        assert len({i.id for i in digest.items}) == len(digest.items)


def test_personas_mix_sources_and_include_undated_items() -> None:
    personas = generate_personas(6, seed=3)
    for p in personas:
        assert len({i.source for i in p.digest.items}) >= 3
    assert any(i.observed_at is None for p in personas for i in p.digest.items)


def test_evidence_is_consistent_with_ground_truth_traits() -> None:
    verifier = KeywordVerifier(keyword_rules())
    for persona in generate_personas(10, seed=5):
        for key in persona.traits:
            trait = trait_by_key(key)
            assert verifier.verify(trait.read_text, persona.digest.items).label is not VerdictLabel.CONTRADICTED


def test_barnum_traits_are_near_universal_and_rare_traits_are_rare() -> None:
    personas = generate_personas(200, seed=9)
    for trait in LEXICON:
        share = sum(trait.key in p.traits for p in personas) / len(personas)
        if trait.prevalence is Prevalence.UNIVERSAL:
            assert share > 0.85
        if trait.prevalence is Prevalence.RARE and trait.signal is None:
            assert share < 0.3


def test_display_names_are_marked_fictional_sources() -> None:
    for p in generate_personas(4, seed=1):
        assert p.digest.digest_id.startswith("synthetic-")


def test_synthetic_verdicts_follow_traits_with_noise() -> None:
    personas = generate_personas(20, seed=2)
    records = synthetic_verdicts(personas, reads_per_person=6, seed=0, flip_rate=0.0, partly_rate=0.0)
    by_digest = {p.digest.digest_id: p for p in personas}
    assert len(records) == 20 * 6
    for r in records:
        persona = by_digest[r.digest_id]
        key = next(t.key for t in LEXICON if t.read_text == r.read.text)
        assert r.truth is (Truth.NAILED if key in persona.traits else Truth.OFF)
