import json

import pytest

from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.reader import MalformedDeckError, parse_reads, render_reader_prompt
from nailed_it_training.synthetic import generate_personas


def episode():
    persona = generate_personas(1, seed=0)[0]
    return build_episodes(persona.digest, SplitConfig(), seed=0)[0]


def read_json(i: int) -> dict:
    return {"id": f"r{i}", "text": f"Read {i}", "category": "work_style", "confidence": 0.6, "evidenceIds": ["e1"], "hops": 1}


def test_prompt_contains_visible_but_never_hidden_items() -> None:
    ep = episode()
    system, user = render_reader_prompt(ep)
    assert all(item.id in user for item in ep.visible)
    assert not any(item.id in user for item in ep.hidden)
    assert "evidenceIds" in system
    assert "confidence" in system


def test_parses_reads_and_stamps_model_version() -> None:
    reads = parse_reads(json.dumps({"reads": [read_json(i) for i in range(3)]}), model_version="m1")
    assert [r.id for r in reads] == ["r0", "r1", "r2"]
    assert all(r.model_version == "m1" for r in reads)


def test_strips_reasoning_block_and_code_fence() -> None:
    raw = "<think>hmm</think>\n```json\n" + json.dumps({"reads": [read_json(i) for i in range(3)]}) + "\n```"
    assert len(parse_reads(raw, model_version="m")) == 3


@pytest.mark.parametrize(
    "raw",
    [
        "no json here",
        json.dumps({"reads": [read_json(0)]}),
        json.dumps({"reads": [{**read_json(i), "confidence": 2} for i in range(3)]}),
        json.dumps({"notreads": []}),
    ],
)
def test_malformed_completions_raise(raw: str) -> None:
    with pytest.raises(MalformedDeckError):
        parse_reads(raw, model_version="m")
