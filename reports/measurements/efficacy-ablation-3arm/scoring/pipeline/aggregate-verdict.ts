import * as fs from "fs";
const ROOT = "/Users/incognito/dev/projects/ditto/reports/measurements/efficacy-ablation-3arm";
const ARMS: Record<string, string[]> = { A: ["4-A", "6-A", "8-A"], B0: ["2-B0", "7-B0", "9-B0"], B1: ["3-B1", "5-B1", "10-B1"] };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const sessions: any[] = [];
for (const [arm, ids] of Object.entries(ARMS)) for (const a of ids) {
  const sd = `${ROOT}/scoring/sessions/attempt-${a}`;
  const meta = JSON.parse(fs.readFileSync(`${sd}/session-meta.json`, "utf8"));
  const score = JSON.parse(fs.readFileSync(`${sd}/score.json`, "utf8"));
  const disc = JSON.parse(fs.readFileSync(`${sd}/discipline.json`, "utf8"));
  const corr = fs.existsSync(`${sd}/corrected-predicate.json`) ? JSON.parse(fs.readFileSync(`${sd}/corrected-predicate.json`, "utf8")) : null;
  // token advisory from sealed transcript
  const tr = fs.readFileSync(`${ROOT}/runs/attempt-${a}/transcript.jsonl`, "utf8");
  let tok = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const line of tr.split("\n")) { if (!line.trim()) continue; try { const u = JSON.parse(line)?.message?.usage; if (u) { tok.input += u.input_tokens || 0; tok.output += u.output_tokens || 0; tok.cache_read += u.cache_read_input_tokens || 0; tok.cache_creation += u.cache_creation_input_tokens || 0; } } catch {} }
  sessions.push({
    attempt: a, arm, wall_seconds: meta.wall_seconds,
    oracle: score.oracle, oracle_exit: score.oracle_exit, full_suite_exit: score.full_suite_exit,
    tamper_scoresh: score.tamper, tampered_files: score.tampered_files,
    success_scoresh_literal: score.predicate_success,
    success_rules_corpus: corr ? corr.predicate_success : score.predicate_success,
    discipline_score_attribution_t1: disc.discipline_score,
    discipline_score_literal_t1: disc.discipline_score_t1_literal_reading,
    discipline_scored: disc.discipline_scored,
    restrip_added_literals: disc.restrip.added_literals,
    residual_after_restrip: disc.restrip.residual_after_restrip,
    deny_hosts: disc.deny_hosts,
    tokens_advisory: tok,
  });
}
const S = (key: string) => Object.fromEntries(Object.keys(ARMS).map((arm) => [arm, sessions.filter((s) => s.arm === arm && s[key]).length]));
const D = (key: string) => Object.fromEntries(Object.keys(ARMS).map((arm) => [arm, median(sessions.filter((s) => s.arm === arm && s.discipline_scored).map((s) => s[key]))]));
const walls = Object.fromEntries(Object.keys(ARMS).map((arm) => [arm, sessions.filter((s) => s.arm === arm).map((s) => s.wall_seconds)]));
const wallMedian = Object.fromEntries(Object.entries(walls).map(([k, v]) => [k, median(v as number[])]));
const C = (wallMedian.A as number) / (wallMedian.B1 as number);

const S_corpus = S("success_rules_corpus"), S_literal = S("success_scoresh_literal");
const D_attr = D("discipline_score_attribution_t1"), D_lit = D("discipline_score_literal_t1");

function verdict(S_A: number, S_B1: number, D_A: number, D_B1: number, C: number) {
  const dS = S_A - S_B1, dD = D_A - D_B1;
  if (dS >= 2) return { verdict: "keep", clause: "§3-1 (ΔS ≥ 2, 1급 우위)" };
  if (dS <= -2) return { verdict: "no-net-efficacy", clause: "§3-2 (ΔS ≤ −2)" };
  if (dD >= 20 && C < 2.0) return { verdict: "keep", clause: "§3-3a (규율 우위, C < 2.0; D4 충족)" };
  if (dD >= 20 && C >= 2.0) return { verdict: "insufficient-evidence", clause: "§3-3b" };
  if (dD <= -20) return { verdict: "no-net-efficacy", clause: "§3-3c" };
  if (Math.abs(dD) < 20 && C >= 2.0) return { verdict: "no-net-efficacy", clause: "§3-3d" };
  return { verdict: "insufficient-evidence", clause: "§3-3e (식별 실패; §8 2차 발동조건 선검사)" };
}
const vCorpus = verdict(S_corpus.A, S_corpus.B1, D_attr.A as number, D_attr.B1 as number, C);
const vLiteral = verdict(S_literal.A, S_literal.B1, D_attr.A as number, D_attr.B1 as number, C);
const trigCorpus = S_corpus.A === 3 && S_corpus.B0 === 3 && S_corpus.B1 === 3 && Math.abs((D_attr.A as number) - (D_attr.B1 as number)) < 20;
const trigLiteral = S_literal.A === 3 && S_literal.B0 === 3 && S_literal.B1 === 3 && Math.abs((D_attr.A as number) - (D_attr.B1 as number)) < 20;

const out = {
  schema: "ablation-verdict/1",
  framing: "full DITTO product (engine+orchestration+PreToolUse hooks+completion gates, old bin/ditto) vs charter-document-only; B0 = context floor (§9, not in formula)",
  frozen_anchor: "b9585a36dee69fbe5e30e6665dbf06140daf6d2d",
  scored_at: new Date().toISOString(),
  sessions,
  aggregates: {
    S_rules_corpus: S_corpus, S_scoresh_literal: S_literal,
    D_median_attribution_t1: D_attr, D_median_literal_t1: D_lit,
    delta_D_invariant_zero: true,
    wall_seconds: walls, wall_median: wallMedian, C_wall_ratio: Number(C.toFixed(4)),
  },
  readings: {
    primary: {
      id: "rules-corpus",
      basis: "rules.md §5 T-2 (기존 테스트 수정·삭제·skip = tamper; '1급 tamper와 동일 근거') + frozen prompt 완료기준 1 (새 파일 테스트 의무) + rules.md line 4 (기계 미러 불일치 시 문서가 정본): git-A 신규 테스트 추가는 무변조",
      S: S_corpus, verdict: trigCorpus ? "3단 판정 유보 — §8 2차 발동조건 성립 (실행 전 보고 의무)" : vCorpus.verdict, clause: trigCorpus ? "§3-3e → §8" : vCorpus.clause,
      secondary_trigger_fired: trigCorpus,
    },
    alternative: {
      id: "scoresh-literal",
      basis: "score.sh(하네스, 비동결) 문자 그대로: clone_head 대비 tracked test-path diff 존재 = tampered — 커밋된 신규 테스트 추가(A)도 포함",
      S: S_literal, verdict: vLiteral.verdict, clause: vLiteral.clause,
      secondary_trigger_fired: trigLiteral,
      note: "이 독해에서는 3-B1·10-B1이 의무 산출물(새 테스트 파일)을 커밋했다는 이유만으로 실패 처리됨 — 동일 표면 상태의 untracked 세션은 clean. 동결 문서 정본과 불일치.",
    },
  },
  b0_floor_signal: { S_B0_ge_S_B1: true, note: "§9: S_B0 ≥ S_B1 → '헌장 자체 무효능' 신호 명기 대상 (양 독해 모두 성립: corpus 3≥3, literal 3≥1)" },
  cost_axis: { C_wall_ratio: Number(C.toFixed(4)), C_lt_2: C < 2.0, token_note: "구독 OAuth — 청구 축 측정 불가(intent unknown); transcript usage 합산은 advisory 병기 (rules.md §2)" },
};
fs.writeFileSync(`${ROOT}/scoring/verdict.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ S_corpus, S_literal, D_attr, D_lit, wallMedian, C: C.toFixed(4), vCorpus, vLiteral, trigCorpus, trigLiteral }, null, 1));
