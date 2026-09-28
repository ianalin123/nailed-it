"""Per-read credit assignment for RL on decks (run 3).

Map every generated token to exact characters (byte-level BPE), locate each read object in the deck's JSON,
and give the tokens of each read that read's own advantage. Structure tokens get zero. Any doubt about the
alignment raises AlignmentError and the deck is excluded from training: training the wrong tokens is worse
than not training.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any, Protocol

from nailed_it_training.protocol import ReadCategory
from nailed_it_training.reward import Gate

_WS = " \t\r\n"


class AlignmentError(ValueError):
    pass


class _Tokenizer(Protocol):
    def convert_ids_to_tokens(self, i: int) -> str: ...


@cache
def bytes_to_unicode() -> dict[int, str]:
    """GPT-2 byte-level BPE alphabet: every byte maps to one printable unicode character."""
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, (chr(c) for c in cs), strict=True))


@cache
def _unicode_to_byte() -> dict[str, int]:
    return {v: k for k, v in bytes_to_unicode().items()}


def token_bytes(tokenizer: _Tokenizer, ids: Sequence[int]) -> list[bytes]:
    decoder = _unicode_to_byte()
    out = []
    for i in ids:
        piece = tokenizer.convert_ids_to_tokens(i)
        out.append(bytes(decoder[c] for c in piece) if all(c in decoder for c in piece) else piece.encode("utf-8"))
    return out


def char_offsets(pieces: Sequence[bytes]) -> tuple[str, list[tuple[int, int]]]:
    """Decode concatenated token bytes and return each token's [start, end) character span. A token that holds part
    of a multi-byte character spans that whole character. An incomplete character at the very end is dropped."""
    data = b"".join(pieces)
    try:
        text = data.decode("utf-8")
        valid = len(data)
    except UnicodeDecodeError as err:
        if err.reason != "unexpected end of data" or err.end != len(data):
            raise AlignmentError(f"token bytes are not valid UTF-8 at byte {err.start}: {err.reason}") from err
        valid = err.start
        text = data[:valid].decode("utf-8")
    byte_to_char = []
    for index, ch in enumerate(text):
        byte_to_char.extend([index] * len(ch.encode("utf-8")))
    offsets = []
    position = 0
    for piece in pieces:
        start, end = min(position, valid), min(position + len(piece), valid)
        position += len(piece)
        if end <= start:
            offsets.append((len(text) if start >= valid else byte_to_char[start], len(text) if start >= valid else byte_to_char[start]))
            continue
        offsets.append((byte_to_char[start], byte_to_char[end - 1] + 1))
    return text, offsets


def _skip_ws(text: str, pos: int) -> int:
    while pos < len(text) and text[pos] in _WS:
        pos += 1
    return pos


def _parse_array(text: str, decoder: json.JSONDecoder, pos: int) -> tuple[list[Any], list[tuple[int, int]]] | None:
    if pos >= len(text) or text[pos] != "[":
        return None
    pos = _skip_ws(text, pos + 1)
    values: list[Any] = []
    spans: list[tuple[int, int]] = []
    if pos < len(text) and text[pos] == "]":
        return values, spans
    while True:
        try:
            value, end = decoder.raw_decode(text, pos)
        except json.JSONDecodeError:
            return None
        values.append(value)
        spans.append((pos, end))
        pos = _skip_ws(text, end)
        if pos < len(text) and text[pos] == ",":
            pos = _skip_ws(text, pos + 1)
            continue
        if pos < len(text) and text[pos] == "]":
            return values, spans
        return None


def locate_read_elements(text: str) -> list[tuple[int, int]]:
    """Character spans of each element of the top-level "reads" array. The root is the first '{' that decodes to an
    object with a "reads" list; the element spans must reproduce exactly that list."""
    decoder = json.JSONDecoder(strict=False)
    root: tuple[dict[str, Any], int, int] | None = None
    pos = text.find("{")
    while pos != -1:
        try:
            obj, end = decoder.raw_decode(text, pos)
        except json.JSONDecodeError:
            pos = text.find("{", pos + 1)
            continue
        if isinstance(obj, dict) and isinstance(obj.get("reads"), list):
            root = (obj, pos, end)
            break
        pos = text.find("{", pos + 1)
    if root is None:
        raise AlignmentError('no complete JSON object with a "reads" list')
    obj, start, end = root
    key = text.find('"reads"', start, end)
    while key != -1:
        colon = _skip_ws(text, key + len('"reads"'))
        if colon < end and text[colon] == ":":
            parsed = _parse_array(text, decoder, _skip_ws(text, colon + 1))
            if parsed is not None and parsed[0] == obj["reads"]:
                return parsed[1]
        key = text.find('"reads"', key + 1, end)
    raise AlignmentError('could not locate the "reads" array inside the root object')


def align_reads(pieces: Sequence[bytes]) -> list[tuple[int, int]]:
    """Token range [t0, t1) for each read element. Tokens overlapping two elements are structure (excluded); at most
    one such token may be dropped at each end of an element, and every element must keep at least one token."""
    text, offsets = char_offsets(pieces)
    elements = locate_read_elements(text)
    overlaps = [[t for t, (a, b) in enumerate(offsets) if b > a and b > c0 and a < c1] for c0, c1 in elements]
    owner_count: dict[int, int] = {}
    for toks in overlaps:
        for t in toks:
            owner_count[t] = owner_count.get(t, 0) + 1
    ranges = []
    for index, toks in enumerate(overlaps):
        kept = [t for t in toks if owner_count[t] == 1]
        dropped = [t for t in toks if owner_count[t] > 1]
        if not kept:
            raise AlignmentError(f"read {index} has no token of its own")
        if any(t not in (toks[0], toks[-1]) for t in dropped):
            raise AlignmentError(f"read {index} shares an interior token with another read")
        if kept != list(range(kept[0], kept[-1] + 1)):
            raise AlignmentError(f"read {index} tokens are not contiguous")
        ranges.append((kept[0], kept[-1] + 1))
    for (_, a1), (b0, _) in zip(ranges, ranges[1:], strict=False):
        if b0 < a1:
            raise AlignmentError("read token ranges overlap")
    return ranges


def training_reward(reward: float, gate: Gate | None, *, outcome: int | None, restatement_penalty: float) -> float:
    """Training-only shaping: a restatement that would score 0 scores a small negative instead, so it is no longer a
    free harbour. Unverifiable reads stay at 0 and wrong restatements keep their larger negative."""
    if gate is Gate.RESTATEMENT and reward >= 0.0:
        return restatement_penalty
    return reward


@dataclass(frozen=True)
class ElementCredit:
    reward: float
    category: ReadCategory | None
    gate: Gate | None
    token_range: tuple[int, int]


@dataclass(frozen=True)
class DeckCredit:
    elements: list[ElementCredit]
    deck_term: float
    n_tokens: int
    malformed_reward: float | None = None


@dataclass(frozen=True)
class Advantages:
    decks: list[DeckCredit]
    per_element: list[list[float]]
    whole_sequence: list[float | None]
    normaliser: int

    def token_vectors(self) -> list[list[float]]:
        vectors = []
        for deck, element_adv, whole in zip(self.decks, self.per_element, self.whole_sequence, strict=True):
            vec = [0.0] * deck.n_tokens
            if whole is not None:
                vec = [whole / self.normaliser] * deck.n_tokens
            for element, adv in zip(deck.elements, element_adv, strict=True):
                t0, t1 = element.token_range
                if not 0 <= t0 < t1 <= deck.n_tokens:
                    raise AlignmentError(f"token range {element.token_range} outside a {deck.n_tokens}-token sequence")
                for t in range(t0, t1):
                    vec[t] = adv / self.normaliser
            vectors.append(vec)
        return vectors


def assign_advantages(
    decks: Sequence[DeckCredit], *, deck_weight: float = 0.2, deck_clip: float = 0.3, min_category: int = 3
) -> Advantages:
    """Read advantage = reward - baseline, where baseline is the mean reward of the group's reads in the same category
    (group mean when fewer than min_category), plus a centred, scaled and clipped deck-level term."""
    rewards = [e.reward for d in decks for e in d.elements]
    group_mean = sum(rewards) / len(rewards) if rewards else 0.0
    by_category: dict[ReadCategory, list[float]] = {}
    for d in decks:
        for e in d.elements:
            if e.category is not None:
                by_category.setdefault(e.category, []).append(e.reward)
    category_mean = {c: sum(v) / len(v) for c, v in by_category.items() if len(v) >= min_category}
    well_formed = [d for d in decks if d.malformed_reward is None]
    deck_mean = sum(d.deck_term for d in well_formed) / len(well_formed) if well_formed else 0.0
    per_element: list[list[float]] = []
    whole: list[float | None] = []
    normaliser = 0
    for d in decks:
        if d.malformed_reward is not None:
            whole.append(d.malformed_reward - group_mean)
            per_element.append([])
            normaliser += d.n_tokens
            continue
        shared = max(-deck_clip, min(deck_clip, deck_weight * (d.deck_term - deck_mean)))
        per_element.append([e.reward - category_mean.get(e.category, group_mean) + shared for e in d.elements])  # type: ignore[arg-type]
        whole.append(None)
        normaliser += sum(e.token_range[1] - e.token_range[0] for e in d.elements)
    return Advantages(list(decks), per_element, whole, max(1, normaliser))
