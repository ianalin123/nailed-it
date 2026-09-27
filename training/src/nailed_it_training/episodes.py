"""Split one person's digest into visible and hidden evidence (spec Idea 1)."""

import random
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, SourceKind


class EpisodeError(ValueError):
    pass


class EpisodeKind(StrEnum):
    TEMPORAL = "temporal"
    LEAVE_ONE_SOURCE_OUT = "leave_one_source_out"


class UndatedPolicy(StrEnum):
    """Where items without observedAt go in a temporal split.

    EXCLUDE: dropped from temporal episodes. Default, because an undated item may postdate the
    cutoff and would leak the future if shown.
    HIDDEN: verification-only. Never shown to the reader, so it cannot leak, but it may predate
    the cutoff, which weakens the "predict the future" framing.
    There is deliberately no VISIBLE option.
    """

    EXCLUDE = "exclude"
    HIDDEN = "hidden"


@dataclass(frozen=True)
class SplitConfig:
    n_temporal: int = 6
    min_visible: int = 3
    min_hidden: int = 2
    undated: UndatedPolicy = UndatedPolicy.EXCLUDE

    def __post_init__(self) -> None:
        if self.n_temporal < 0 or self.min_visible < 1 or self.min_hidden < 1:
            raise ValueError("n_temporal must be >= 0 and min_visible, min_hidden must be >= 1")


@dataclass(frozen=True)
class Episode:
    episode_id: str
    digest_id: str
    display_name: str
    kind: EpisodeKind
    visible: tuple[EvidenceItem, ...]
    hidden: tuple[EvidenceItem, ...]
    cutoff: datetime | None = None
    held_out_source: SourceKind | None = None

    @property
    def visible_ids(self) -> frozenset[str]:
        return frozenset(item.id for item in self.visible)


def _require_unique_ids(digest: EvidenceDigest) -> None:
    dupes = [item_id for item_id, n in Counter(i.id for i in digest.items).items() if n > 1]
    if dupes:
        raise EpisodeError(f"digest {digest.digest_id} has duplicate item ids: {sorted(dupes)}")


def _valid_cut_indices(dated: list[EvidenceItem], n_undated_hidden: int, config: SplitConfig) -> list[int]:
    n = len(dated)
    return [
        k
        for k in range(config.min_visible, n)
        if (n - k) + n_undated_hidden >= config.min_hidden and dated[k - 1].observed_at < dated[k].observed_at  # type: ignore[operator]
    ]


def temporal_episodes(digest: EvidenceDigest, config: SplitConfig, seed: int) -> list[Episode]:
    _require_unique_ids(digest)
    dated = sorted((i for i in digest.items if i.observed_at is not None), key=lambda i: (i.observed_at, i.id))
    undated = [i for i in digest.items if i.observed_at is None]
    undated_hidden = undated if config.undated is UndatedPolicy.HIDDEN else []
    candidates = _valid_cut_indices(dated, len(undated_hidden), config)
    rng = random.Random(f"{seed}:{digest.digest_id}:temporal")
    cuts = sorted(rng.sample(candidates, min(config.n_temporal, len(candidates))))
    episodes = []
    for k in cuts:
        cutoff = dated[k].observed_at
        assert cutoff is not None
        episodes.append(
            Episode(
                episode_id=f"{digest.digest_id}:temporal:{cutoff.isoformat()}",
                digest_id=digest.digest_id,
                display_name=digest.display_name,
                kind=EpisodeKind.TEMPORAL,
                visible=tuple(dated[:k]),
                hidden=tuple(dated[k:]) + tuple(undated_hidden),
                cutoff=cutoff,
            )
        )
    return episodes


def leave_one_source_out_episodes(digest: EvidenceDigest, config: SplitConfig) -> list[Episode]:
    _require_unique_ids(digest)
    present = {i.source for i in digest.items}
    episodes = []
    for source in (s for s in SourceKind if s in present):
        hidden = tuple(i for i in digest.items if i.source is source)
        visible = tuple(i for i in digest.items if i.source is not source)
        if len(visible) < config.min_visible or len(hidden) < config.min_hidden:
            continue
        episodes.append(
            Episode(
                episode_id=f"{digest.digest_id}:loso:{source.value}",
                digest_id=digest.digest_id,
                display_name=digest.display_name,
                kind=EpisodeKind.LEAVE_ONE_SOURCE_OUT,
                visible=visible,
                hidden=hidden,
                held_out_source=source,
            )
        )
    return episodes


def build_episodes(digest: EvidenceDigest, config: SplitConfig, seed: int) -> list[Episode]:
    episodes = temporal_episodes(digest, config, seed) + leave_one_source_out_episodes(digest, config)
    if not episodes:
        raise EpisodeError(
            f"digest {digest.digest_id} yields no episodes: needs {config.min_visible}+ visible and "
            f"{config.min_hidden}+ hidden items under a temporal or leave-one-source-out split"
        )
    return episodes
