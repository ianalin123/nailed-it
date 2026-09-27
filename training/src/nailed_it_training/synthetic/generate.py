"""Generate invented persona digests with known ground truth."""

import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, GuessCounts, Read, SourceKind, Truth, VerdictRecord
from nailed_it_training.synthetic.lexicon import DETAILS, FILLER, FIRST_NAMES, LAST_NAMES, LEXICON, Trait
from nailed_it_training.verifier import TraitRule

START = datetime(2025, 1, 1, tzinfo=UTC)
SPAN_DAYS = 540
UNDATED_RATE = 0.15
CONTRADICT_RATE = 0.5
SOURCES = [s for s in SourceKind if s is not SourceKind.OTHER]


@dataclass(frozen=True)
class Persona:
    digest: EvidenceDigest
    traits: frozenset[str]


def _draw_traits(rng: random.Random) -> frozenset[str]:
    held: set[str] = set()
    for trait in (t for t in LEXICON if t.signal is None):
        if rng.random() < trait.prevalence.value:
            held.add(trait.key)
    for trait in (t for t in LEXICON if t.signal is not None):
        p = trait.p_given_signal if trait.signal in held else trait.p_without_signal
        if rng.random() < p:
            held.add(trait.key)
    return frozenset(held)


def _when(rng: random.Random, trait: Trait | None) -> datetime:
    if trait is not None and trait.signal is not None:
        low, high = 0.7, 1.0
    elif trait is not None and any(t.signal == trait.key for t in LEXICON):
        low, high = 0.0, 0.6
    else:
        low, high = 0.0, 1.0
    return START + timedelta(days=SPAN_DAYS * rng.uniform(low, high), minutes=rng.randrange(1440))


def _texts(rng: random.Random, traits: frozenset[str]) -> list[tuple[str, Trait | None]]:
    texts: list[tuple[str, Trait | None]] = []
    for trait in LEXICON:
        if trait.key in traits:
            for _ in range(rng.randint(2, 3)):
                texts.append((f"{rng.choice(trait.support_phrases).capitalize()}. {rng.choice(DETAILS)}", trait))
        elif trait.contradict_phrases and rng.random() < CONTRADICT_RATE:
            texts.append((f"{rng.choice(trait.contradict_phrases).capitalize()}. {rng.choice(DETAILS)}", None))
    for _ in range(rng.randint(10, 16)):
        texts.append((rng.choice(FILLER), None))
    rng.shuffle(texts)
    return texts


def _persona(index: int, seed: int, rng: random.Random) -> Persona:
    traits = _draw_traits(rng)
    digest_id = f"synthetic-{seed}-{index:03d}"
    sources = SOURCES[:]
    rng.shuffle(sources)
    items = [
        EvidenceItem(
            id=f"{digest_id}-e{j:03d}",
            source=sources[j % len(sources)],
            text=text,
            observed_at=None if rng.random() < UNDATED_RATE else _when(rng, trait),
        )
        for j, (text, trait) in enumerate(_texts(rng, traits))
    ]
    name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
    digest = EvidenceDigest(protocol_version=1, digest_id=digest_id, display_name=name, created_at=START + timedelta(days=SPAN_DAYS), items=items)
    return Persona(digest=digest, traits=traits)


def generate_personas(n: int, seed: int) -> list[Persona]:
    rng = random.Random(f"personas:{seed}")
    return [_persona(i, seed, rng) for i in range(n)]


def keyword_rules() -> list[TraitRule]:
    return [
        TraitRule(read_phrase=t.read_text.lower(), support_phrases=t.support_phrases, contradict_phrases=t.contradict_phrases)
        for t in LEXICON
    ]


def _truth(held: bool, rng: random.Random, flip_rate: float, partly_rate: float) -> Truth:
    if rng.random() < partly_rate:
        return Truth.PARTLY
    correct = rng.random() >= flip_rate
    return Truth.NAILED if held == correct else Truth.OFF


def synthetic_verdicts(
    personas: list[Persona], *, reads_per_person: int, seed: int, flip_rate: float = 0.1, partly_rate: float = 0.1
) -> list[VerdictRecord]:
    if reads_per_person > len(LEXICON):
        raise ValueError(f"reads_per_person must be <= {len(LEXICON)}")
    rng = random.Random(f"verdicts:{seed}")
    records = []
    for persona in personas:
        digest = persona.digest
        for trait in rng.sample(LEXICON, reads_per_person):
            read = Read(
                id=f"{digest.digest_id}:{trait.key}",
                text=trait.read_text,
                category=trait.category,
                confidence=0.6,
                evidence_ids=[digest.items[0].id],
                hops=1,
                model_version="synthetic",
            )
            records.append(
                VerdictRecord(
                    protocol_version=1,
                    room_code="SYNT",
                    recorded_at=START + timedelta(days=SPAN_DAYS + 1),
                    digest_id=digest.digest_id,
                    read=read,
                    truth=_truth(trait.key in persona.traits, rng, flip_rate, partly_rate),
                    guess_counts=GuessCounts(nailed=rng.randint(0, 5), off=rng.randint(0, 5)),
                )
            )
    return records
