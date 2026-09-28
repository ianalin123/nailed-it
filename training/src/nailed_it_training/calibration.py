"""Fixed calibration set for verifiers: invented claims and invented evidence with known answers.

Four kinds. SUPPORTED and CONTRADICTED items contain one piece of evidence that would be surprising if the
claim were false (or true). COMPATIBLE items contain evidence that fits the claim but would be unremarkable
either way, so the right verdict is unverifiable. UNRELATED items contain nothing bearing on the claim.
Nobody here is real.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from nailed_it_training.protocol import EvidenceItem, SourceKind
from nailed_it_training.verifier import LlmCallError, TraitRule, VerdictLabel, Verifier

PASS_THRESHOLD = 0.8


class CalibrationKind(StrEnum):
    SUPPORTED = "supported"
    CONTRADICTED = "contradicted"
    COMPATIBLE = "compatible"
    UNRELATED = "unrelated"


_EXPECTED = {
    CalibrationKind.SUPPORTED: VerdictLabel.SUPPORTED,
    CalibrationKind.CONTRADICTED: VerdictLabel.CONTRADICTED,
    CalibrationKind.COMPATIBLE: VerdictLabel.UNVERIFIABLE,
    CalibrationKind.UNRELATED: VerdictLabel.UNVERIFIABLE,
}

_FILLER = (
    "Updated the Q3 roadmap doc with two new milestones.",
    "Standup notes: blocked on staging API keys until Wednesday.",
    "Renamed the staging bucket and fixed the deploy script.",
    "Reviewed a pull request that adds retries to the webhook handler.",
    "Moved the design review to 3pm.",
)


@dataclass(frozen=True)
class CalibrationItem:
    item_id: str
    kind: CalibrationKind
    claim: str
    key_evidence: str | None
    keyword: str = ""
    evidence: tuple[EvidenceItem, ...] = field(default=())

    @property
    def expected(self) -> VerdictLabel:
        return _EXPECTED[self.kind]


def _item(item_id: str, kind: CalibrationKind, claim: str, key_evidence: str | None, keyword: str = "") -> CalibrationItem:
    texts = ([key_evidence] if key_evidence else []) + list(_FILLER[:3])
    evidence = tuple(EvidenceItem(id=f"{item_id}-e{i}", source=SourceKind.OTHER, text=t) for i, t in enumerate(texts))
    return CalibrationItem(item_id, kind, claim, key_evidence, keyword, evidence)


S, C, M, U = CalibrationKind.SUPPORTED, CalibrationKind.CONTRADICTED, CalibrationKind.COMPATIBLE, CalibrationKind.UNRELATED

CALIBRATION_SET: tuple[CalibrationItem, ...] = (
    _item("s1", S, "You are training for a marathon.", "Registered for the Lisbon Marathon, bib 4471; long run today was 32 km.", "lisbon marathon"),
    _item("s2", S, "You play the cello.", "Cello lesson moved to Thursday; bring the Bach suite and new rosin.", "cello lesson"),
    _item("s3", S, "You are learning Japanese.", "Anki streak 212 days on the JLPT N3 Japanese vocabulary deck.", "jlpt n3"),
    _item("s4", S, "You have a dog.", "Vet invoice: annual vaccinations for Biscuit, my beagle, age 4.", "my beagle"),
    _item("s5", S, "You write Rust at work.", "Merged PR #812 in the team repo: port the ingest service from Go to Rust.", "go to rust"),
    _item("c1", C, "You don't drink coffee.", "Ordered my second double espresso of the morning before the 9am.", "double espresso"),
    _item("c2", C, "You live alone.", "My roommate Priya asked who finished the oat milk again.", "my roommate"),
    _item("c3", C, "You have never been to Japan.", "Sorting photos from my 2024 Kyoto trip: Fushimi Inari at dawn.", "kyoto trip"),
    _item("c4", C, "You avoid public speaking.", "Gave the opening keynote at DevConf to about 800 people; slides attached.", "opening keynote"),
    _item("c5", C, "You work at a large company.", "Payroll for our four-person startup ran late again this month.", "four-person startup"),
    _item("m1", M, "You are a morning person.", "Sent the weekly report at 8:45am."),
    _item("m2", M, "You love Italian food.", "Team lunch today was at the Italian place next to the office."),
    _item("m3", M, "You are an introvert.", "Skipped Friday drinks to finish the deadline."),
    _item("m4", M, "You read a lot of fiction.", "Bought a paperback novel at the airport."),
    _item("m5", M, "You are anxious about money.", "Opened the budget spreadsheet to add last month's receipts."),
    _item("u1", U, "You grew up near the sea.", None),
    _item("u2", U, "You have a sister.", None),
    _item("u3", U, "You play chess.", None),
    _item("u4", U, "You are allergic to cats.", None),
    _item("u5", U, "You speak Portuguese.", None),
)


def calibration_rules() -> list[TraitRule]:
    """Keyword rules under which the test double answers every item correctly."""
    rules = []
    for item in CALIBRATION_SET:
        if item.kind is CalibrationKind.SUPPORTED:
            rules.append(TraitRule(read_phrase=item.claim.lower(), support_phrases=(item.keyword,), contradict_phrases=()))
        elif item.kind is CalibrationKind.CONTRADICTED:
            rules.append(TraitRule(read_phrase=item.claim.lower(), support_phrases=(), contradict_phrases=(item.keyword,)))
    return rules


@dataclass(frozen=True)
class CalibrationResult:
    correct: int
    total: int
    by_kind: dict[CalibrationKind, float]
    details: tuple[tuple[str, str, str], ...]
    errors: tuple[str, ...]

    @property
    def accuracy(self) -> float:
        return self.correct / self.total

    @property
    def passed(self) -> bool:
        return self.accuracy >= PASS_THRESHOLD


def score_verifier(verifier: Verifier, items: Sequence[CalibrationItem] = CALIBRATION_SET) -> CalibrationResult:
    """One verify call per item. A verifier error (bad JSON, bad citations, truncation) counts as wrong and is listed."""
    details: list[tuple[str, str, str]] = []
    errors: list[str] = []
    hits: dict[CalibrationKind, list[bool]] = {k: [] for k in CalibrationKind}
    for item in items:
        try:
            got = verifier.verify(item.claim, list(item.evidence)).label.value
        except (ValueError, LlmCallError) as err:
            got = "error"
            errors.append(f"{item.item_id}: {type(err).__name__}: {err}")
        ok = got == item.expected.value
        hits[item.kind].append(ok)
        details.append((item.item_id, item.expected.value, got))
    by_kind = {k: sum(v) / len(v) for k, v in hits.items() if v}
    correct = sum(sum(v) for v in hits.values())
    return CalibrationResult(correct, len(items), by_kind, tuple(details), tuple(errors))
