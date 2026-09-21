"""What the candidate's last utterance actually was.

Not every utterance is an answer. Mid-interview people ask for the question
again, say they do not know it, or ask to stop - and a system that grades those
as answers is one that carries on interviewing somebody who has asked to leave.

Deterministic on purpose. An intent this consequential must not depend on a
model call that can time out, drift or cost money on every turn, and the
behaviour has to be identical for every candidate: the same words must end the
interview for everybody. The patterns are anchored to whole short utterances, so
an answer that happens to contain "I am not sure" is still an answer.

Ending is never acted on directly - it asks the candidate to confirm first - so
these patterns can afford to lean towards catching the request. A false positive
costs one spoken question; a false negative is an interview that keeps going
after somebody asked it to stop.
"""
from __future__ import annotations

import re

# Intents
ANSWER = "answer"
REPEAT = "repeat"
DECLINE = "decline"
END = "end"
YES = "yes"
NO = "no"
SILENCE = "silence"

# Contractions are expanded rather than stripped: the patterns are then written
# once, in full words, instead of twice. Speech-to-text emits both forms - and
# "dont" with no apostrophe at all - depending on the engine.
_CONTRACTIONS = [
    (r"\bcan't\b|\bcant\b|\bcannot\b", "can not"),
    (r"\bwon't\b|\bwont\b", "will not"),
    (r"\bdon't\b|\bdont\b", "do not"),
    (r"\bdoesn't\b|\bdoesnt\b", "does not"),
    (r"\bdidn't\b|\bdidnt\b", "did not"),
    (r"\bhaven't\b|\bhavent\b", "have not"),
    (r"\bhasn't\b|\bhasnt\b", "has not"),
    (r"\bisn't\b|\bisnt\b", "is not"),
    (r"\baren't\b|\barent\b", "are not"),
    (r"\bwasn't\b|\bwasnt\b", "was not"),
    (r"\bwouldn't\b|\bwouldnt\b", "would not"),
    (r"\bcouldn't\b|\bcouldnt\b", "could not"),
    (r"\bshouldn't\b|\bshouldnt\b", "should not"),
    (r"\bi'm\b|\bim\b", "i am"),
    (r"\bi've\b|\bive\b", "i have"),
    (r"\bi'd\b", "i would"),
    (r"\bi'll\b", "i will"),
    (r"\blet's\b|\blets\b", "let us"),
    (r"\bthat's\b|\bthats\b", "that is"),
    (r"\bwhat's\b|\bwhats\b", "what is"),
    (r"\bwanna\b", "want to"),
    (r"\bgonna\b", "going to"),
    (r"\bgotta\b", "have to"),
    (r"\bkinda\b", "kind of"),
]


def normalise(text: str) -> str:
    """Lowercase, contraction-expanded, punctuation-free words."""
    clean = str(text or "").lower().replace("’", "'").replace("‘", "'")
    for pattern, replacement in _CONTRACTIONS:
        clean = re.sub(pattern, replacement, clean)
    clean = re.sub(r"[^a-z0-9' ]+", " ", clean)
    clean = clean.replace("'", "")
    return re.sub(r"\s+", " ", clean).strip()


# Openers people put in front of the thing they actually mean. Stripped before
# the residual-length test so "sorry, I do not know" reads as a bare decline.
_LEAD_IN = re.compile(
    r"^(so |um |uh |erm |ah |oh |well |ok |okay |yeah |yes |actually |honestly |"
    r"sorry |apologies |i am sorry |i am afraid |to be honest |frankly |"
    r"the thing is |see |look )+"
)

# Words left over after a decline that carry no content of their own.
_FILLER_RESIDUE = re.compile(
    r"\b(about|that|this|it|much|really|exactly|right|now|sorry|sir|maam|ma|am|"
    r"the|a|an|of|on|in|to|at|is|was|but|and|so|very|too|please|question|one|"
    r"thing|part|actually|honestly|anything|any|specific|specifically|yet|"
    r"currently|personally|frankly)\b"
)

# --------------------------------------------------------------------- ending
# Unambiguous requests to stop. Matched at any length: "I am sorry, something
# has come up at home and I need to end the interview" is 15 words and still a
# request to stop.
_END_STRONG = [
    r"\b(end|stop|cancel|quit|finish|terminate|discontinue|abort) (this|the|my|our) ?"
    r"(interview|session|call|conversation|test|exam)\b",
    r"\b(interview|session) (should|can|must) (be )?(stop|stopped|ended|cancelled|canceled)\b",
    r"\bi (want|would like|wish|need|have) to (quit|leave|stop|exit|end|withdraw|discontinue)\b",
    r"\bi (do not|will not) want to (give|do|take|attend|continue|proceed|appear|sit)\b",
    r"\bi (do not|will not) want (this|the|any) (interview|test|exam)\b",
    r"\bi (can not|will not) (continue|carry on|go on|proceed|do this)\b",
    r"\b(let us|please) (stop|end) (this|it|here|now)\b",
    r"\bi (am|have) (quitting|withdrawing|leaving the interview)\b",
    r"\bnot interested in (this|the|continuing)\b",
    r"\bi withdraw\b",
    r"\bplease (stop|end) (it|this|the interview)\b",
]

# Short-utterance-only requests: the same words inside a long answer usually
# belong to the answer ("I have to go through the logs first").
_END_SHORT = [
    r"^(i )?(quit|stop|enough)$",
    r"\bi (have|need) to (go|leave)\b",
    r"\bno more questions from me\b",
    r"\bi am done with (this|the interview)\b",
    r"\bget me out of (here|this)\b",
]
_END_SHORT_MAX_WORDS = 12

# -------------------------------------------------------------------- repeats
_REPEAT = [
    r"\b(repeat|say|ask) (that|it|this|the question|again)\b",
    r"\b(can|could|would|will|may) you (please )?(repeat|say that|say it|ask that|ask it|"
    r"rephrase|reframe)\b",
    r"\bplease (repeat|rephrase|say that|say it again)\b",
    r"\b(one|once) more time\b",
    r"\bcome again\b",
    r"\bi (did not|could not|can not) (hear|catch|get|follow|understand|listen)\b",
    r"\bi (did not|could not) quite (hear|catch|get|follow)\b",
    r"\bwhat (was|is) the question\b",
    r"\b(you )?(broke up|cut out|cutting out)\b",
    r"\bi missed (that|the question|it)\b",
    r"\b(repeat|rephrase) (the )?question\b",
    r"^(sorry|pardon|excuse me|what|huh|again|repeat)$",
]
_REPEAT_MAX_WORDS = 20

# ------------------------------------------------------------------- declines
_DECLINE = [
    r"\bi (do not|would not) know\b",
    r"\bno idea\b",
    r"\bi am not sure\b",
    r"\bnot sure about\b",
    r"\bi have (no|not any) (clue|idea|experience|knowledge|exposure)\b",
    r"\bi (can not|could not) answer\b",
    r"\bi (do not|can not) (recall|remember)\b",
    r"\bi (forgot|forget)\b",
    r"\b(skip|pass|next) (this|the|that)? ?(question|one)?\b",
    r"\bmove (on|to the next)\b",
    r"\bi (do not|did not) (work|worked) (on|with) (that|this|it)\b",
    r"\bi have not (worked|used|done|tried|touched|come across)\b",
    r"\bnot familiar with (that|this|it)\b",
    r"\bnothing comes to mind\b",
    r"\bno experience (in|with|of) (that|this|it)\b",
    r"\bleave (this|that|it)\b",
    r"\bi am blank\b",
]
_DECLINE_MAX_WORDS = 16
# Words of real content left after the decline phrase before it counts as an
# answer instead. "I am not sure, but I would start by profiling the query" is
# somebody thinking aloud, which is exactly what a good interview wants.
_DECLINE_MAX_RESIDUE = 6

# ------------------------------------------------------------- confirmations
_YES = [
    r"^(yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|confirm|confirmed|"
    r"affirmative|absolutely|definitely|please|indeed)\b",
    r"\byes (please|end|stop|i do|i am sure|that is right)\b",
    r"\b(end|stop|finish|close) it\b",
    r"\bi (do|am) (sure|certain)\b",
    r"\bthat is (right|correct)\b",
    r"\bplease (do|end|stop)\b",
    r"\bi want to (end|stop|quit|leave)\b",
]
_NO = [
    r"^(no|nope|nah|never|continue|carry|keep|go|wait|sorry)\b",
    r"\b(no|not) (thanks|thank you)\b",
    r"\bi (want|would like) to (continue|carry on|go on|stay|keep going)\b",
    r"\b(let us|lets) (continue|carry on|keep going|go on)\b",
    r"\b(carry on|keep going|go on|continue)\b",
    r"\bi (did not|do not) (mean|want) (that|to)\b",
    r"\bby mistake\b",
    r"\bmy mistake\b",
    r"\bignore (that|it)\b",
]


def _first_match(patterns: list[str], text: str) -> str:
    for pattern in patterns:
        if re.search(pattern, text):
            return pattern
    return ""


def _residue(text: str, pattern: str) -> int:
    """Words of real content left once the matched phrase and filler are gone."""
    stripped = re.sub(pattern, " ", text)
    stripped = _FILLER_RESIDUE.sub(" ", stripped)
    return len([w for w in stripped.split() if len(w) > 1])


def classify(text: str, *, confirming: bool = False) -> dict:
    """What this utterance is: an answer, or something else entirely.

    `confirming` means the interviewer has just asked whether to end, so a bare
    "yes" or "no" is about that question and nothing else.

    Returns {"intent", "matched", "words"} - `matched` is kept so the record can
    say why an interview ended, which matters when somebody disputes it later.
    """
    norm = normalise(text)
    words = norm.split()
    count = len(words)

    if not count:
        return {"intent": SILENCE, "matched": "", "words": 0}

    if confirming:
        # A clear restatement of the request beats a bare yes/no either way.
        if _first_match(_END_STRONG, norm):
            return {"intent": YES, "matched": "restated", "words": count}
        no_hit = _first_match(_NO, norm)
        yes_hit = _first_match(_YES, norm)
        # "no" and "yes" are both prefix-anchored; whichever is actually at the
        # front of the utterance is the one the candidate said.
        if no_hit and yes_hit:
            return ({"intent": NO, "matched": no_hit, "words": count}
                    if words[0] in ("no", "nope", "nah", "sorry", "wait")
                    else {"intent": YES, "matched": yes_hit, "words": count})
        if no_hit:
            return {"intent": NO, "matched": no_hit, "words": count}
        if yes_hit:
            return {"intent": YES, "matched": yes_hit, "words": count}
        return {"intent": ANSWER, "matched": "", "words": count}

    hit = _first_match(_END_STRONG, norm)
    if hit:
        return {"intent": END, "matched": hit, "words": count}
    if count <= _END_SHORT_MAX_WORDS:
        hit = _first_match(_END_SHORT, norm)
        if hit:
            return {"intent": END, "matched": hit, "words": count}

    if count <= _REPEAT_MAX_WORDS:
        hit = _first_match(_REPEAT, norm)
        if hit:
            return {"intent": REPEAT, "matched": hit, "words": count}

    if count <= _DECLINE_MAX_WORDS:
        body = _LEAD_IN.sub("", norm)
        hit = _first_match(_DECLINE, body)
        if hit and _residue(body, hit) <= _DECLINE_MAX_RESIDUE:
            return {"intent": DECLINE, "matched": hit, "words": count}

    return {"intent": ANSWER, "matched": "", "words": count}
