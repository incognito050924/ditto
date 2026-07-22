"""Ablation oracle — shadowed-`fetch` false-positive repro (frozen pre-registration bundle).

WHY THIS TEST EXISTS (background for the approver and the scoring consumer):

- AC encoded: wi_2607227xx ac-3 — the oracle must be authored+sealed BEFORE any
  arm session runs, must be RED (pytest exit 1) on the unfixed clone, and is
  re-injected from the frozen bundle (digest-verified) at scoring time so a
  session cannot forge the sealed test.
- Behavior asserted: a call whose callee `fetch` is a LOCAL lexical binding
  (``const fetch = …`` in the same module) is NOT the WHATWG global ``fetch``
  and therefore must NOT be extracted as an outbound-HTTP ApiCall node. The
  unfixed recognizer resolves a callee only through its import bindings and the
  global-name registry — it never consults same-file lexical bindings — so the
  shadowed call below yields a false-positive ApiCall and the assertion fails
  (that failure IS the red; it is an assertion failure, not a collection error).
- Edge pinned: shadowing via a module-top-level ``const`` arrow-function
  binding. A genuine global ``fetch`` in a sibling file is asserted recognized
  as a sanity guard, so (a) the red provably comes from the shadow assertion,
  not a broken extraction pipeline, and (b) a "fix" that simply stops
  recognizing ``fetch`` altogether goes red here too.
- Minimal-derivation: the JS fixture snippets are NEWLY AUTHORED for this
  bundle; no proprietary palimpsest source is quoted. Only public API imports
  and calls are used.

Success predicate at scoring time (frozen in rules.md): oracle green (exit 0)
AND full pre-existing pytest suite passes (no regression) AND pre-existing test
surface unmodified (no tamper).
"""

from palimpsest.extract.javascript import extract as extract_js
from palimpsest.ir import API_CALL, Provenance

# Synthetic provenance — the oracle corpus is authored inline, not a git checkout.
PROV = Provenance(
    source_commit="a" * 40,
    author="ablation-oracle <ablation@localhost>",
    committed_at="2026-07-23T00:00:00+09:00",
)

# Newly authored fixture: `fetch` here is a module-local job-queue helper that
# SHADOWS the global name — calling it performs no HTTP at all.
SHADOWED_FETCH_JS = (
    "const jobs = [];\n"
    "const fetch = (path) => jobs.push(path);\n"
    "fetch('/jobs/backfill');\n"
)

# Newly authored sanity fixture: a genuine WHATWG-global fetch call.
GLOBAL_FETCH_JS = "fetch('/health/ping');\n"


def _extract(tmp_path, files):
    for rel, src in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(src)
    return extract_js(tmp_path, PROV, repo_name="oracle-corpus")


def _apicall_qns(ir):
    return {n.qualified_name for n in ir.nodes_of(API_CALL)}


def test_sanity_global_fetch_is_recognized(tmp_path):
    # Pipeline sanity guard: a real global fetch stays an ApiCall. Passing on
    # the unfixed clone proves the red below is the shadow assertion itself.
    ir = _extract(tmp_path, {"health.js": GLOBAL_FETCH_JS})
    assert "apicall:GET /health/ping" in _apicall_qns(ir)


def test_shadowed_fetch_is_not_an_apicall(tmp_path):
    # THE oracle assertion (red on the unfixed clone): the locally shadowed
    # `fetch` is not the global fetch — no ApiCall may be emitted for it.
    ir = _extract(tmp_path, {"queue.js": SHADOWED_FETCH_JS})
    assert "apicall:GET /jobs/backfill" not in _apicall_qns(ir), (
        "false positive: locally shadowed `fetch` (const fetch = …) was "
        "extracted as an outbound-HTTP ApiCall"
    )
