"""Local token counting with an optional tiktoken implementation."""

from __future__ import annotations

import re

try:
    import tiktoken
except ImportError:  # pragma: no cover - depends on the local environment
    tiktoken = None

_CJK = re.compile(r"[\u3400-\u9fff]")
_ASCII = re.compile(r"[A-Za-z0-9_]+|[^\sA-Za-z0-9_]", re.UNICODE)


def count_tokens(value: object) -> int:
    """Return a deterministic token estimate for a string or JSON fragment."""
    text = value if isinstance(value, str) else str(value)
    if not text:
        return 0
    if tiktoken is not None:
        try:
            return len(tiktoken.get_encoding("cl100k_base").encode(text))
        except Exception:
            pass
    cjk = len(_CJK.findall(text))
    rest = _CJK.sub("", text)
    # Keep the fallback close to the historical 4 chars/token estimate while
    # treating CJK characters as roughly one token each.
    return max(1, cjk + (len(rest) + 3) // 4)
