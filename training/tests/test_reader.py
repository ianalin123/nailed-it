import json

import pytest

from nailed_it_training.episodes import SplitConfig, build_episodes
from nailed_it_training.reader import MalformedDeckError, parse_deck, parse_reads, render_reader_prompt
from nailed_it_training.synthetic import generate_personas


def episode():
    persona = generate_personas(1, seed=0)[0]
    return build_episodes(persona.digest, SplitConfig(), seed=0)[0]


def read_json(i: int) -> dict:
    chain = [{"kind": "evidence", "text": "[e1] quote"}, {"kind": "inference", "text": "so"}]
    return {"id": f"r{i}", "text": f"Read {i}", "category": "work_style", "confidence": 0.6, "evidenceIds": ["e1"], "hops": 1, "chain": chain}


def test_prompt_contains_visible_but_never_hidden_items() -> None:
    ep = episode()
    system, user = render_reader_prompt(ep)
    assert all(item.id in user for item in ep.visible)
    assert not any(item.id in user for item in ep.hidden)
    assert "evidenceIds" in system
    assert "confidence" in system
    assert "chain" in system and "exactly 12" in system


def test_parses_reads_and_stamps_model_version() -> None:
    reads = parse_reads(json.dumps({"reads": [read_json(i) for i in range(3)]}), model_version="m1")
    assert [r.id for r in reads] == ["r0", "r1", "r2"]
    assert all(r.model_version == "m1" for r in reads)
    assert all(r.chain is not None and r.chain[0].text.startswith("[e1]") for r in reads)


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
        json.dumps({"reads": [{k: v for k, v in read_json(i).items() if k != "chain"} for i in range(3)]}),
        json.dumps({"reads": [{**read_json(i), "chain": [{"kind": "inference", "text": "x"}] * 7} for i in range(3)]}),
    ],
)
def test_malformed_completions_raise(raw: str) -> None:
    with pytest.raises(MalformedDeckError):
        parse_reads(raw, model_version="m")


class TestLenientParse:
    def test_invalid_reads_are_dropped_and_reported_not_fatal(self) -> None:
        reads = [read_json(i) for i in range(4)]
        reads[1] = {**reads[1], "text": "x" * 300}
        reads[2] = {**reads[2], "chain": [{"kind": "inference", "text": "y"}] * 7}
        parsed = parse_deck(json.dumps({"reads": reads}), model_version="m")
        assert [r.id for r in parsed.reads] == ["r0", "r3"]
        assert len(parsed.errors) == 2
        assert "reads[1]" in parsed.errors[0] and "reads[2]" in parsed.errors[1]

    @pytest.mark.parametrize("raw", ["no json", json.dumps([1, 2]), json.dumps({"notreads": []}), json.dumps({"reads": "x"})])
    def test_unparseable_decks_still_raise(self, raw: str) -> None:
        with pytest.raises(MalformedDeckError):
            parse_deck(raw, model_version="m")


def test_raw_control_characters_inside_strings_are_tolerated() -> None:
    reads = [read_json(i) for i in range(3)]
    raw = json.dumps({"reads": reads}).replace("Read 0", "Read" + chr(9) + "0")
    assert chr(9) in raw
    assert len(parse_deck(raw, model_version="m").reads) == 3


def test_prompt_asks_for_short_reads() -> None:
    system, _ = render_reader_prompt(episode())
    assert "200 characters" in system
