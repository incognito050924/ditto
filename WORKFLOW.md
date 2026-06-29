# DITTO 작업 표준 — 정식/약식 2경로

> ditto를 처음 쓰는 사람을 위한 안내. 코드를 바꾸는 모든 작업은 **딱 두 가지 경로** 중 하나로만 진행한다. 그 밖의 "그냥 콘솔에서 고치기"는 금지된다.

## 왜 경로가 있나

코드를 바꾸기만 하고 work item으로 추적하지 않으면, 그 작업은 **완료(done)·회고(retrospective)·정리(cleanup)** 를 거치지 않은 채 남는다. 끝난 줄 알았지만 닫히지 않은 작업이 쌓이고, 무엇이 왜 바뀌었는지 증거가 남지 않는다. ditto는 이걸 막으려고 모든 변경을 두 경로 중 하나에 태운다.

**핵심 규칙:** 경로는 둘뿐이다. 둘 중 하나를 고르는 건 네 판단이지만, **둘 다 건너뛰는 건 선택지가 아니다.** TDD는 경로 *안에서* 구현하는 방법이지, 경로를 대신하는 게 아니다.

## 두 경로 한눈에

| | **약식 (light)** | **정식 (heavy)** |
|---|---|---|
| 언제 | 작고 되돌릴 수 있는 변경. 국소적(≈단일 파일), 외부·비가역 효과 없음, 관측 기준 1~2개로 표현 가능 | 모호하거나, 비가역적이거나, 여러 표면에 걸친 작업. 의미가 제품/도메인에 달려 있거나 구현 방향이 둘 이상 | 
| 흐름 | `work set-criteria` → `verify` → `work done` | `/ditto:deep-interview` → pre-mortem → `ditto autopilot` |
| 무엇을 하나 | 관측 가능한 진짜 기준을 세우고, 증거로 검증하고, 닫는다 | 의도를 캐묻고, 위험을 미리 점검하고, 노드 그래프를 자동 구동한다 |
| 비용 | 가볍다 (인터뷰·그래프 없음) | 무겁다 (의도 잠금 + 계획 잠금) |

> 잘 모르겠으면 **정식(heavy)으로 올린다.** 위험이 선언된 작업(`--risk`)은 기본이 정식이다.

## 약식 경로 — 따라하기

작고 되돌릴 수 있는 변경(예: 버그 한 줄 수정, 메시지 문구 교정).

```bash
# 1) work item 등록 (에이전트가 자동으로 해줌 — 직접 칠 필요 없음)
ditto work start "<목표>" --request "<원래 요청 그대로>"

# 2) 관측 가능한 진짜 기준을 세운다 (placeholder를 교체)
ditto work set-criteria <wi-id> --criteria "<무엇이 참이면 끝났다고 할 수 있는가>"

# 3) 각 기준을 실제 명령 증거로 검증한다
ditto verify <wi-id> --criterion <ac-1> -- <검증 명령>

# 4) 닫는다 (모든 기준이 증거로 pass여야 함)
ditto work done <wi-id>
```

## 정식 경로 — 따라하기

모호하거나 비가역적이거나 여러 표면에 걸친 작업.

```bash
# 1) 의도를 캐묻고 잠근다 — 인터뷰가 intent.json을 만든다
/ditto:deep-interview          # (또는: ditto deep-interview start → record-turn → check-readiness → finalize)

# 2) 계획을 자동 구동한다 — 노드 그래프를 끝까지 몰고 간다
ditto autopilot bootstrap --workItem <wi-id>   # intent.json 필요 (finalize 산출물)
```

deep-interview는 다음일 때 들어간다: 관측 가능한 단일 기준을 못 쓰겠을 때, product/도메인 의미에 답이 달려 있을 때, 실질적으로 다른 구현이 둘 이상일 때, pre-mortem이 되돌리기 어려운 위험을 드러낼 때.

## 하지 말 것 (금지된 세 번째 경로)

- ❌ work item 없이 콘솔에서 바로 코드 짜기 (이른바 "ad-hoc TDD", "그냥 고치기")
- ❌ 작업을 `work done` 없이 끝났다고 선언하기
- ❌ 증거 없이 "완료/통과"라고 말하기

이건 경로가 아니라 **회피**다. 추적·완료·회고·정리가 빠지므로 ditto가 막으려는 바로 그 상태다.

## 경로를 갈아타거나 묶을 때 (받침 명령)

- `ditto work promote <wi-id>` — 약식으로 시작했는데 무거워졌으면 **제자리에서 정식으로 승격** (id·기준·증거 보존, abandon+recreate 아님)
- `ditto work follow-up <wi-id> ...` — 작업 중 **발굴한 버그/아이디어**를 추적 가능한 형태로 잡아둔다 (산문 목록으로 흘리지 않음)
- `ditto work stem <wi-id>` — 관련 work item을 **한 줄기로 묶어** 본다 (`follows` 계보 위 파생 뷰)
- `ditto work push-ready <wi-id>` — 한 단위가 자기완결이라 **push 가능한지** 명시 요청 시에만 계산. push 자체는 항상 사용자의 비가역 결정 (자동 제안 안 함)

## 더 보기

- 런타임이 매 턴 강제하는 규칙: `src/core/charter.ts`의 PRIME_DIRECTIVE (권위)
- 용어·결정 근거: `.ditto/knowledge/CONTEXT.md`, `.ditto/knowledge/adr/ADR-20260626-work-lifecycle-lightweight-path.md`
