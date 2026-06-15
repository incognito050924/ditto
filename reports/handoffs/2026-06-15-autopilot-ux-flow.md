---
title: "Handoff — autopilot UX/flow 개선 (승인 제어 CLI + plan→autopilot 이행 中)"
kind: handoff
created: 2026-06-15 KST
author: hskim, claude
status: ready-to-start
branch: main
work_items: [wi_260615xby]
---

# Handoff — autopilot UX/flow 개선

> 새 세션에서 이어서 구현한다. 이 문서가 권위본 — 조사·결정은 끝났고 **구현만 남았다.**
> 시작 프롬프트는 §7. 작업 대상 = **main** (full-bar 보류 기능은 `archive/acg-full-bar-auto-commit`로
> 따로 보존됨, 이 작업과 무관 — 건드리지 말 것).

## 1. 목표 (범위 보존 — 두 파트, 한 work item `wi_260615xby`)

autopilot의 "거친 사용자 경험"을 둘로 좁혀 개선한다:

- **(A) 승인 게이트 제어 CLI** — pending 승인 게이트를 `autopilot.json` 손편집 없이 다루는 표면 추가.
- **(B) plan→autopilot 이행 (中)** — non-trivial work item이 autopilot을 우회해 닫히는 것을 Stop 훅에서
  감지·유도/제한. 단 진짜 예외(간단·handoff·git·명시 exempt)는 통과.

**범위 밖(하지 말 것):** tidy 스테이지 디커플링(별도 증분으로 보류 — 현재 woven 유지), full-bar 자동커밋
부활(archive에 보존, 무관), autopilot-loop **코어 루프 로직** 변경. (B)는 Stop 훅 정책 변경이지 루프 변경이 아님.

## 2. 조사로 확정된 사실 (재조사 불필요 — file:line 권위)

이미 잘 동작하는 것:
- finalize(deep-interview **또는** tech-spec)가 autopilot을 bootstrap한다 — `skills/deep-interview/SKILL.md:122`(`bootstrapAutopilot`), `skills/tech-spec/SKILL.md:81`("bootstraps autopilot").
- bootstrap 후 Stop 훅이 드라이브를 강제 — `src/hooks/stop.ts:189 autopilotForcesContinuation`(runnable 노드 ∧ approval≠pending → 계속). `hasRunnableNode`(176), `hasPendingMutatingNode`(163), `isDegeneratePendingAutopilot`(172).
- autopilot 스킬은 `user-invocable:false` — 메인 에이전트가 몰게 설계(`skills/autopilot/SKILL.md`).

**확정된 빈틈(= 이번 작업 대상):**
- **(A)** autopilot CLI 서브커맨드 = `bootstrap|next-node|record-result|complete|cleanup|propose-e2e|intent-drift|coverage-next|coverage-round` (`src/cli/commands/autopilot.ts`). **`approve`/`reject`/`status` 없음.** 승인 게이트 상태 enum = `pending|approved|not_required|rejected`(`src/schemas/autopilot.ts:71`). 게이트 객체 필드(autopilot.ts:159~): `status·source·approved_at·approved_by·evidence_refs·change_surface?·plan_brief?{interface_changes,dod,test_scenarios}`. 지금은 pending이면 사용자가 JSON을 손으로 고쳐 status+source를 써야 함(메모리 gotcha #1).
- **(B)** Stop 훅이 완료 경로로 **`completion.json`/`convergence.json` *또는* `autopilot.json`(플랜 있음)을 *동등하게* 인정**(`src/hooks/stop.ts:601`의 블록 메시지: "no completion.json/convergence.json, and no autopilot.json with a plan"). → `work start → 바로 구현 → /ditto:verify(completion.json) → done`으로 **autopilot을 한 번도 안 거치고 닫힘**. 게다가 deep-interview 유도는 *모호할 때만* 조건부(`src/hooks/user-prompt-submit.ts:229` "BOTH conditions") → non-ambiguous 작업은 finalize 자체를 안 거쳐 autopilot.json이 안 생김. 이 둘이 합쳐져 "autopilot이 옵션이고 합법 우회로가 있음".

## 3. 구현 계획

### (A) 승인 게이트 제어 CLI — additive, 루프 코어 불변
`src/cli/commands/autopilot.ts`에 3개 서브커맨드 추가(기존 defineCommand 패턴 그대로):
- `ditto autopilot status <wi>` — 그래프 진행상태 + 승인 게이트 + `plan_brief`/`change_surface` 렌더("무엇을 승인하는가"). 현재 status 표면 없음.
- `ditto autopilot approve <wi> [--by <name>] [--source user]` — brief 먼저 표시 → `approval_gate`: status=approved, source(기본 user), approved_at=now, approved_by 기록. **gotcha #1 직접 해소.**
- `ditto autopilot reject <wi> [--reason <r>]` — status=rejected 기록. 루프가 이미 rejected→rollback 처리(`stop`/`autopilot-loop.ts:128`)하므로 추가 로직 불필요.
- 셋 다 **게이트 필드를 *쓰는* CLI일 뿐 `autopilot-loop.ts` 코어 미변경.** TDD(테스트: 게이트 상태 전이 + 잘못된 wi/상태 처리 + status 렌더).

### (B) plan→autopilot 이행 (中) — Stop 훅 정책 변경
핵심: **non-trivial work item이 autopilot을 거치지 않고 닫히려 할 때 Stop이 유도/차단**하되, 진짜 예외는 통과.
- `src/hooks/stop.ts`의 완료 경로 게이트(주변 라인 601, `readArtifact(intent.json)` 435 활용)에서 판정 추가:
  - 조건: work item이 in_progress ∧ **non-trivial**(휴리스틱 권장: `intent.json` 존재 또는 acceptance_criteria ≥1 또는 artifact 산출) ∧ `autopilot.json` 부재(또는 플랜 없는 degenerate) ∧ completion.json만으로 닫으려 함 → **continuation 강제** + 사유: "non-trivial work는 finalize→bootstrap→autopilot drive를 거쳐라(또는 명시적 exempt)".
  - **예외(통과) 유지:** 간단 작업·handoff·git, 그리고 **명시적 autopilot-exempt 마커**가 있는 work item. → 이 마커(escape hatch)를 정의해야 함(예: work-item 또는 intent에 `autopilot_exempt: true`, 또는 completion에 사유 기록). 이게 (中)의 "예외는 빠져나갈 구멍".
- 기존 백스톱(stop.ts:601 "no verification path") 메시지와 **충돌/중복 않게 통합**할 것. 기존 stop 훅 테스트 회귀 0 필수.
- **autopilot-loop 코어는 안 건드림** — Stop 훅 정책만.

미해결 설계 포인트(구현 시 결정, [DECIDED] 기본값 박아 진행):
- non-trivial 판정 휴리스틱의 정확한 기준 → 기본값: `intent.json 존재 ∨ work-item.acceptance_criteria.length≥1`. 오탐 시 exempt 마커로 회피.
- exempt 마커의 위치/이름 → 기본값: work-item.json에 `autopilot_exempt?: boolean`(스키마 additive·optional, 레거시 무영향).

## 4. 제약 / 규칙
- **autopilot-loop 코어 로직 불변**(사용자 최우선). (A)=additive CLI, (B)=Stop 훅 정책 — 둘 다 루프 미변경.
- Tidy First(구조/동작 분리 커밋), TDD(실패 테스트→최소 구현→리팩터), 증분마다 **전체 `bun test` green + `bun run lint` + `bun run adr:guard`**.
- **CLI 돌리기 전 `bun run build`**(dist/ditto stale 방지).
- 스키마 변경은 additive+optional만(레거시 autopilot.json/work-item.json 무영향).

## 5. work item / ACs (인라인 권위 사본)
`wi_260615xby` (이 PC `.ditto/local`에 존재 — 같은 머신 새 세션이면 그대로 resume).
- **ac-1 [A]** `ditto autopilot approve/reject/status <wi>`가 동작: status는 게이트+brief 렌더, approve→status=approved+source+approved_at/by, reject→status=rejected. 잘못된 wi/상태는 명확한 에러. 증거: 새 CLI 테스트 + 실 실행.
- **ac-2 [B]** Stop 훅: non-trivial work item이 autopilot 미경유로 completion-only close 시 continuation 강제(사유 노출); exempt 마커/간단·handoff·git은 통과. 증거: stop 훅 테스트(양/음성) + 회귀 0.
- **ac-3** 전체 스위트 green + lint + adr-guard. autopilot-loop 코어 diff 0(루프 미변경 확인).
- **ac-4** dialectic-review 권장: (B) Stop 정책이 정상 흐름을 false-block 하지 않는지(오탐), 기존 백스톱과 충돌 없는지 압박검증.

## 6. 검증 명령
```bash
bun run build && bun test                         # 전체 green
bun run lint && bun run adr:guard
bun test tests/**/stop*                           # (B) Stop 훅
bun test tests/**/autopilot*                      # (A) CLI + 회귀
git diff --stat main..HEAD -- src/core/autopilot-loop.ts   # 비어야 함(루프 불변)
```

## 7. 새 세션 시작 프롬프트 (이걸 붙여 시작)
```
reports/handoffs/2026-06-15-autopilot-ux-flow.md 읽고 그대로 이어서 구현해. work item wi_260615xby.

목표: autopilot UX/flow 거친 점 (A)승인 게이트 제어 CLI(approve/reject/status) + (B)plan→autopilot 이행(中, Stop 훅 정책)을 구현. 핸드오프 §3 계획·§4 제약·§5 ACs 그대로 따른다.

규칙: TDD, Tidy First, 증분마다 bun run build + bun test 전체 green + lint + adr-guard. autopilot-loop 코어 로직은 건드리지 않는다((A)=additive CLI, (B)=Stop 훅만). 스키마 변경은 additive+optional만. full-bar 보류 기능(archive/acg-full-bar-auto-commit)은 무관 — 건드리지 말 것. 본격 빌드 전/후 (B)는 dialectic-review로 오탐·백스톱 충돌 압박검증 권장.

먼저 §2의 file:line(stop.ts:189/435/601, autopilot.ts CLI, schemas/autopilot.ts:71/159, user-prompt-submit.ts:229)을 확인하고 (A)부터 착수.
```

## 8. GOTCHA
- `.ditto/local`(work item)은 같은 머신이면 보임. 다른 PC면 이 문서가 권위본(§5 ACs로 `ditto work start` 재등록).
- (B)는 **오탐(정상 흐름 false-block) 위험**이 핵심 — exempt 마커 escape hatch를 먼저 만들고, stop 훅 기존 테스트 회귀 0을 매 증분 확인.
- approve/reject는 게이트 필드만 쓴다. drive(next-node)는 별개 — approve 후 에이전트가 계속 몰면 기존 `autopilotForcesContinuation`이 이어받는다.
