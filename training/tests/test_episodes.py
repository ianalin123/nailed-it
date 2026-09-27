from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from nailed_it_training.episodes import (
    EpisodeError,
    EpisodeKind,
    SplitConfig,
    UndatedPolicy,
    build_episodes,
    leave_one_source_out_episodes,
    temporal_episodes,
)
from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, SourceKind

T0 = datetime(2026, 1, 1, tzinfo=UTC)
SOURCES = [SourceKind.GIT_HISTORY, SourceKind.MEETING_NOTES, SourceKind.CALENDAR]


def make_digest(n_dated: int = 12, n_undated: int = 3, digest_id: str = "d1") -> EvidenceDigest:
    items = [
        EvidenceItem(id=f"e{i}", source=SOURCES[i % 3], text=f"item {i}", observedAt=T0 + timedelta(days=i)) for i in range(n_dated)
    ]
    items += [EvidenceItem(id=f"u{i}", source=SOURCES[i % 3], text=f"undated {i}") for i in range(n_undated)]
    return EvidenceDigest(protocolVersion=1, digestId=digest_id, displayName="Test Person", createdAt=T0, items=items)


def ids(items: list[EvidenceItem]) -> set[str]:
    return {i.id for i in items}


class TestTemporal:
    def test_visible_strictly_before_cutoff_and_hidden_at_or_after(self) -> None:
        episodes = temporal_episodes(make_digest(), SplitConfig(n_temporal=4), seed=1)
        assert len(episodes) == 4
        for ep in episodes:
            assert ep.kind is EpisodeKind.TEMPORAL
            assert ep.cutoff is not None
            assert all(i.observed_at is not None and i.observed_at < ep.cutoff for i in ep.visible)
            assert all(i.observed_at is None or i.observed_at >= ep.cutoff for i in ep.hidden)

    def test_undated_excluded_by_default(self) -> None:
        for ep in temporal_episodes(make_digest(), SplitConfig(), seed=0):
            assert not any(i.id.startswith("u") for i in ep.visible + ep.hidden)

    def test_undated_hidden_policy_puts_them_only_in_hidden(self) -> None:
        config = SplitConfig(undated=UndatedPolicy.HIDDEN)
        for ep in temporal_episodes(make_digest(), config, seed=0):
            assert {"u0", "u1", "u2"} <= ids(ep.hidden)
            assert not any(i.id.startswith("u") for i in ep.visible)

    def test_equal_timestamps_are_never_split(self) -> None:
        items = [EvidenceItem(id=f"e{i}", source=SourceKind.OTHER, text="x", observedAt=T0 + timedelta(days=i // 3)) for i in range(12)]
        digest = EvidenceDigest(protocolVersion=1, digestId="d", displayName="P", createdAt=T0, items=items)
        for ep in temporal_episodes(digest, SplitConfig(n_temporal=3), seed=0):
            vis_times = {i.observed_at for i in ep.visible}
            hid_times = {i.observed_at for i in ep.hidden}
            assert not vis_times & hid_times

    def test_too_few_dated_items_yields_no_temporal_episodes(self) -> None:
        assert temporal_episodes(make_digest(n_dated=3), SplitConfig(min_visible=3, min_hidden=2), seed=0) == []

    def test_deterministic_given_seed(self) -> None:
        d = make_digest(n_dated=40)
        a = temporal_episodes(d, SplitConfig(n_temporal=5), seed=7)
        b = temporal_episodes(d, SplitConfig(n_temporal=5), seed=7)
        c = temporal_episodes(d, SplitConfig(n_temporal=5), seed=8)
        assert a == b
        assert [e.cutoff for e in a] != [e.cutoff for e in c]


class TestLeaveOneSourceOut:
    def test_one_episode_per_source_with_that_source_hidden(self) -> None:
        episodes = leave_one_source_out_episodes(make_digest(), SplitConfig(min_visible=3, min_hidden=2))
        assert {e.held_out_source for e in episodes} == set(SOURCES)
        for ep in episodes:
            assert ep.kind is EpisodeKind.LEAVE_ONE_SOURCE_OUT
            assert all(i.source is ep.held_out_source for i in ep.hidden)
            assert all(i.source is not ep.held_out_source for i in ep.visible)

    def test_undated_items_participate_normally(self) -> None:
        episodes = leave_one_source_out_episodes(make_digest(), SplitConfig())
        seen = set().union(*(ids(e.visible) | ids(e.hidden) for e in episodes))
        assert {"u0", "u1", "u2"} <= seen

    def test_single_source_digest_yields_nothing(self) -> None:
        items = [EvidenceItem(id=f"e{i}", source=SourceKind.EMAIL, text="x") for i in range(10)]
        digest = EvidenceDigest(protocolVersion=1, digestId="d", displayName="P", createdAt=T0, items=items)
        assert leave_one_source_out_episodes(digest, SplitConfig()) == []


class TestBuildEpisodes:
    def test_rejects_duplicate_item_ids(self) -> None:
        digest = make_digest()
        dup = digest.model_copy(update={"items": [*digest.items, digest.items[0]]})
        with pytest.raises(EpisodeError, match="duplicate"):
            build_episodes(dup, SplitConfig(), seed=0)

    def test_raises_when_no_episode_is_possible(self) -> None:
        items = [EvidenceItem(id="e0", source=SourceKind.EMAIL, text="x")]
        digest = EvidenceDigest(protocolVersion=1, digestId="d", displayName="P", createdAt=T0, items=items)
        with pytest.raises(EpisodeError):
            build_episodes(digest, SplitConfig(), seed=0)

    def test_episode_ids_are_unique_and_stable(self) -> None:
        a = build_episodes(make_digest(n_dated=30), SplitConfig(n_temporal=4), seed=2)
        b = build_episodes(make_digest(n_dated=30), SplitConfig(n_temporal=4), seed=2)
        assert [e.episode_id for e in a] == [e.episode_id for e in b]
        assert len({e.episode_id for e in a}) == len(a)


@st.composite
def digests(draw: st.DrawFn) -> EvidenceDigest:
    n = draw(st.integers(min_value=1, max_value=60))
    items = []
    for i in range(n):
        dated = draw(st.booleans())
        day = draw(st.integers(min_value=0, max_value=30))
        items.append(
            EvidenceItem(
                id=f"e{i}",
                source=draw(st.sampled_from(list(SourceKind))),
                text="t",
                observedAt=(T0 + timedelta(days=day)) if dated else None,
            )
        )
    return EvidenceDigest(protocolVersion=1, digestId="d", displayName="P", createdAt=T0, items=items)


@settings(max_examples=150)
@given(
    digest=digests(),
    seed=st.integers(min_value=0, max_value=10_000),
    undated=st.sampled_from(list(UndatedPolicy)),
)
def test_no_item_is_ever_both_visible_and_hidden(digest: EvidenceDigest, seed: int, undated: UndatedPolicy) -> None:
    config = SplitConfig(n_temporal=6, min_visible=1, min_hidden=1, undated=undated)
    episodes = temporal_episodes(digest, config, seed) + leave_one_source_out_episodes(digest, config)
    for ep in episodes:
        assert not ids(ep.visible) & ids(ep.hidden)
        assert ep.visible and ep.hidden
        assert ids(ep.visible) | ids(ep.hidden) <= ids(list(digest.items))
