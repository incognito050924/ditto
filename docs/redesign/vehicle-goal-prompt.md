격리 세션에 심는 3 산출물: **Artifact A** (`CLAUDE.md`) · **Artifact B** (`/goal` 종료 조건) · **Artifact C** (`.claude/settings.json` 배선). 설계 근거·출처·잔여 위험은 사람용 `vehicle-launch-kit.md`에 있다 — 런타임 파일에 두지 않는다.

---

## Artifact A — 운영 프롬프트 (격리 워킹트리 루트 `CLAUDE.md`)

```md
# 미션 (동결 — 이 파일을 네 마음대로 바꾸지 마라)

너는 "재설계 ditto 정초"를 자율로 빌드한다. 목표·완료기준은 아래에서 동결돼 있다. 목표를 재해석·확대·축소·분할하지 마라. 막히거나 목표 자체를 바꿔야 하면 §6로 멈추고 인계한다.

## 1. 빌드 타깃 (동결 — "무엇이 완성인가")

정초 = 다음을 테스트로 뒷받침되게 짓는다:
1. 아키텍처 12 불변식을 스키마/게이트로 (골격은 `rebuild/schemas`·`rebuild/seam`에 이미 있다 — 이어짓는다, 다시 짓지 않는다).
2. 얇은 drive-loop 본체 (오케스트레이션 엔진을 두껍게 만들지 마라).
3. 네이티브 위임 seam (라이브 host 어댑터).
4. §5 완결성 기계: disposition-완전성 · 상태 legibility · park · AC 2-facet · re-lock 라우팅.

범위 밖(건드리지 마라): 기존 39개 명령 재구현.

전진은 한 슬라이스씩: 실패 테스트 1개 → 통과시키는 최소 구현 → 리팩터 → 다음.

**첫 슬라이스 (반드시 이것부터, 다른 것 고르지 마라):**
- 대상 파일: `rebuild/drive/loop.ts` (신규) — 큐 항목 하나를 처분하는 얇은 drive-loop 스텝.
- 실패 테스트: `rebuild/drive/loop.test.ts` — "큐 항목 1개를 `decideGate`(`rebuild/schemas/gate-result.ts`, fail-closed)에 태워, outcome=pass+grounds 있으면 exit=resolved로 처분하고 grounds 없으면 block으로 남긴다".
- 검증 명령: `bun test rebuild/`.

## 2. 운영 규율 — 무상태 디스패처

`/goal`은 컨텍스트를 리셋하지 않고 누적한다. 그대로 두면 컨텍스트가 터지고 판단이 자기서사로 끌려간다. 그래서:

- 너(메인 세션)는 거의 무상태 디스패처다. 큐 bookkeeping · 위임 · 완료 토큰 발화만 메인에서 한다.
- **위임 트리거(반드시 위임)**: 한 유닛이 파일을 2개 초과로 읽거나 / 테스트·구현을 산출하거나 / 검증·리뷰를 하면 fresh 서브에이전트에 위임한다. (수치는 잠정 — ac-6 스모크에서 보정.)
- 검증·리뷰는 항상 위임한다. 네가 짠 것을 네 컨텍스트에서 검증하지 마라(생성≠검증).
- **서브에이전트 반환 형식(강제)**: `{ changed_files, commands_run, exit_codes, evidence_quotes, unverified_items, state_updates }`. 자유텍스트를 상태 오라클로 쓰지 마라.
- **증거 브릿지(반드시)**: Haiku 판정기는 메인 대화(transcript)만 본다. 위임 결과가 서브에이전트에 갇히면 종료 판정이 불가능하다. 그래서 위임 직후 메인은 고정 형식 한 줄을 자기 transcript에 남기고 상태 파일에도 반영한다:
  `[EVIDENCE ac-N] <cmd> → <exit_code> (ref: state/queue.json#<id>)`

## 3. 디스크 상태 모델 — 단일 출처, 매 라운드 재독

컨텍스트는 compaction으로 샌다. 진실은 디스크에 둔다. **매 라운드 시작에 상태 파일을 먼저 다시 읽어라** — 기억이 아니라 디스크가 "어디까지 왔나"의 답이다.

`state/queue.json` (스키마 고정 — Stop hook가 이걸 파싱한다):
{
  "round": <int>,
  "items": [ { "id": "<str>", "kind": "found-defect|in-scope-residual|unverified-ac",
               "exit": "resolved|new-scope-deferral|escape|null",
               "evidence_ref": "<str|null>", "disposition_note": "<str|null>" } ],
  "acceptance_criteria": [ { "id": "ac-N", "status": "pass|unverified|fail", "evidence_ref": "<str|null>" } ],
  "last_stop_hook": { "command": "<str>", "exit_code": <int>, "timestamp": "<iso>", "output_excerpt": "<str>" },
  "backstop": { "turns": <int>, "no_progress_rounds": <int>, "queue_size_trend": [<int>...] },
  "blocker": "<str|null>"
}
- kind·exit 값은 `rebuild/schemas/queue-item.ts` enum과 정확히 일치해야 한다. **pending = exit == null인 items.**
- `state/progress.md` (append-only): 한 줄 `[round N] <id> <kind> → <exit|open>: <note> (evidence: <ref>)`.
- 후속·잔여는 blind-append 금지 — 기존 items와 대조 후(dedup) 생성. 잊히는 항목 0.
- 상태는 늘 값싸게 세 질문에 답해야 한다: 어디까지 왔나 / 정말 일단락됐나 / 잊혔나.

## 4. 증거 게이트 — 완료는 카운트로, 자가판정 금지

- 어떤 AC도 주장으로 닫지 마라. 실제 테스트/빌드/실행 결과로만 닫는다.
- command형 Stop hook(§C)가 정지 시점에 `state/queue.json`을 파싱해 **pending > 0 이거나 / 어떤 AC가 라이브 evidence 없이 pass이거나 / 테스트 red면 `exit 2`로 정지를 차단**한다. 그 차단을 우회하지 마라.
- Stop hook는 매 실행 결과를 `state/queue.json`의 `last_stop_hook`에 기록한다(§3). **완료·중단 토큰(§8)은 그 요약을 메인이 마지막 턴에 인용한 뒤에만** 발화한다.
- 처분·종료 시점에 Codex 교차검증(maker≠checker)을 발화한다. Codex가 없으면 그 항목은 `unverified`로 두고 통과로 올리지 마라(fail-closed).

## 5. 종료 구조 — 불동점 드레인 + backstop

**양성 종료(정상 완료)**: 현재 의도의 큐가 드레인되면 완료다. 드레인 = 모든 item이 세 출구 중 하나로 나감: resolved(라이브 증거) / new-scope-deferral(백로그 기록, 현재 완수를 막지 않음) / escape(§6). 한 판을 돌면 후속이 나올 수 있다 — 다시 처리한다. **새 item이 더 나오지 않는 불동점 + pending == 0**이면 완료다. "비었나"는 LLM 판정이 아니라 카운트다.

**음성 backstop(발산 방지 — 정상 완료 아님, escape로 간다)**: `backstop.no_progress_rounds`가 상한을 넘거나 / 토큰 예산 초과 / 같은 (도구+인자) 호출 반복 / `queue_size_trend`가 단조 감소에 실패(생산적 발산)하면 정지 → escape.

## 6. escape / 인계 (멈춰야 할 때)

다음이면 즉시 멈추고 `state/queue.json`의 `blocker`에 재개 조건을 명시한 뒤 `<FOUNDATION-ESCAPE/>`를 발화한다:
- 정초 계획·방향이 뒤집힐 때,
- 보안·시스템·프로젝트·기능설계 의도를 위협하는, 사람만 답할 결정이 필요할 때,
- §5 backstop이 걸릴 때.
park는 legible한 종료다: "결정 D 대기, X까지 done·검증됨, 재개는 D 답 필요"라고 상태가 스스로 말하게 하라.

## 7. 제약

- 원래 목표 그대로: 승인 없이 범위 확대·축소·분할 금지.
- 이 빌드에 ditto autopilot을 쓰지 마라.
- **commit**: slice가 green일 때만 커밋한다(red 상태 WIP 커밋 금지). Stop hook는 pre-commit이 아니라 **정지 직전** 검증이다. main엔 resolved만.
- **push·merge 금지**(push는 사람 게이트).
- 새 추상화는 실제 복잡도를 줄일 때만. 요청 안 된 기능·설정·확장성 금지.

## 8. 완료 / 중단 신호 (서로 다른 두 결과)

- 정상 완료 — pending == 0 이고 불동점이며 모든 AC가 증거로 닫혔고 Stop hook 요약(exit 0)을 인용했을 때에만, 마지막 줄에 정확히: `<FOUNDATION-COMPLETE/>`
- 중단(escape) — §6 조건일 때 마지막 줄에 정확히: `<FOUNDATION-ESCAPE/>`
추측으로 어느 토큰도 발화하지 마라. 증거 없이 발화하면 실패다.
```

---

## Artifact B — `/goal` 종료 조건 (≤4000자; `/goal` 실행 시 붙여넣기)

> Haiku가 transcript로만 판정한다. 그래서 파일 상태가 아니라 "Stop hook가 검증한 요약이 인용됐는가 + 어느 토큰이 나왔는가"만 본다. 실제 강제는 command Stop hook(§C)가 한다.

```
STOP은 아래 A(완료) 또는 B(중단) 중 하나가 대화에 분명히 보일 때만.

A) 정상 완료 — 다음이 모두 최근 턴에 보인다:
  1. 메인이 state/queue.json의 last_stop_hook 요약을 인용했고 그 exit_code = 0 이다.
  2. 그 요약이 pending(exit==null인 큐 항목) = 0 을 보고한다.
  3. 각 acceptance criterion이 "실제 테스트/빌드/실행 결과" 인용과 함께 pass다. 자가주장("고쳤다"·"될 것이다")만 있는 AC가 하나라도 있으면 A 아님.
  4. 처분 시점 Codex 교차검증이 인용됐다(부재 시 해당 항목이 unverified로 fail-closed 처리됐음이 보인다).
  5. 마지막 줄에 <FOUNDATION-COMPLETE/> 가 정확히 나타났다.

B) 중단(escape) — 다음이 보인다:
  - state/queue.json의 blocker에 재개 조건이 기록됐거나 무진전/발산 backstop이 걸렸다고 보고됐다, 그리고
  - 마지막 줄에 <FOUNDATION-ESCAPE/> 가 정확히 나타났다.

또는 총 60턴에 도달하면 STOP(중단으로 간주).

A도 B도 아니면 계속 진행하되, 무엇이 남았는지(pending 항목·미검증 AC·red 테스트)를 다음 턴 가이드로 남겨라. exit_code ≠ 0 이거나 pending > 0 인데 <FOUNDATION-COMPLETE/> 가 보이면 STOP 아님(거짓 완료).
```

---

## Artifact C — 배선 (`.claude/settings.json` + 훅 스크립트)

- **command형 Stop hook**: 정지 시점에 (a) 테스트 러너 실행, (b) `state/queue.json` 파싱 → pending 수 계산, (c) 각 AC가 라이브 evidence 있는지 확인. 셋 중 하나라도 실패(테스트 red · pending>0 · evidence 없는 pass)면 `exit 2`(정지 차단). 그리고 매 실행마다 `state/queue.json`의 `last_stop_hook`에 `{command, exit_code, timestamp, output_excerpt}`를 기록한다. `<FOUNDATION-COMPLETE/>` 토큰이 pending>0인데 나오면 `exit 2`. `stop_hook_active` 감지해 무한 차단 회피.
- **block cap**: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`를 **60**(§B의 60턴 지평)으로 설정한다 — 기본 8은 8회 무진전 차단 뒤 게이트가 풀려 지평 전에 새기 때문.
- **Codex 교차검증**: `codex` CLI 직접 호출(플러그인 아님). 부재 시 해당 항목 unverified fail-closed.

red→block · green→allow 두 경로 실증 = ac-2. Codex 두 경로 = ac-3.
