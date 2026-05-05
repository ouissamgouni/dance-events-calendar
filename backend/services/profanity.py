"""Lightweight profanity check used to auto-flag rating comments for admin review.

Intentionally simple: a static word-list-based heuristic. False positives are
acceptable here because flagging only sets ``admin_notes`` and pre-moderation
already gates publication.
"""

from __future__ import annotations

import re

# Conservative, English-only seed list. Add more via PR rather than at runtime.
_BAD_WORDS = {
    "fuck",
    "shit",
    "asshole",
    "bitch",
    "bastard",
    "cunt",
    "dick",
    "piss",
    "wanker",
    "slut",
    "whore",
    "faggot",
    "nigger",
    "retard",
}

_WORD_RE = re.compile(r"[A-Za-z]+")


def contains_profanity(text: str | None) -> bool:
    if not text:
        return False
    for match in _WORD_RE.findall(text.lower()):
        if match in _BAD_WORDS:
            return True
    return False
