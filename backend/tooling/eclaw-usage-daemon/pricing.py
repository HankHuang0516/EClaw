"""Static fallback pricing for cost_usd computation.

Phase 2 ships a fallback-only table — the PoC's 7-day-TTL LiteLLM fetch is
out of scope here, but the public method signature leaves room for a remote
loader to be wired in later without breaking daemon.py.

Prices are USD per 1M tokens. Unknown models return 0.0 so the daemon never
emits a NaN/None cost field; Phase 1's API rounds to six decimals.
"""

from __future__ import annotations

# (input, output, cache_create, cache_read) in USD per 1M tokens.
_FALLBACK: dict[str, tuple[float, float, float, float]] = {
    "claude-opus-4-7":     (15.0, 75.0, 18.75, 1.50),
    "claude-opus-4-6":     (15.0, 75.0, 18.75, 1.50),
    "claude-opus-4":       (15.0, 75.0, 18.75, 1.50),
    "claude-sonnet-4-6":   (3.0, 15.0, 3.75, 0.30),
    "claude-sonnet-4-5":   (3.0, 15.0, 3.75, 0.30),
    "claude-sonnet-4":     (3.0, 15.0, 3.75, 0.30),
    "claude-haiku-4-5":    (1.0, 5.0, 1.25, 0.10),
    "claude-3-5-sonnet":   (3.0, 15.0, 3.75, 0.30),
    "claude-3-5-haiku":    (1.0, 5.0, 1.25, 0.10),
    "gpt-5":               (5.0, 15.0, 0.0, 0.50),
    "gpt-5-codex":         (5.0, 15.0, 0.0, 0.50),
    "gpt-4o":              (2.50, 10.0, 0.0, 0.25),
    "gpt-4o-mini":         (0.15, 0.60, 0.0, 0.015),
    "o1":                  (15.0, 60.0, 0.0, 1.50),
    "o1-mini":             (3.0, 12.0, 0.0, 0.30),
}


def _match(model: str) -> tuple[float, float, float, float]:
    if not model:
        return (0.0, 0.0, 0.0, 0.0)
    m = model.lower()
    if m in _FALLBACK:
        return _FALLBACK[m]
    for key, prices in _FALLBACK.items():
        if m.startswith(key):
            return prices
    return (0.0, 0.0, 0.0, 0.0)


def claude_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_creation_tokens: int = 0,
    cache_read_tokens: int = 0,
) -> float:
    inp, out, cc, cr = _match(model)
    cost = (
        input_tokens * inp / 1_000_000
        + output_tokens * out / 1_000_000
        + cache_creation_tokens * cc / 1_000_000
        + cache_read_tokens * cr / 1_000_000
    )
    return round(cost, 6)


def codex_cost(model: str, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
    inp, out, _cc, cr = _match(model)
    cost = (
        input_tokens * inp / 1_000_000
        + output_tokens * out / 1_000_000
        + cached_tokens * cr / 1_000_000
    )
    return round(cost, 6)


def pricing_source() -> str:
    return "fallback-static-v1"
