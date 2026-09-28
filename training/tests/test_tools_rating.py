"""Tests for the blind-rating tools in training/tools/.

These tools are standalone stdlib scripts (not part of the nailed_it_training
package), so they are loaded here by file path rather than imported by name.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
from pathlib import Path
from types import ModuleType

import pytest

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
FIXTURES_DIR = TOOLS_DIR / "fixtures"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


make_rating_page = _load_module("_nailed_it_tools_make_rating_page", TOOLS_DIR / "make_rating_page.py")
score_ratings = _load_module("_nailed_it_tools_score_ratings", TOOLS_DIR / "score_ratings.py")


def _pool(n: int = 5) -> list[dict]:
    return [{"id": f"a{i}", "text": f"read number {i}", "category": "habits", "confidence": 0.5} for i in range(n)]


# --- pool validation -------------------------------------------------------


def test_validate_pool_accepts_well_formed_pool() -> None:
    make_rating_page.validate_pool(_pool())


@pytest.mark.parametrize(
    ("broken", "fragment"),
    [
        ([], "empty"),
        ("not a list", "must be a json array"),
        ([{"text": "x", "category": "c", "confidence": 0.5}], "id"),
        ([{"id": "a1", "category": "c", "confidence": 0.5}], "text"),
        ([{"id": "a1", "text": "x", "confidence": 0.5}], "category"),
        ([{"id": "a1", "text": "x", "category": "c"}], "confidence"),
        ([{"id": "a1", "text": "x" * 241, "category": "c", "confidence": 0.5}], "240"),
        ([{"id": "a1", "text": "x", "category": "c", "confidence": 1.5}], "confidence"),
        ([{"id": "a1", "text": "x", "category": "c", "confidence": -0.1}], "confidence"),
        ([{"id": "a1", "text": "x", "category": "c", "confidence": True}], "confidence"),
        (
            [
                {"id": "a1", "text": "x", "category": "c", "confidence": 0.5},
                {"id": "a1", "text": "y", "category": "c", "confidence": 0.5},
            ],
            "duplicate",
        ),
    ],
)
def test_validate_pool_rejects_bad_input(broken: object, fragment: str) -> None:
    with pytest.raises(make_rating_page.PoolValidationError) as exc_info:
        make_rating_page.validate_pool(broken)
    assert fragment in str(exc_info.value).lower()


def test_load_pool_raises_clear_error_for_missing_file(tmp_path: Path) -> None:
    with pytest.raises(make_rating_page.PoolValidationError, match="could not read"):
        make_rating_page.load_pool(tmp_path / "missing.json")


def test_load_pool_raises_clear_error_for_bad_json(tmp_path: Path) -> None:
    bad = tmp_path / "pool.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(make_rating_page.PoolValidationError, match="not valid JSON"):
        make_rating_page.load_pool(bad)


# --- deterministic shuffle --------------------------------------------------


def test_shuffle_is_deterministic_for_a_given_seed() -> None:
    pool = _pool(20)
    first = make_rating_page.shuffle_pool(pool, seed=7)
    second = make_rating_page.shuffle_pool(pool, seed=7)
    assert [r["id"] for r in first] == [r["id"] for r in second]


def test_shuffle_differs_across_seeds() -> None:
    pool = _pool(20)
    a = [r["id"] for r in make_rating_page.shuffle_pool(pool, seed=1)]
    b = [r["id"] for r in make_rating_page.shuffle_pool(pool, seed=2)]
    assert a != b


def test_shuffle_does_not_mutate_input() -> None:
    pool = _pool(5)
    original_order = [r["id"] for r in pool]
    make_rating_page.shuffle_pool(pool, seed=1)
    assert [r["id"] for r in pool] == original_order


def test_shuffle_is_a_permutation_not_a_resample() -> None:
    pool = _pool(10)
    shuffled = make_rating_page.shuffle_pool(pool, seed=3)
    assert sorted(r["id"] for r in shuffled) == sorted(r["id"] for r in pool)


# --- fixtures ---------------------------------------------------------------


def test_fixture_pool_and_key_are_consistent() -> None:
    pool = json.loads((FIXTURES_DIR / "pool.example.json").read_text())
    key = json.loads((FIXTURES_DIR / "key.example.json").read_text())
    pool_ids = {entry["id"] for entry in pool}
    assert pool_ids == set(key)
    assert set(key.values()) <= {"base", "trained"}
    assert len(pool) >= 20


# --- rendered page: completeness and blindness ------------------------------


def _extract_embedded_pool(html: str) -> list[dict]:
    match = re.search(r"var POOL = (\[.*?\]);", html, re.DOTALL)
    assert match is not None, "embedded POOL array not found in rendered page"
    return json.loads(match.group(1))


def test_build_from_fixture_contains_each_read_exactly_once() -> None:
    pool = json.loads((FIXTURES_DIR / "pool.example.json").read_text())
    make_rating_page.validate_pool(pool)
    shuffled = make_rating_page.shuffle_pool(pool, seed=42)
    pool_hash = make_rating_page.compute_pool_hash(pool)
    html = make_rating_page.render_html(shuffled, seed=42, pool_hash=pool_hash)

    embedded = _extract_embedded_pool(html)
    assert len(embedded) == len(pool)
    assert sorted(entry["id"] for entry in embedded) == sorted(entry["id"] for entry in pool)
    for entry in embedded:
        assert set(entry) == {"id", "text"}


def test_build_from_fixture_hides_source_and_makes_no_network_requests() -> None:
    pool = json.loads((FIXTURES_DIR / "pool.example.json").read_text())
    key = json.loads((FIXTURES_DIR / "key.example.json").read_text())
    shuffled = make_rating_page.shuffle_pool(pool, seed=42)
    pool_hash = make_rating_page.compute_pool_hash(pool)
    html = make_rating_page.render_html(shuffled, seed=42, pool_hash=pool_hash)

    lowered = html.lower()
    assert "base" not in lowered
    assert "trained" not in lowered
    for source_value in key.values():
        assert source_value not in lowered
    assert "http://" not in html
    assert "https://" not in html


def test_compute_pool_hash_is_stable_regardless_of_shuffle_order() -> None:
    pool = _pool(10)
    shuffled_a = make_rating_page.shuffle_pool(pool, seed=1)
    shuffled_b = make_rating_page.shuffle_pool(pool, seed=2)
    assert make_rating_page.compute_pool_hash(pool) == make_rating_page.compute_pool_hash(shuffled_a)
    assert make_rating_page.compute_pool_hash(shuffled_a) == make_rating_page.compute_pool_hash(shuffled_b)


def test_compute_pool_hash_changes_when_text_changes() -> None:
    pool = _pool(5)
    changed = json.loads(json.dumps(pool))
    changed[0]["text"] = "a different read entirely"
    assert make_rating_page.compute_pool_hash(pool) != make_rating_page.compute_pool_hash(changed)


# --- refuse to write into a git-tracked path --------------------------------


def _init_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)


def test_ensure_output_ignored_accepts_a_gitignored_path(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    make_rating_page.ensure_path_is_git_ignored(tmp_path / "ignored" / "rate.html")


def test_ensure_output_ignored_refuses_a_tracked_path(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    with pytest.raises(make_rating_page.OutputNotIgnoredError):
        make_rating_page.ensure_path_is_git_ignored(tmp_path / "tracked" / "rate.html")


def test_ensure_output_ignored_refuses_outside_any_repo(tmp_path: Path) -> None:
    with pytest.raises(make_rating_page.OutputNotIgnoredError):
        make_rating_page.ensure_path_is_git_ignored(tmp_path / "rate.html")


def test_build_refuses_to_write_to_a_tracked_path(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    pool_path = tmp_path / "pool.json"
    pool_path.write_text(json.dumps(_pool()), encoding="utf-8")

    with pytest.raises(make_rating_page.OutputNotIgnoredError):
        make_rating_page.build(pool_path, tmp_path / "tracked" / "rate.html", seed=1)


def test_build_writes_the_page_to_an_ignored_path(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    pool_path = tmp_path / "pool.json"
    pool_path.write_text(json.dumps(_pool()), encoding="utf-8")

    out_path = make_rating_page.build(pool_path, tmp_path / "ignored" / "rate.html", seed=1)
    assert out_path.exists()
    assert "<!doctype html>" in out_path.read_text(encoding="utf-8").lower()


def test_cli_reports_bad_pool_with_nonzero_exit(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    pool_path = tmp_path / "pool.json"
    pool_path.write_text("[]", encoding="utf-8")

    exit_code = make_rating_page.main(
        ["--pool", str(pool_path), "--out", str(tmp_path / "ignored" / "rate.html"), "--seed", "1"]
    )
    assert exit_code != 0
    assert "empty" in capsys.readouterr().err.lower()


# --- scoring maths -----------------------------------------------------------


def test_summarize_source_hand_computed() -> None:
    ratings = (
        [{"id": f"b{i}", "answer": "nailed", "order": i, "ms": 1000} for i in range(1, 6)]
        + [{"id": f"b{i}", "answer": "partly", "order": i, "ms": 1200} for i in range(6, 9)]
        + [{"id": f"b{i}", "answer": "off", "order": i, "ms": 900} for i in range(9, 11)]
    )
    summary = score_ratings.summarize_source(ratings)
    assert summary["counts"] == {"nailed": 5, "partly": 3, "off": 2, "skip": 0}
    assert summary["n_rated"] == 10
    assert summary["score"] == pytest.approx(0.65)
    assert summary["share_nailed"] == pytest.approx(0.5)
    assert summary["median_ms"] == pytest.approx(1000)


def test_summarize_source_excludes_skips_from_score_but_counts_them() -> None:
    ratings = [
        {"id": "x1", "answer": "nailed", "order": 1, "ms": 100},
        {"id": "x2", "answer": "skip", "order": 2, "ms": 50},
    ]
    summary = score_ratings.summarize_source(ratings)
    assert summary["counts"]["skip"] == 1
    assert summary["n_rated"] == 1
    assert summary["score"] == pytest.approx(1.0)


def test_join_by_source_groups_by_key_and_ignores_unknown_ids() -> None:
    key = {"b1": "base", "t1": "trained"}
    ratings = [
        {"id": "b1", "answer": "nailed", "order": 1, "ms": 1},
        {"id": "t1", "answer": "off", "order": 2, "ms": 1},
        {"id": "unknown", "answer": "nailed", "order": 3, "ms": 1},
    ]
    grouped = score_ratings.join_by_source(ratings, key)
    assert [r["id"] for r in grouped["base"]] == ["b1"]
    assert [r["id"] for r in grouped["trained"]] == ["t1"]


def test_bootstrap_ci_is_deterministic_for_a_given_seed() -> None:
    base = [{"id": f"b{i}", "answer": a} for i, a in enumerate(["nailed"] * 6 + ["off"] * 4)]
    trained = [{"id": f"t{i}", "answer": a} for i, a in enumerate(["nailed"] * 9 + ["off"] * 1)]
    ci_a = score_ratings.bootstrap_diff_ci(base, trained, seed=5, n_boot=500)
    ci_b = score_ratings.bootstrap_diff_ci(base, trained, seed=5, n_boot=500)
    assert ci_a == ci_b
    assert ci_a[0] <= ci_a[1]


def test_bootstrap_ci_trained_much_better_is_entirely_above_zero() -> None:
    base = [{"id": f"b{i}", "answer": "off"} for i in range(20)]
    trained = [{"id": f"t{i}", "answer": "nailed"} for i in range(20)]
    lo, hi = score_ratings.bootstrap_diff_ci(base, trained, seed=1, n_boot=2000)
    assert lo > 0
    assert hi > 0


# --- verdict rule at each boundary -------------------------------------------


@pytest.mark.parametrize(
    ("lo", "hi", "expected"),
    [
        (0.01, 0.3, "trained better"),
        (0.0001, 0.3, "trained better"),
        (-0.3, -0.01, "base better"),
        (-0.3, -0.0001, "base better"),
        (-0.1, 0.1, "not distinguishable"),
        (0.0, 0.2, "not distinguishable"),
        (-0.2, 0.0, "not distinguishable"),
        (0.0, 0.0, "not distinguishable"),
    ],
)
def test_verdict_rule_boundaries(lo: float, hi: float, expected: str) -> None:
    assert score_ratings.compute_verdict(lo, hi) == expected


# --- minimum sample refusal --------------------------------------------------


def _write_ratings_and_key(tmp_path: Path, base_n: int, trained_n: int) -> tuple[Path, Path]:
    ratings = {
        "poolHash": "deadbeef",
        "exportedAt": "2026-09-27T00:00:00Z",
        "seed": 1,
        "ratings": (
            [{"id": f"b{i}", "answer": "nailed", "order": i, "ms": 100} for i in range(base_n)]
            + [{"id": f"t{i}", "answer": "nailed", "order": i, "ms": 100} for i in range(trained_n)]
        ),
    }
    key = {f"b{i}": "base" for i in range(20)} | {f"t{i}": "trained" for i in range(20)}
    ratings_path = tmp_path / "ratings.json"
    key_path = tmp_path / "key.json"
    ratings_path.write_text(json.dumps(ratings), encoding="utf-8")
    key_path.write_text(json.dumps(key), encoding="utf-8")
    return ratings_path, key_path


def test_score_refuses_when_a_source_has_fewer_than_ten_rated(tmp_path: Path) -> None:
    ratings_path, key_path = _write_ratings_and_key(tmp_path, base_n=10, trained_n=4)
    with pytest.raises(score_ratings.InsufficientSampleError, match="10"):
        score_ratings.score(ratings_path, key_path, seed=0)


def test_score_succeeds_at_exactly_ten_per_source(tmp_path: Path) -> None:
    ratings_path, key_path = _write_ratings_and_key(tmp_path, base_n=10, trained_n=10)
    result = score_ratings.score(ratings_path, key_path, seed=0, n_boot=200)
    assert result["sample_size"] == {"base": 10, "trained": 10}
    assert result["verdict"] in {"trained better", "base better", "not distinguishable"}


def test_score_cli_writes_json_output(tmp_path: Path) -> None:
    ratings_path, key_path = _write_ratings_and_key(tmp_path, base_n=10, trained_n=10)
    out_path = tmp_path / "score.json"
    exit_code = score_ratings.main(
        [
            "--ratings",
            str(ratings_path),
            "--key",
            str(key_path),
            "--out",
            str(out_path),
            "--seed",
            "0",
            "--n-boot",
            "200",
        ]
    )
    assert exit_code == 0
    written = json.loads(out_path.read_text(encoding="utf-8"))
    assert written["sample_size"] == {"base": 10, "trained": 10}


def test_score_cli_reports_insufficient_sample_with_nonzero_exit(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ratings_path, key_path = _write_ratings_and_key(tmp_path, base_n=3, trained_n=10)
    exit_code = score_ratings.main(["--ratings", str(ratings_path), "--key", str(key_path), "--out", str(tmp_path / "score.json")])
    assert exit_code != 0
    assert "10" in capsys.readouterr().err
