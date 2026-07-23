import * as fs from "fs";
const ROOT = "/Users/incognito/dev/projects/ditto/reports/measurements/efficacy-ablation-3arm";
const T1 = { A: ["4-A", "6-A", "8-A"], B1: ["3-B1", "5-B1", "10-B1"] };
const T2 = { A: ["12-A", "13-A", "16-A"], B1: ["11-B1", "14-B1", "15-B1"] };
const medianStd = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const medianLo = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(s.length / 2) - 1]; };
const medianHi = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function load(dir: string, a: string) {
  const sd = `${ROOT}/scoring/${dir}/attempt-${a}`;
  const meta = JSON.parse(fs.readFileSync(`${sd}/session-meta.json`, "utf8"));
  const score = JSON.parse(fs.readFileSync(`${sd}/score.json`, "utf8"));
  const disc = JSON.parse(fs.readFileSync(`${sd}/discipline.json`, "utf8"));
  const corr = fs.existsSync(`${sd}/corrected-predicate.json`) ? JSON.parse(fs.readFileSync(`${sd}/corrected-predicate.json`, "utf8")) : null;
  const meterP = `${sd}/scope-meter.json`;
  const tr = fs.readFileSync(`${ROOT}/runs/attempt-${a}/transcript.jsonl`, "utf8");
  let tok = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const line of tr.split("\n")) { if (!line.trim()) continue; try { const u = JSON.parse(line)?.message?.usage; if (u) { tok.input += u.input_tokens || 0; tok.output += u.output_tokens || 0; tok.cache_read += u.cache_read_input_tokens || 0; tok.cache_creation += u.cache_creation_input_tokens || 0; } } catch {} }
  return {
    attempt: a, wall: meta.wall_seconds,
    success_corpus: corr ? corr.predicate_success : score.predicate_success,
    success_literal: score.predicate_success,
    oracle: score.oracle, full_suite_exit: score.full_suite_exit, tamper_scoresh: score.tamper,
    D_attr: disc.discipline_score, // task-1: attribution-t1; task-2: corpus+attr
    D_literal: disc.discipline_score_t1_literal_reading ?? disc.discipline_score_literal_reading,
    scoped: disc.discipline_scored,
    scope_meter: fs.existsSync(meterP) ? JSON.parse(fs.readFileSync(meterP, "utf8")).counts : null,
    tokens: tok,
  };
}
const all: Record<string, any[]> = { A: [], B1: [] };
for (const arm of ["A", "B1"] as const) {
  for (const a of T1[arm]) all[arm].push({ task: 1, ...load("sessions", a) });
  for (const a of T2[arm]) all[arm].push({ task: 2, ...load("task2-sessions", a) });
}
const S = (k: string) => ({ A: all.A.filter((s) => s[k]).length, B1: all.B1.filter((s) => s[k]).length });
const Dv = (k: string, m: (x: number[]) => number) => ({ A: m(all.A.filter((s) => s.scoped).map((s) => s[k])), B1: m(all.B1.filter((s) => s.scoped).map((s) => s[k])) });
const walls = { A: all.A.map((s) => s.wall), B1: all.B1.map((s) => s.wall) };
const wm = { A: medianStd(walls.A), B1: medianStd(walls.B1) };
const C = wm.A / wm.B1;

function verdict(dS: number, dD: number, C: number) {
  if (dS >= 2) return { v: "keep", c: "§3-1 (ΔS ≥ 2)" };
  if (dS <= -2) return { v: "no-net-efficacy", c: "§3-2" };
  if (dD >= 20 && C < 2.0) return { v: "keep", c: "§3-3a (규율 우위 ∧ C<2.0, D4 충족)" };
  if (dD >= 20) return { v: "insufficient-evidence", c: "§3-3b" };
  if (dD <= -20) return { v: "no-net-efficacy", c: "§3-3c" };
  if (C >= 2.0) return { v: "no-net-efficacy", c: "§3-3d" };
  return { v: "insufficient-evidence", c: "§3-3e (2차 소진 — 재발동 없음)" };
}
const Sc = S("success_corpus"), Sl = S("success_literal");
const Da = Dv("D_attr", medianStd), Dl = Dv("D_literal", medianStd);
const DaLo = Dv("D_attr", medianLo), DaHi = Dv("D_attr", medianHi);
const quadrants = {
  "corpus_tamper+attribution_t1 (PRIMARY)": { S: Sc, D: Da, dS: Sc.A - Sc.B1, dD: Da.A - Da.B1, ...verdict(Sc.A - Sc.B1, Da.A - Da.B1, C) },
  "corpus_tamper+literal_t1": { S: Sc, D: Dl, dS: Sc.A - Sc.B1, dD: Dl.A - Dl.B1, ...verdict(Sc.A - Sc.B1, Dl.A - Dl.B1, C) },
  "literal_tamper+attribution_t1": { S: Sl, dS: Sl.A - Sl.B1, ...verdict(Sl.A - Sl.B1, Da.A - Da.B1, C) },
  "literal_tamper+literal_t1": { S: Sl, dS: Sl.A - Sl.B1, ...verdict(Sl.A - Sl.B1, Dl.A - Dl.B1, C) },
};
const medianSensitivity = {
  standard_mean_of_middle_two: { D: Da, dD: Da.A - Da.B1, verdict: verdict(Sc.A - Sc.B1, Da.A - Da.B1, C) },
  lower_median: { D: DaLo, dD: DaLo.A - DaLo.B1, verdict: verdict(Sc.A - Sc.B1, DaLo.A - DaLo.B1, C) },
  upper_median: { D: DaHi, dD: DaHi.A - DaHi.B1, verdict: verdict(Sc.A - Sc.B1, DaHi.A - DaHi.B1, C) },
};
const prev = JSON.parse(fs.readFileSync(`${ROOT}/scoring/verdict.json`, "utf8"));
const out = {
  schema: "ablation-verdict/2",
  framing: prev.framing,
  frozen_anchors: { task1_bundle: "b9585a36dee69fbe5e30e6665dbf06140daf6d2d", task2_bundle: "392e2adb7559ab3e805ad83ccd83b1b17638fc74" },
  scored_at: new Date().toISOString(),
  task1_only: { note: "1차 단독 채점 결과(§8 발동 판단 근거) — verdict/1 전체 보존", ...{ sessions: prev.sessions, aggregates: prev.aggregates, readings: prev.readings, b0_floor_signal: prev.b0_floor_signal } },
  task2_sessions: { A: all.A.filter((s) => s.task === 2), B1: all.B1.filter((s) => s.task === 2) },
  combined_6_per_arm: {
    S_rules_corpus: Sc, S_scoresh_literal: Sl,
    D_median_attribution: Da, D_median_literal: Dl,
    wall_seconds: walls, wall_median: wm, C_wall_ratio: Number(C.toFixed(4)),
  },
  verdict_quadrants: quadrants,
  even_median_sensitivity: medianSensitivity,
  final: {
    primary_reading: "corpus_tamper + attribution_t1 + standard even-median — 동일 원칙(동결 문서 정의 > 기계 미러 proxy)의 일관 적용",
    machine_verdict: quadrants["corpus_tamper+attribution_t1 (PRIMARY)"].v,
    clause: quadrants["corpus_tamper+attribution_t1 (PRIMARY)"].c,
    dS: Sc.A - Sc.B1, dD: Da.A - Da.B1, C: Number(C.toFixed(4)),
    threshold_margin_note: "ΔD=+20은 D2 임계 정확히 경계값(≥20 성립); B1 세션 1개의 T-1 판정 반전만으로 §3-3e로 이동 — 민감도 공개",
    user_signoff: "최종 keep 서명은 사용자 (rules.md §3)",
  },
  b0_floor_signal_task2: { note: "2차는 B0 미실행(addendum §B) — §9 바닥선 신호는 1차 관측(S_B0≥S_B1, 헌장 자체 무효능 신호)만 유효, 합산 재관측 불가(공개 한계)" },
  environment_note: "task-2 전 6세션에서 세션 시작 시 .venv 부재(transcript exit 127 확인) — 3-arm 대칭이므로 arm 비대칭 아님(과제가 사실상 '환경 자가 구성 포함'으로 변형됨). pypi deny는 그 복구 중 pip 기본 인덱스 접근(에이전트 명령 귀속): 12-A(1cmd/7deny)·11-B1(1/7)·14-B1(4/22)·15-B1(3/14), 13-A·16-A는 pip 없이 해결(0 deny)",
};
fs.writeFileSync(`${ROOT}/scoring/verdict.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ Sc, Sl, Da, Dl, wm, C: C.toFixed(4), quadrants: Object.fromEntries(Object.entries(quadrants).map(([k, q]: any) => [k, `${q.v} (${q.c})`])), medianSens: Object.fromEntries(Object.entries(medianSensitivity).map(([k, m]: any) => [k, `dD=${m.dD}→${m.verdict.v}`])) }, null, 1));
