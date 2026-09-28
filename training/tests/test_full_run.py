from datetime import UTC, datetime, timedelta

import pytest

from nailed_it_training.full_run import CUTOFF, HELDOUT_SOURCE, PROMPT_VISIBLE, StageError, split
from nailed_it_training.protocol import EvidenceDigest, EvidenceItem, SourceKind


def invented_digest(n_pre: int = 170, n_post: int = 90, n_git: int = 85) -> EvidenceDigest:
    t0 = CUTOFF - timedelta(days=90)
    items = []
    sources = [SourceKind.CLAUDE_SESSIONS, SourceKind.CLAUDE_MEMORY, SourceKind.PROJECT_FILES]
    for i in range(n_pre):
        items.append(EvidenceItem(id=f"p{i}", source=sources[i % 3], text=f"pre {i}", observed_at=t0 + timedelta(hours=12 * i)))
    for i in range(n_post):
        items.append(EvidenceItem(id=f"q{i}", source=sources[i % 3], text=f"post {i}", observed_at=CUTOFF + timedelta(hours=6 * i)))
    for i in range(n_git):
        items.append(EvidenceItem(id=f"g{i}", source=SourceKind.GIT_HISTORY, text=f"git {i}", observed_at=t0 + timedelta(days=i)))
    return EvidenceDigest(protocol_version=1, digest_id="invented", display_name="Nobody", created_at=datetime(2026, 9, 27, tzinfo=UTC), items=items)


def test_split_holds_out_later_items_and_a_whole_source() -> None:
    training, benchmark, training_digest = split(invented_digest())
    train_ids = {i.id for i in training_digest.items}
    assert all(i.observed_at < CUTOFF and i.source is not HELDOUT_SOURCE for i in training_digest.items)
    temporal, source = benchmark.episodes
    assert {i.id for i in temporal.hidden} == {f"q{i}" for i in range(90)}
    assert {i.id for i in source.hidden} == {f"g{i}" for i in range(85)}
    assert len(temporal.visible) == PROMPT_VISIBLE
    for episode in training:
        ids = {i.id for i in (*episode.visible, *episode.hidden)}
        assert ids <= train_ids
        assert len(episode.visible) <= PROMPT_VISIBLE
    for bench in benchmark.episodes:
        assert not {i.id for i in bench.hidden} & train_ids


def test_split_refuses_when_too_small() -> None:
    with pytest.raises(StageError):
        split(invented_digest(n_post=40))
