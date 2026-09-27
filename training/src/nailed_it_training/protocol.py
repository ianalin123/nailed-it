"""Pydantic mirror of packages/protocol/src/index.ts. Keep field-for-field in sync."""

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field
from pydantic.alias_generators import to_camel

PROTOCOL_VERSION = 1
MAX_READ_LENGTH = 240
MAX_CHAIN_STEPS = 6


def _require_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("datetime must be UTC with a Z designator, matching zod .datetime()")
    return value.astimezone(UTC)


def _reject_offset_strings(value: object) -> object:
    if isinstance(value, str) and not value.endswith("Z"):
        raise ValueError("datetime string must end in Z, matching zod .datetime()")
    return value


UtcDatetime = Annotated[datetime, BeforeValidator(_reject_offset_strings), AfterValidator(_require_utc)]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class SourceKind(StrEnum):
    CLAUDE_SESSIONS = "claude_sessions"
    CLAUDE_MEMORY = "claude_memory"
    GIT_HISTORY = "git_history"
    PROJECT_FILES = "project_files"
    MEETING_NOTES = "meeting_notes"
    CALENDAR = "calendar"
    EMAIL = "email"
    OTHER = "other"


class ReadCategory(StrEnum):
    WORK_STYLE = "work_style"
    TECHNICAL_IDENTITY = "technical_identity"
    INTELLECTUAL_SIGNATURE = "intellectual_signature"
    AMBITION_PSYCHOLOGY = "ambition_psychology"
    TASTE_AESTHETICS = "taste_aesthetics"
    PEOPLE_SOCIAL = "people_social"
    LIFE_LOGISTICS = "life_logistics"
    RELATIONSHIP_WITH_AI = "relationship_with_ai"
    RISKY_READ = "risky_read"


class Truth(StrEnum):
    NAILED = "nailed"
    PARTLY = "partly"
    OFF = "off"


class EvidenceItem(_Model):
    id: str = Field(min_length=1)
    source: SourceKind
    text: str = Field(min_length=1, max_length=600)
    observed_at: UtcDatetime | None = None


class EvidenceDigest(_Model):
    protocol_version: Literal[1]
    digest_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1, max_length=40)
    created_at: UtcDatetime
    items: list[EvidenceItem] = Field(min_length=1, max_length=400)


class ChainKind(StrEnum):
    EVIDENCE = "evidence"
    INFERENCE = "inference"


class ChainStep(_Model):
    kind: ChainKind
    text: str = Field(min_length=1, max_length=MAX_READ_LENGTH)


class Read(_Model):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=MAX_READ_LENGTH)
    category: ReadCategory
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_ids: list[str] = Field(max_length=12)
    hops: int = Field(ge=0, le=5)
    model_version: str = Field(min_length=1)
    chain: list[ChainStep] | None = Field(default=None, max_length=MAX_CHAIN_STEPS)


class Deck(_Model):
    protocol_version: Literal[1]
    digest_id: str = Field(min_length=1)
    reads: list[Read] = Field(min_length=3, max_length=30)


class GuessCounts(_Model):
    nailed: int = Field(ge=0)
    off: int = Field(ge=0)


class VerdictRecord(_Model):
    protocol_version: Literal[1]
    room_code: str
    recorded_at: UtcDatetime
    digest_id: str
    read: Read
    truth: Truth
    guess_counts: GuessCounts


def evidence_payload(items: "list[EvidenceItem] | tuple[EvidenceItem, ...]") -> list[dict[str, str | None]]:
    return [
        {"id": i.id, "source": i.source.value, "observedAt": i.observed_at.isoformat() if i.observed_at else None, "text": i.text}
        for i in items
    ]
