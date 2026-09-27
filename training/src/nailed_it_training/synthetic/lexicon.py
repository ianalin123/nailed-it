"""Invented traits for invented people. Nothing here describes a real person."""

from dataclasses import dataclass
from enum import Enum

from nailed_it_training.protocol import ReadCategory


class Prevalence(Enum):
    UNIVERSAL = 0.95
    COMMON = 0.5
    RARE = 0.1


@dataclass(frozen=True)
class Trait:
    key: str
    read_text: str
    category: ReadCategory
    prevalence: Prevalence
    support_phrases: tuple[str, ...]
    contradict_phrases: tuple[str, ...] = ()
    signal: str | None = None
    p_given_signal: float = 0.8
    p_without_signal: float = 0.04


LEXICON: tuple[Trait, ...] = (
    Trait(
        key="doubt",
        read_text="You sometimes doubt whether your work is good enough.",
        category=ReadCategory.AMBITION_PSYCHOLOGY,
        prevalence=Prevalence.UNIVERSAL,
        support_phrases=("not sure this is good enough", "probably needs another pass"),
        contradict_phrases=("never second-guess my drafts",),
    ),
    Trait(
        key="backlog",
        read_text="You have more ideas than time to finish them.",
        category=ReadCategory.WORK_STYLE,
        prevalence=Prevalence.UNIVERSAL,
        support_phrases=("backlog of half-finished ideas", "another side project parked"),
        contradict_phrases=("finished every project on the list",),
    ),
    Trait(
        key="night",
        read_text="You do your best work after midnight.",
        category=ReadCategory.WORK_STYLE,
        prevalence=Prevalence.COMMON,
        support_phrases=("pushed a fix at 01", "still coding at 3am", "committed at 02"),
        contradict_phrases=("asleep by 10pm", "first commit at 6am"),
    ),
    Trait(
        key="notebook",
        read_text="You keep your ideas in a paper notebook.",
        category=ReadCategory.INTELLECTUAL_SIGNATURE,
        prevalence=Prevalence.COMMON,
        support_phrases=("scanned a notebook page", "sketched it by hand first"),
        contradict_phrases=("never write anything by hand",),
    ),
    Trait(
        key="async",
        read_text="You avoid live meetings when you can.",
        category=ReadCategory.PEOPLE_SOCIAL,
        prevalence=Prevalence.COMMON,
        support_phrases=("declined the standup", "asked to move this to a doc"),
        contradict_phrases=("scheduled another sync call", "love a quick huddle"),
    ),
    Trait(
        key="rustacean",
        read_text="You write Rust for fun.",
        category=ReadCategory.TECHNICAL_IDENTITY,
        prevalence=Prevalence.COMMON,
        support_phrases=("cargo build on the toy parser", "weekend rust experiment"),
        contradict_phrases=("never touched rust",),
    ),
    Trait(
        key="rewrite",
        read_text="You are about to rewrite a working tool in Rust.",
        category=ReadCategory.RISKY_READ,
        prevalence=Prevalence.RARE,
        support_phrases=("rewrote the cli in rust", "port to rust started"),
        signal="rustacean",
    ),
    Trait(
        key="sibling",
        read_text="You talk to your sister most weeks.",
        category=ReadCategory.PEOPLE_SOCIAL,
        prevalence=Prevalence.COMMON,
        support_phrases=("call with my sister", "sister sent the photos"),
        contradict_phrases=("only child",),
    ),
    Trait(
        key="trip_home",
        read_text="You are planning a trip home soon.",
        category=ReadCategory.LIFE_LOGISTICS,
        prevalence=Prevalence.RARE,
        support_phrases=("booked flights home", "packing list for the trip home"),
        signal="sibling",
    ),
    Trait(
        key="synth",
        read_text="You make music on modular synths.",
        category=ReadCategory.TASTE_AESTHETICS,
        prevalence=Prevalence.COMMON,
        support_phrases=("patched the eurorack", "recorded a synth loop"),
        contradict_phrases=("no instruments at home",),
    ),
    Trait(
        key="new_module",
        read_text="You are about to buy another synth module.",
        category=ReadCategory.RISKY_READ,
        prevalence=Prevalence.RARE,
        support_phrases=("ordered a new module", "module wishlist updated"),
        signal="synth",
    ),
    Trait(
        key="ai_pair",
        read_text="You treat AI as a pair programmer, not a search box.",
        category=ReadCategory.RELATIONSHIP_WITH_AI,
        prevalence=Prevalence.COMMON,
        support_phrases=("asked claude to review my plan", "long session refactoring with claude"),
        contradict_phrases=("turned off the ai assistant",),
    ),
)

FILLER: tuple[str, ...] = (
    "Reviewed a pull request for the billing page.",
    "Lunch with the team at the noodle place.",
    "Updated dependencies and reran the tests.",
    "Renamed a few files in the docs folder.",
    "Wrote a short status update for the week.",
    "Fixed a typo in the onboarding guide.",
    "Moved the retro to Thursday.",
    "Cleaned up old branches.",
    "Read a paper on caching strategies.",
    "Answered a question in the support channel.",
)

DETAILS: tuple[str, ...] = (
    "Noted in passing.",
    "Mentioned twice that week.",
    "Left as a comment on the ticket.",
    "Written in the daily log.",
    "Came up during planning.",
)

FIRST_NAMES: tuple[str, ...] = ("Tamsin", "Oren", "Ilka", "Bexley", "Cato", "Marisol", "Pell", "Yarrow", "Juno", "Dace", "Ottilie", "Rune")
LAST_NAMES: tuple[str, ...] = ("Vell", "Quarrington", "Asphodel", "Brisk", "Nettlefold", "Oakhurst", "Tarrant", "Wexley", "Lumen", "Harrow")


def trait_by_key(key: str) -> Trait:
    for trait in LEXICON:
        if trait.key == key:
            return trait
    raise KeyError(f"unknown trait {key!r}")
