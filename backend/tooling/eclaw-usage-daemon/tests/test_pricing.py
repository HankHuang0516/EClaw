"""Smoke tests for the pricing fallback table."""

from __future__ import annotations

import pricing


def test_claude_known_model_nonzero():
    c = pricing.claude_cost("claude-opus-4-7", 1_000_000, 0)
    assert c == 15.0
    c = pricing.claude_cost("claude-opus-4-7", 0, 1_000_000)
    assert c == 75.0


def test_claude_prefix_match():
    # Variant suffix should resolve to opus-4 row.
    c = pricing.claude_cost("claude-opus-4-7-20251001", 1_000_000, 0)
    assert c == 15.0


def test_unknown_model_zero():
    assert pricing.claude_cost("alien-9", 1_000_000, 1_000_000) == 0.0


def test_codex_uses_cached_rate():
    # cached_tokens charged at cache_read price
    c = pricing.codex_cost("gpt-5-codex", 0, 0, 1_000_000)
    assert c == 0.50


def test_pricing_source_label():
    assert pricing.pricing_source() == "fallback-static-v1"
