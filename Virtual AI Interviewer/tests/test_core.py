"""Unit tests for the parts of the interviewer that must behave identically for
every candidate: what an utterance is taken to mean, and what the engine does
about it.

These are the rules a model must not be trusted with. An interview that carries
on after somebody asked to stop, or that grades "I do not know" as an answer, is
not a bug in a prompt - it is a system doing the wrong thing to a person. So they
are decided in Python and pinned here.

Nothing in this file touches the network: the AI path is only reached by an
answer that is a real answer, and no test sends one.

Run either way:
    cd "Virtual AI Interviewer" && python -m pytest tests -q
    cd "Virtual AI Interviewer" && python tests/test_core.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config, evaluation, intent  # noqa: E402
from backend import interview as engine  # noqa: E402
from backend import storage  # noqa: E402


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ------------------------------------------------------------------- intent
def test_asking_to_stop_is_recognised_in_many_phrasings():
    for text in (
        "I don't want to give this interview",
        "I want to quit the interview",
        "please end the interview",
        "stop this interview please",
        "I can't continue, sorry",
        "I quit",
        "I am sorry, something came up at home and I need to end the interview now",
        "I'm not interested in this anymore",
    ):
        assert intent.classify(text)["intent"] == intent.END, text


def test_asking_again_is_recognised():
    for text in (
        "Sorry, I didn't listen, can you repeat the question?",
        "could you repeat that please",
        "say that again",
        "I didn't catch that",
        "what was the question",
        "pardon",
        "sorry",
    ):
        assert intent.classify(text)["intent"] == intent.REPEAT, text


def test_not_knowing_is_recognised():
    for text in (
        "sorry I don't know",
        "no idea",
        "I'm not sure",
        "I haven't worked with Kubernetes",
        "skip this question",
        "I don't know much about that honestly",
    ):
        assert intent.classify(text)["intent"] == intent.DECLINE, text


def test_a_real_answer_is_never_mistaken_for_a_control_phrase():
    """The expensive direction to get wrong: these must all be graded."""
    for text in (
        "I am not sure, but I would start by profiling the slow query and then adding an "
        "index on the user id column to see whether that helps",
        "I don't know the exact number but we handled roughly ten thousand requests per "
        "second at peak on that service",
        "I would stop the service, check the logs and then roll back the deploy",
        "I have to go through the logs first and then check the metrics dashboard",
        "My name is Aarav and I work as a machine learning engineer at a fintech startup",
    ):
        assert intent.classify(text)["intent"] == intent.ANSWER, text


def test_confirmation_reads_yes_and_no_and_nothing_else():
    assert intent.classify("yes", confirming=True)["intent"] == intent.YES
    assert intent.classify("yes please end it", confirming=True)["intent"] == intent.YES
    assert intent.classify("no", confirming=True)["intent"] == intent.NO
    assert intent.classify("no sorry, carry on", confirming=True)["intent"] == intent.NO
    assert intent.classify("my mistake, let us continue", confirming=True)["intent"] == intent.NO
    # Not an answer to the question that was asked, so not a yes.
    assert intent.classify("the answer is polymorphism", confirming=True)["intent"] != intent.YES


def test_normalise_handles_missing_apostrophes():
    assert intent.normalise("I DIDN'T hear you!") == "i did not hear you"
    assert intent.normalise("dont know") == "do not know"


# ------------------------------------------------------------------- engine
def _interview(tmp: Path, **options) -> dict:
    """A ready-to-run interview with a fixed five-question plan."""
    config.INTERVIEWS_DIR = tmp
    shape = {"planned_count": 5, "max_followups": 1}
    shape.update(options)
    record = engine.create_interview(
        {"candidate_name": "Aarav Menon", "skills": "python", "projects": "rag"},
        "We need an AI engineer", {"role_title": "AI Engineer"}, "AI Engineer",
        shape, {"kind": "manual"},
    )
    record["plan"] = {
        "opening_line": "Hello Aarav.",
        "closing_line": "Thank you.",
        "questions": [
            {"category": "intro", "question": "Tell me about yourself.", "difficulty": "easy"},
            {"category": "technical", "question": "What is a vector index?",
             "difficulty": "medium"},
            {"category": "technical", "question": "How do you tune recall?",
             "difficulty": "hard"},
            {"category": "project", "question": "Tell me about your RAG project.",
             "difficulty": "medium"},
            {"category": "closing", "question": "Any questions for me?", "difficulty": "easy"},
        ],
    }
    record["status"] = engine.STATUS_READY
    storage.save_interview(record)
    engine.next_prompt(record)          # the opening line
    return record


def test_asking_for_a_repeat_does_not_consume_the_turn():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        res = run(engine.submit_utterance(
            record, asked["turn"], "sorry, could you repeat that?", 3, "voice"))

        assert res["action"] == "repeat"
        assert res["turn"] == asked["turn"]
        assert asked["question"] in res["speech"]
        # Nothing recorded, nothing graded, and the same question still open.
        assert record["turns"][-1]["answer"] == ""
        assert record["turns"][-1]["repeats"] == 1
        assert len(record["turns"]) == 1


def test_not_knowing_is_recorded_but_never_scored():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        res = run(engine.submit_utterance(
            record, asked["turn"], "sorry, I don't know", 2, "voice"))

        assert res["action"] == "recorded"
        assert res["answer_type"] == "no_answer"
        assert res["graded"] is False
        assert res["followup_queued"] is False, "a decline must never be chased"
        # The words are kept - the transcript stays honest - but it is not an answer.
        assert record["turns"][-1]["answer"] == "sorry, I don't know"
        assert engine._progress(record)["answered"] == 0
        assert engine._progress(record)["declined"] == 1


def test_a_decline_changes_the_subject():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        engine.next_prompt(record)                       # intro
        technical = engine.next_prompt(record)           # first technical question
        assert technical["category"] == "technical"

        run(engine.submit_utterance(
            record, technical["turn"], "I have not used that", 2, "voice"))

        # The next planned question was the second technical one; asking it now
        # would be asking the same thing twice.
        assert engine.next_prompt(record)["category"] != "technical"
        # and it is moved, not dropped.
        categories = [q["category"] for q in record["plan"]["questions"]]
        assert categories.count("technical") == 2


def test_asking_to_stop_asks_first_and_then_stops():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        res = run(engine.submit_utterance(
            record, asked["turn"], "I don't want to give this interview", 2, "voice"))
        assert res["action"] == "confirm_end"
        assert record["cursor"]["awaiting_end_confirm"] is True
        assert record["status"] != engine.STATUS_ABANDONED, "nothing ends without confirming"

        res = run(engine.submit_utterance(record, asked["turn"], "yes", 1, "voice"))
        assert res["action"] == "ended"
        assert record["ended_early"] is True
        assert record["ended_by"] == "candidate"


def test_changing_their_mind_carries_on_where_they_were():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        run(engine.submit_utterance(record, asked["turn"], "stop the interview", 2, "voice"))
        res = run(engine.submit_utterance(
            record, asked["turn"], "no sorry, my mistake, carry on", 2, "voice"))

        assert res["action"] == "repeat"
        assert asked["question"] in res["speech"]
        assert record["cursor"]["awaiting_end_confirm"] is False
        assert record["status"] in (engine.STATUS_READY, engine.STATUS_IN_PROGRESS)


def test_an_ambiguous_reply_to_the_confirmation_does_not_end_the_interview():
    """Ending is the irreversible direction, so ambiguity resolves the other way."""
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        run(engine.submit_utterance(record, asked["turn"], "I want to quit", 2, "voice"))
        res = run(engine.submit_utterance(
            record, asked["turn"], "the vector index stores embeddings", 4, "voice"))

        assert res["action"] == "repeat"
        assert not record.get("ended_early")


def test_ending_with_nothing_answered_is_not_a_completed_interview():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)
        run(engine.submit_utterance(record, asked["turn"], "I quit", 2, "voice"))
        run(engine.submit_utterance(record, asked["turn"], "yes", 1, "voice"))

        # An empty report in front of a recruiter would look like a judgement.
        assert record["status"] == engine.STATUS_ABANDONED


def test_silence_is_recorded_as_unanswered_and_moves_on():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)

        res = run(engine.submit_utterance(record, asked["turn"], "", 90, "voice"))

        assert res["action"] == "recorded"
        assert res["answer_type"] == "no_answer"
        assert engine.next_prompt(record)["kind"] == "question"


def test_a_replayed_submit_does_not_record_twice():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        asked = engine.next_prompt(record)
        run(engine.submit_utterance(record, asked["turn"], "I don't know", 2, "voice"))
        before = len(record["turns"])

        res = run(engine.submit_utterance(record, asked["turn"], "I don't know", 2, "voice"))

        assert len(record["turns"]) == before
        assert res["answer_type"] == "no_answer"


def test_the_time_limit_goes_to_the_closing_question_rather_than_cutting_off():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp), time_limit_minutes=30)
        engine.next_prompt(record)
        # Pretend the half hour has passed.
        record["started_at"] = "2020-01-01T00:00:00+00:00"

        asked = engine.next_prompt(record)

        assert asked["category"] == "closing", "the candidate always gets the last word"
        assert "last question" in asked["speech"].lower()
        assert engine._progress(record)["time_remaining_seconds"] == 0


def test_no_time_limit_means_no_clock_pressure():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        record["started_at"] = "2020-01-01T00:00:00+00:00"
        progress = engine._progress(record)

        assert progress["time_limit_seconds"] == 0
        assert progress["time_remaining_seconds"] is None
        assert engine.next_prompt(record)["category"] == "intro"


def test_events_are_capped_so_a_long_session_cannot_grow_unbounded():
    with tempfile.TemporaryDirectory() as tmp:
        record = _interview(Path(tmp))
        for _ in range(260):
            engine.log_event(record, "tab_hidden", "away", seconds=3)
        assert len(record["events"]) == 200


# --------------------------------------------------------------- evaluation
def test_coverage_does_not_count_a_decline_as_an_answer():
    turns = [
        {"answer": "I built the retrieval layer", "assessment": {"answer_type": "substantive",
                                                                 "scores": {"communication": 70}},
         "category": "project", "metrics": {"words": 5}},
        {"answer": "I don't know", "assessment": {"answer_type": "no_answer", "scores": {}},
         "category": "technical", "metrics": {"words": 3}},
        {"answer": "", "assessment": {}, "category": "domain", "metrics": {"words": 0}},
    ]
    cov = evaluation.coverage(turns)

    assert cov["answered"] == 1
    assert cov["declined"] == 1
    assert cov["unanswered"] == 2
    assert "technical" not in cov["categories"], "a decline is not coverage of a topic"


def test_an_interview_ended_early_can_never_report_high_confidence():
    report = evaluation.build_report(
        {"turns": [], "ended_early": True, "end_reason": "The candidate asked to stop.",
         "ended_by": "candidate", "candidate": {}},
        {"confidence": "high", "scores": {}},
    )
    assert report["confidence"] == "low"
    assert report["coverage"]["ended_early"] is True
    assert any("ended before it finished" in r for r in report["confidence_reasons"])


def test_conduct_is_reported_without_touching_the_score():
    record = {
        "turns": [], "candidate": {},
        "events": [
            {"kind": "tab_hidden", "seconds": 12}, {"kind": "tab_hidden", "seconds": 8},
            {"kind": "repeat_requested"},
        ],
    }
    report = evaluation.build_report(record, {"scores": {}, "confidence": "medium"})
    conduct = report["conduct"]

    assert conduct["counts"]["tab_hidden"] == 2
    assert conduct["seconds_away"] == 20.0
    assert report["overall_score"] is None, "conduct must never become a number"


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok    {name}")
            except AssertionError as exc:
                failed += 1
                print(f"  FAIL  {name}: {exc}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{failed} failure(s)" if failed else "\nall tests passed")
    sys.exit(1 if failed else 0)
