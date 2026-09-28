import json

import pytest

from nailed_it_training.per_read import (
    AlignmentError,
    DeckCredit,
    ElementCredit,
    align_reads,
    assign_advantages,
    bytes_to_unicode,
    char_offsets,
    locate_read_elements,
    token_bytes,
    training_reward,
)
from nailed_it_training.protocol import ReadCategory
from nailed_it_training.reward import Gate


def pieces_of(text: str, cuts: list[int]) -> list[bytes]:
    """Split the UTF-8 bytes of text at the given byte cut points (like a tokenizer would)."""
    data = text.encode("utf-8")
    bounds = [0, *cuts, len(data)]
    return [data[a:b] for a, b in zip(bounds, bounds[1:], strict=False) if b > a]


def every_n_bytes(text: str, n: int) -> list[bytes]:
    data = text.encode("utf-8")
    return [data[i : i + n] for i in range(0, len(data), n)]


def read(i: int, text: str = "You ship at night.") -> dict:
    return {"id": f"r{i}", "text": text, "category": "work_style", "confidence": 0.7, "evidenceIds": ["e1"], "hops": 2,
            "chain": [{"kind": "evidence", "text": "[e1] q"}, {"kind": "inference", "text": "so"}]}


DECK = json.dumps({"reads": [read(0), read(1, "You naïvely refactor — 🌙 often."), read(2)]}, ensure_ascii=False)


class TestTokenBytes:
    def test_byte_level_tokens_round_trip(self) -> None:
        enc = bytes_to_unicode()

        class Tok:
            def convert_ids_to_tokens(self, i: int) -> str:
                return ["".join(enc[b] for b in "héllo".encode()), "<|im_end|>"][i]

        assert token_bytes(Tok(), [0, 1]) == ["héllo".encode(), b"<|im_end|>"]


class TestCharOffsets:
    def test_offsets_cover_text_exactly(self) -> None:
        pieces = every_n_bytes(DECK, 3)
        text, offsets = char_offsets(pieces)
        assert text == DECK
        assert offsets[0][0] == 0 and offsets[-1][1] == len(DECK)
        for (a, b), (c, _) in zip(offsets, offsets[1:], strict=False):
            assert a <= b <= c + 1

    def test_multibyte_character_split_across_tokens(self) -> None:
        text, offsets = char_offsets(["🌙".encode()[:2], "🌙".encode()[2:], b"x"])
        assert text == "🌙x"
        assert offsets[0] == (0, 1) and offsets[1] == (0, 1) and offsets[2] == (1, 2)

    def test_truncated_trailing_multibyte_is_dropped_not_fatal(self) -> None:
        text, offsets = char_offsets([b"ab", "é".encode()[:1]])
        assert text == "ab"
        assert offsets[-1] == (2, 2)

    def test_invalid_utf8_in_the_middle_raises(self) -> None:
        with pytest.raises(AlignmentError):
            char_offsets([b"a\xff", b"b"])


class TestLocate:
    def test_finds_each_read_object_exactly(self) -> None:
        elements = locate_read_elements(DECK)
        assert len(elements) == 3
        for i, (start, end) in enumerate(elements):
            assert json.loads(DECK[start:end]) == json.loads(DECK)["reads"][i]

    def test_handles_prefix_think_block_and_fence(self) -> None:
        wrapped = "<think>\nno {reads} here\n</think>\n```json\n" + DECK + "\n```"
        elements = locate_read_elements(wrapped)
        assert [json.loads(wrapped[a:b])["id"] for a, b in elements] == ["r0", "r1", "r2"]

    def test_decoy_reads_key_inside_a_string_is_ignored(self) -> None:
        tricky = json.dumps({"note": 'the "reads": [ key', "reads": [read(0)]})
        [(a, b)] = locate_read_elements(tricky)
        assert json.loads(tricky[a:b])["id"] == "r0"

    @pytest.mark.parametrize("bad", ["no json", DECK[: len(DECK) // 2], json.dumps({"reads": "x"}), json.dumps([1, 2])])
    def test_malformed_or_truncated_decks_raise(self, bad: str) -> None:
        with pytest.raises(AlignmentError):
            locate_read_elements(bad)

    def test_raw_control_characters_are_tolerated(self) -> None:
        deck = json.dumps({"reads": [read(0), read(1)]}).replace("You ship", "You\tship")
        assert len(locate_read_elements(deck)) == 2


class TestAlign:
    @pytest.mark.parametrize("n", [1, 2, 3, 5, 7, 13])
    def test_ranges_cover_each_read_and_nothing_else(self, n: int) -> None:
        pieces = every_n_bytes(DECK, n)
        spans = align_reads(pieces)
        text, offsets = char_offsets(pieces)
        elements = locate_read_elements(text)
        assert len(spans) == 3
        previous_end = 0
        for (t0, t1), (c0, c1) in zip(spans, elements, strict=True):
            assert previous_end <= t0 < t1
            previous_end = t1
            assert all(offsets[t][1] > c0 and offsets[t][0] < c1 for t in range(t0, t1))
            assert offsets[t0][0] <= c0 + n and offsets[t1 - 1][1] >= c1 - n
            inner = json.loads(text[c0:c1])["text"]
            covered = text[offsets[t0][0] : offsets[t1 - 1][1]]
            assert inner in covered

    def test_tokens_straddling_two_reads_are_excluded(self) -> None:
        cut = DECK.index("}, {\"id\"")
        head = every_n_bytes(DECK[:cut], 3)
        straddler = [DECK[cut : cut + 4].encode()]
        tail = every_n_bytes(DECK[cut + 4 :], 3)
        spans = align_reads(head + straddler + tail)
        index = len(head)
        assert all(not (t0 <= index < t1) for t0, t1 in spans)
        assert spans[0][1] == index and spans[1][0] == index + 1

    def test_structure_tokens_get_no_range(self) -> None:
        pieces = every_n_bytes(DECK, 4)
        spans = align_reads(pieces)
        text, offsets = char_offsets(pieces)
        first_elem_start = locate_read_elements(text)[0][0]
        assert spans[0][0] >= max(0, next(i for i, (a, b) in enumerate(offsets) if b > first_elem_start))

    def test_truncated_deck_raises(self) -> None:
        with pytest.raises(AlignmentError):
            align_reads(every_n_bytes(DECK[:-30], 3))


def credit(reward: float, category: ReadCategory | None, gate: Gate | None, rng: tuple[int, int] = (0, 1)) -> ElementCredit:
    return ElementCredit(reward=reward, category=category, gate=gate, token_range=rng)


class TestTrainingReward:
    def test_restatement_scores_below_unverifiable(self) -> None:
        gated = training_reward(0.0, Gate.RESTATEMENT, outcome=1, restatement_penalty=-0.1)
        unverifiable = training_reward(0.0, Gate.PASSED, outcome=None, restatement_penalty=-0.1)
        assert gated == -0.1 < unverifiable == 0.0

    def test_wrong_restatement_keeps_its_larger_negative(self) -> None:
        assert training_reward(-1.8, Gate.RESTATEMENT, outcome=0, restatement_penalty=-0.1) == -1.8

    def test_other_rewards_pass_through(self) -> None:
        assert training_reward(1.2, Gate.PASSED, outcome=1, restatement_penalty=-0.1) == 1.2
        assert training_reward(-1.0, Gate.UNGROUNDED, outcome=None, restatement_penalty=-0.1) == -1.0


class TestAdvantages:
    def test_category_baseline_with_enough_peers_else_group_mean(self) -> None:
        w, r = ReadCategory.WORK_STYLE, ReadCategory.RISKY_READ
        decks = [
            DeckCredit(elements=[credit(1.0, w, Gate.PASSED), credit(0.0, w, Gate.PASSED), credit(2.0, r, Gate.PASSED)], deck_term=0.0, n_tokens=10),
            DeckCredit(elements=[credit(-1.0, w, Gate.PASSED)], deck_term=0.0, n_tokens=10),
        ]
        adv = assign_advantages(decks, deck_weight=0.0)
        work_mean = (1.0 + 0.0 - 1.0) / 3
        group_mean = (1.0 + 0.0 + 2.0 - 1.0) / 4
        assert adv.per_element[0] == pytest.approx([1.0 - work_mean, 0.0 - work_mean, 2.0 - group_mean])
        assert adv.per_element[1] == pytest.approx([-1.0 - work_mean])

    def test_deck_term_is_centred_small_and_clipped(self) -> None:
        w = ReadCategory.WORK_STYLE
        decks = [
            DeckCredit(elements=[credit(0.0, w, Gate.PASSED)], deck_term=10.0, n_tokens=5),
            DeckCredit(elements=[credit(0.0, w, Gate.PASSED)], deck_term=-10.0, n_tokens=5),
        ]
        adv = assign_advantages(decks, deck_weight=0.2, deck_clip=0.3)
        assert adv.per_element[0] == pytest.approx([0.3])
        assert adv.per_element[1] == pytest.approx([-0.3])

    def test_malformed_deck_gets_one_advantage_over_all_its_tokens(self) -> None:
        w = ReadCategory.WORK_STYLE
        decks = [
            DeckCredit(elements=[credit(0.5, w, Gate.PASSED)], deck_term=0.0, n_tokens=5),
            DeckCredit(elements=[], deck_term=0.0, n_tokens=7, malformed_reward=-2.0),
        ]
        adv = assign_advantages(decks, deck_weight=0.0)
        assert adv.whole_sequence[1] == pytest.approx(-2.0 - 0.5)
        assert adv.whole_sequence[0] is None

    def test_token_vectors_zero_outside_read_ranges_and_normalised(self) -> None:
        w = ReadCategory.WORK_STYLE
        decks = [
            DeckCredit(elements=[credit(1.0, w, Gate.PASSED, (1, 3)), credit(-1.0, w, Gate.PASSED, (4, 6))], deck_term=0.0, n_tokens=8)
        ]
        adv = assign_advantages(decks, deck_weight=0.0)
        vec = adv.token_vectors()[0]
        assert len(vec) == 8
        assert vec[0] == vec[3] == vec[6] == vec[7] == 0.0
        assert vec[1] == vec[2] == pytest.approx(1.0 / 4)
        assert vec[4] == vec[5] == pytest.approx(-1.0 / 4)
