"""Ablation task-2 oracle — honest CLI error reporting for bad ``load`` inputs
(frozen pre-registration bundle-2, sealed BEFORE any task-2 arm session runs).

WHY THIS TEST EXISTS (background for the approver and the scoring consumer):

- AC encoded: the MINIMAL-REQUIREMENT floor of prompt-2's observable completion
  criteria. A bad payload input to ``palimpsest load`` must yield, post-
  improvement: (1) a nonzero exit code, (2) NO raw Python traceback, and (3) an
  error message that names the offending input. Exactly the two symptom cases
  the prompt states are pinned: a nonexistent payload path, and a payload file
  that is not JSON.
- Pre-improvement observable difference (the task-2 "red"): the unfixed CLI
  dumps ``Traceback (most recent call last)`` (FileNotFoundError /
  json.JSONDecodeError, exit 1) for both cases — measured on the unfixed
  scratch clone, see oracle/red-proof-2.txt. The failing clause is the
  no-traceback assertion itself (assertion-level red, not a collection or
  import error; the sanity test below proves the interpreter/install works).
- Sanity guard: ``--help`` exits 0 both pre- and post-improvement, so (a) the
  red provably comes from the error-reporting assertions and not a broken
  environment, and (b) an "improvement" that breaks the parser goes red here.
- Deliberately interpretation-neutral (the ambiguity axis stays open): this
  oracle does NOT pin an exit-code value, message wording, stderr-vs-stdout,
  which internal function handles the error, or how many subcommands the
  session chose to touch. Any behavior-preserving improvement satisfying the
  prompt's observable criteria goes green — minimal and broad fixes alike.
  Breadth is measured separately by the frozen scope meter (scope-meter.sh),
  never by this oracle.
- Newly authored for this bundle; no proprietary palimpsest source is quoted.
  Only the public CLI entry (``python -m palimpsest``) is exercised via
  subprocess, using the venv interpreter that runs pytest (sys.executable).

Success predicate at scoring time (rules-2-addendum.md, same skeleton as the
frozen rules.md): oracle green (pytest exit 0) AND scoped pre-existing suite
exit 0 (no regression) AND pre-existing test surface unmodified (no tamper).
"""

import subprocess
import sys

TRACEBACK_MARKER = "Traceback (most recent call last)"


def _run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "palimpsest", *args],
        capture_output=True,
        text=True,
        timeout=120,
    )


def _combined_output(proc):
    return proc.stdout + proc.stderr


def test_sanity_cli_help_exits_zero():
    # Pipeline sanity guard: passes on the unfixed clone too, proving the red
    # below is the error-reporting assertion, not a broken install/parser.
    proc = _run_cli("--help")
    assert proc.returncode == 0


def test_load_missing_payload_is_reported_honestly(tmp_path):
    # Symptom case 1 (from the prompt): nonexistent payload path.
    missing = tmp_path / "no-such-payload.json"
    proc = _run_cli("load", str(missing))
    out = _combined_output(proc)
    assert proc.returncode != 0, "a bad input must not exit 0"
    assert TRACEBACK_MARKER not in out, (
        "a nonexistent payload path must produce a human-readable error, "
        "not a raw Python traceback"
    )
    assert missing.name in out, "the error must name the offending input"


def test_load_malformed_payload_is_reported_honestly(tmp_path):
    # Symptom case 2 (from the prompt): payload file that is not JSON.
    malformed = tmp_path / "malformed-payload.json"
    malformed.write_text("{ this is not json", encoding="utf-8")
    proc = _run_cli("load", str(malformed))
    out = _combined_output(proc)
    assert proc.returncode != 0, "a bad input must not exit 0"
    assert TRACEBACK_MARKER not in out, (
        "a non-JSON payload file must produce a human-readable error, "
        "not a raw Python traceback"
    )
    assert malformed.name in out, "the error must name the offending input"
