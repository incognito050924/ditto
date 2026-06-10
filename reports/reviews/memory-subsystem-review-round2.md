# `ditto memory` 서브시스템 종합 리뷰 — 라운드 2 (수정 후)

> **무엇에 대한 문서인가**: 라운드 1 리뷰(`memory-subsystem-review.md`)의 발견 8건을 수정한 뒤의 `ditto memory` 서브시스템을 **기능 차원에서** 재검토한 결과. (1) 8건 수정의 독립 검증, (2) 동작 정확성·설계 정합(수정이 새로 만든 문제 포함), (3) ditto 하네스 컨셉 정합·다른 기능과의 맞물림, (4) 보안/버그 위험, (5) 방향성 판단.
> **소비자**: 커밋·배포·§5 push 확대 여부를 판단할 세션/사람. 라운드 1 보고서를 대체하지 않고 누적한다(라운드 1의 F1~F9 번호를 그대로 참조).
> **작성일**: 2026-06-10 · **work item**: wi_260610s7c (재개) · **검토 대상**: HEAD `2a408b1` + 미커밋 작업트리 수정 (`src/core/memory-{bootstrap,project,build,query,scan}.ts`, `src/cli/commands/memory.ts`, `src/hooks/pre-tool-use.ts`, ADR-0013, 설계서)
> **검토 방법**: 검증·코드리뷰·컨셉정합 3개 병렬 조사(각각 격리 repo 실측 동반) + 핵심 주장 전건 메인 세션 코드 재확인. 실측 환경: bun 1.3.14, `dist/ditto` 13:29 빌드(수정 반영 확인됨).
> **전체 테스트**: `bun test` → **1555 pass / 9 skip / 1 fail**. 유일한 fail은 `ditto source repo identity > wi_v01bootstrap and wi_v01implement exist` — 로컬 `.ditto/local` 상태에 결합된 기존 테스트 설계 결함(라운드 1 별도 항목)으로 이번 수정과 무관.

---

## 0. 한 줄 요약

**라운드 1의 8건 수정은 실재한다(7건 완전 재현, F6 부분). 엔진 척추의 불변식·결정성·fail-open도 그대로 견고하다. 그러나 (a) 수정 묶음 자체가 새 누출 경로 1건(본문검색이 secret/pending/rejected를 노출)을 도입했고, (b) 쓰기 거버넌스는 여전히 honor-system이며(승인 게이트 자기신고 우회·무게이트 supersedes 철회·bootstrap 세탁), (c) 무엇보다 이 모든 코드가 런타임에 아직 반영돼 있지 않다(설치본 hook/CLI는 6/8 빌드).**

verdict: **revise (조건부 합격, 라운드 1보다 전진)** — 기능 방향은 옳고 바닥은 단단해졌다. R1(누출)과 R5(배포 드리프트)는 커밋·배포 전에, R2/R3(거버넌스)은 §5 push 확대 전에 닫아야 한다.

| # | 발견 (라운드 2 신규) | 심각도 | 축 |
|---|---|---|---|
| R1 | `query --text`/fallback이 secret·pending·rejected 이벤트 본문을 노출 — F6 게이트·§4-5 승인모델을 같은 변경 묶음의 F2 기능이 우회 | 🔴 High | 보안/정합 |
| R2 | 승인 게이트(F3 fix)가 자기신고 플래그 기반 — `--actor user` 한 마디로 우회, propose 시점 위장도 가능 | 🔴 High | 보안 |
| R3 | `events append --supersedes`가 무게이트 — agent가 pending 이벤트로 approved 사실을 그래프에서 무승인 철회 가능(실측 노드 1→0) | 🔴 High | 거버넌스 |
| R4 | hook 확대가 **교차 프로젝트** `~/.claude/projects/*/memory/` 쓰기를 허용 — 영속·교차세션 prompt-injection/유출 채널, 위험 미문서화 | 🔴 High | 보안 |
| R5 | 배포 드리프트 — 활성 설치본 hook/CLI가 6/8 19:42 빌드. 8건 수정·hook 확대 전부 런타임 미반영. 단위테스트 녹색 ≠ 실제 게이트 | 🔴 High | 운영 |
| R6 | bootstrap 세탁 경로 — handoff archive는 큐레이션 안 된 agent 산출물인데 approved Episode로 승격; repo 내 파일 쓰기+bootstrap으로 propose→approve 전체 우회 가능 | 🟡 Med | 거버넌스 |
| R7 | `build --semantic`의 secret 게이트가 미배선 — 필터는 있으나 런타임 호출자가 sensitivity를 안 넘기고 scan은 전부 'internal' 하드코딩. 테스트는 런타임이 만들 수 없는 입력으로만 통과 | 🟡 Med | 보안/검증 |
| R8 | 호스트 메모리(`~/.claude/projects/*/memory/`)·`.ditto/knowledge`·`.ditto/memory` 3중 중복의 경계 미정의 — 설계 §3-5 경계 논의에 호스트 축이 빠짐 | 🟡 Med | 정합 |
| R9 | query exit 의미 변경(미존재 노드 65→0, 빈 결과도 0) · query→bootstrap 모듈 의존 역류 · pending 적체를 사용자에게 알리는 표면 부재(AX) | 🟢 Low | 동작/AX |
| R10 | 소소: `memory-build.ts`의 리터럴 NUL 바이트(BSD grep이 바이너리 취급) · Episode 노드의 `decision:` id prefix · projection 노드 합류 시 dedup 부재 · F9 잔존(체인>2, `DITTO_MEMORY=off` 범위 미테스트) | 🟢 Low | 품질 |

---

## 1. 라운드 1 수정 8건 — 독립 검증 결과 (fresh evidence)

격리 repo(mktemp + git init + 최소 픽스처)에서 전건 재실행. 작성자 주장을 신뢰하지 않고 exit code까지 실측.

| # | 수정 | 판정 | 증거 (핵심 1줄) |
|---|---|---|---|
| F1 | bootstrap ingest를 projection에 노출 | **pass** | bootstrap+project 후 graph.json node_type = `{Source: 3, Episode: 2, Decision: 1}` (라운드 1엔 Decision 1뿐) |
| F2 | 본문검색 런타임 배선 | **pass** | `query frobnicate --text` → 본문에만 있는 토큰 매치, exit 0; node-not-found fallback도 exit 0 동작 확인 |
| F3 | agent self-approve 차단 | **pass*** | `approve --actor agent` → "requires approval by a user", **exit 65**; `--actor user` → exit 0. *단 게이트 자체가 우회 가능(→R2) |
| F4 | source 노드 dangling 해소 | **pass** | `query source:src_…` → decision 이웃 반환(라운드 1엔 NotFound) |
| F5 | knowledge↔memory drift 문서화 | **pass** | ADR-0013:62·설계서에 drift 한계+재ingest 정책 문구 확인 |
| F6 | secret을 projection·build chunk에서 제외 | **partial** | projection 게이트 실재(`memory-project.ts:79,233`)·테스트 44/44. 그러나 본문검색 경로 무필터(→R1), build 경로 미배선(→R7) |
| F7 | approve eventId 스키마 검증 | **pass** | `approve "../../../etc/hosts"` → `invalid event id`, **exit 65** (not-found가 아니라 검증 거부) |
| hook | `~/.claude/projects/*/memory/` 쓰기 허용 | **pass(소스)** | `tests/hooks/pre-tool-use.test.ts` 163/163, secret-우선·negative 케이스 포함. 단 런타임 미반영(→R5) |

품질 게이트: biome 7파일 무진단 · `tsc --noEmit` 메모리/hook 파일발 신규 에러 0(기존 baseline 무관 에러만 존재).

**판정**: 8건 수정은 주장대로 실재하며, autopilot completion 우회(HANDOFF 의심점 #5)와 무관하게 격리 재현으로 자기완결 검증됐다. 커밋해도 되는 상태다 — 단 아래 R1을 같은 묶음에서 닫을지 먼저 결정할 것.

---

## 2. 동작 정확성 · 설계 정합 — 수정이 새로 만든 문제 (ac-1, ac-2)

### 2-1. R1 (🔴) — 본문검색이 secret·pending·rejected를 가리지 않는다

**무엇**: `queryBodies`는 `MemoryEventStore.list()` 전체를 **status·sensitivity 필터 없이** `searchEventBodies`에 넘긴다(`memory-query.ts:164-169`; `searchEventBodies`엔 sensitivity 매개변수 자체가 없음, `memory-bootstrap.ts:418`). 이 경로는 CLI `--text`(`memory.ts:612-615`)와 node-not-found fallback(`memory.ts:638-642`) 둘 다에서 도달 가능하다.

**실측(2개 조사가 독립 재현)**:
```
propose --sensitivity secret --text "contains supersecrettokenxyz inside"   (pending 상태)
query supersecrettokenxyz --text  → memevt_26061039g 반환, exit 0    ← secret + pending 둘 다 노출
query rejectedguess --text        → rejected 이벤트 반환, exit 0
query wildguess                   → 암묵 fallback으로 pending INFERRED 추측 반환, exit 0
```

**왜 문제인가**: 두 invariant를 동시에 깬다. (a) 같은 변경 묶음의 F6이 "secret은 projection·chunk에서 제외"를 막 세웠는데, 형제 읽기 경로가 그대로 누출한다 — gate↔read 경로 불일치. (b) §4-5 "pending은 그래프에 보이지 않는다"의 'graph'를 본문검색이 별도 tier로 우회하는데, 그 별도 tier의 가시성 규칙이 설계 어디에도 없다(`memory-query.ts:156-162` 주석은 "separate tier"라고만 함). 라운드 1 F2가 "기능이 배선 안 됨"이었다면, 라운드 2는 "배선하면서 가시성 규칙을 같이 안 가져옴"이다.

**권고**: `queryBodies`에 `status==='approved' && sensitivity!=='secret'` 필터(또는 `--include-pending` 명시 플래그로 분리). 수 줄짜리 수정이며, 본문검색의 가시성 규칙을 설계서 §4-5에 한 단락 추가.

### 2-2. R2 (🔴) — 승인 게이트가 자기신고다

**무엇**: F3 fix의 게이트는 `original.actor.kind==='agent' && approverKind==='agent'`(`memory-project.ts:417`)인데, 두 입력 모두 호출자가 CLI 플래그로 자기신고한다 — propose의 `--actor`(기본 agent), approve의 `--actor`(기본 agent, `memory.ts:896-900`). 호출 주체를 식별·인증하는 장치가 없다.

**실측(격리 repo, 우회 2종)**:
- **우회 A**: agent 제안 이벤트에 `approve --by fake-human --actor user` → approved, exit 0.
- **우회 B**: propose 시점에 `--actor user`로 위장 → 이후 agent 승인 통과(게이트 1항이 false).

**판정의 결**: 이건 "fix가 잘못됐다"기보다 **위협모델의 한계 명시가 빠진 것**이다. 로컬 CLI는 호출자를 인증할 수 없으므로 어떤 플래그 기반 게이트도 honor-system이다. 현 게이트는 *정직한 agent의 실수*(기본값 경로의 무심한 self-approve)를 막는 데는 실효가 있고, 그 자체로 가치 있다. 그러나 라운드 1 F3의 위협모델은 "autopilot 중 agent가 bash로 연달아 실행"이었고, 그 agent는 `--actor user`도 자유롭게 친다 — 그 위협은 닫히지 않았다.

**권고(구조적 닫기 옵션, push 확대 전)**: ① PreToolUse hook(이미 Bash를 정적 분석함)이 agent 세션의 `ditto memory approve` 호출 자체를 차단/승인요청으로 승격 — ditto가 이미 가진 메커니즘으로 호출 경로 차원에서 분리 가능. ② 또는 SKILL/agent 정의에서 approve를 사용자 전용 표면으로 명시하고 게이트의 honor-system 성격을 ADR-0013에 기록. 최소한 ②는 즉시.

### 2-3. R3 (🔴) — `events append --supersedes`로 approved 사실을 무승인 철회

**무엇**: F3 게이트는 `approveEvent`에만 있다. `events append`는 임의 `--supersedes`(id 형식만 검증)를 무게이트로 받는다(`memory.ts:161-165,211`). reducer는 supersede된 이벤트를 체인에서 떨어뜨리므로(`memory-reduce.ts:45-47`), **pending 상태의 correction이 approved head를 가리키기만 해도** 다음 `project`에서 그 approved 사실이 그래프에서 사라진다.

**실측**: agent가 approved head를 supersedes하는 pending correction을 append → `project` → approved 노드 1→0.

**왜 문제인가**: §4-5의 대칭 위반이다 — "pending은 그래프에 더해지지 않는다"는 지켜지지만 "pending이 그래프에서 **빼지도** 못한다"는 보장이 없다. 추가(approve)는 게이트하면서 철회(supersede)는 안 하는 비대칭. 현재 blast radius는 warm-start 1지점이라 Med급 실해지만, push 확대 시 "approved 사실의 조용한 소실"은 측정·신뢰 양쪽을 깬다.

**권고**: reducer가 "supersede의 효력은 superseding 이벤트가 **approved일 때만**" 발생하도록 하거나(권장 — reducer 순수성 유지, 의미도 자연스러움), `events append`에서 approved 대상 supersedes를 거부.

### 2-4. R7 (🟡) — `build --semantic` secret 게이트가 끝까지 흐르지 않는다

`chunkSources`는 `sensitivity!=='secret'` 필터를 갖지만(`memory-build.ts:73-75`), 유일한 런타임 호출자는 `ChunkFile`을 **sensitivity 없이** 조립하고(`memory.ts:434-438` — `{source_id, path, content}`만), scan은 모든 source를 `'internal'` 하드코딩한다(`memory-scan.ts:196-199`, "automatic secret classification is follow-up" 주석으로 의도된 축소임은 명시돼 있음). 실측: secret 표시한 source의 원문이 chunk에 그대로 실림. 단위테스트는 런타임이 만들 수 없는 `ChunkFile{sensitivity:'secret'}`을 손으로 만들어 통과 — **라운드 1 F2와 동일한 "tested-but-not-wired" 패턴의 재발**이다. 호스트 LLM(memory-extractor)으로 secret 내용이 나가는 ac-5 노출은 사실상 그대로다. 권고: 호출자에서 source 레코드의 sensitivity를 ChunkFile에 전달(1줄) + 런타임 경로 테스트.

### 2-5. R9·R10 (🟢) — 동작 변경·품질 소소

- **exit 의미 변경**: 미존재 노드 query가 65(usage error)→0(본문검색 fallback, 빈 결과도 0)으로 바뀌었다. 의도된 변경(F2)이나, "unknown id"와 "known id, no match"를 구분하던 외부 신호가 사라졌다. 빈 fallback 결과에 별도 신호(예: human 출력에 fallback 사실 명시 — 현재도 "Body matches" 헤더로 구분은 됨 / json에 `fallback: true`)를 권장.
- **모듈 의존 역류**: F2 배선으로 읽기 경로(`memory-query`)가 `memory-bootstrap`을 import하게 됐다. 순환은 아니나 `searchEventBodies`의 거처가 bootstrap인 게 어색해진 것 — 후속 구조 정리 후보(Tidy First, 동작 변경과 분리).
- **NUL 바이트**: `memory-build.ts:222-223`의 정렬 키에 리터럴 `\x00` 문자가 박혀 BSD grep이 파일을 바이너리로 취급한다(이번 조사 중 grep 다수가 실제로 막힘). `' '` 이스케이프로 교체(1줄, 동작 동일).
- **Episode 노드 id가 `decision:` prefix**(`memory-project.ts:45-46`) — downstream이 prefix를 파싱하지 않아 무해하나 계약 냄새. projection 노드 합류(`[...ir.nodes, ...eventGraph.nodes]`, `:238`)에 id dedup이 없는 점도 동일 결 — 현재 prefix 체계상 충돌 불가능하지만 semantic fragment가 `source:`형 id를 내면 중복 노드 가능(추론, 미재현).
- **F9 잔존**: supersedes 체인>2 미테스트, `DITTO_MEMORY=off`가 "warm-start만 끈다"는 범위 명세 미테스트 — 라운드 1 그대로 열려 있음.

---

## 3. 하네스 컨셉 정합 · 다른 기능과의 맞물림 (ac-3)

### 3-1. 기층과의 정합 — 여전히 충돌 없음, 통합은 모범적

라운드 1 판정 유지, 수정 후에도 재확인: ADR-0002(Zod SoT)·0005(무서버 per-entity)·0011(session-rooting)·0012(3계층) 전부 정합. 통합 지도(현재 트리 전수):

| 접점 | 방향 | 결합도 |
|---|---|---|
| autopilot warm-start | autopilot→memory read-only | optional·fail-open(전 degrade 경로가 undefined 수렴, 패킷 불변) — `autopilot-loop.ts:213,279` |
| knowledge | memory가 read(bootstrap 복제), 역방향 없음 | 단방향·수동 1회성 |
| handoff archive | memory가 read | 단방향 |
| CLI/skill/agent | 독립 명령군 + owner agent의 conditional pull 습관 1줄 | advisory |
| hooks | **memory 코드와 무관**(hook은 memory를 import하지 않음; hook 확대는 호스트 메모리용) | 없음 |

신규 사이클·하드 의존 없음. 단일 플래그 되돌림(`DITTO_MEMORY=off`) 실재. **autopilot은 memory propose/approve를 어디서도 호출하지 않으므로**(grep 전수) R2의 "agent는 user 승인 필요" 정책이 현재 자율주행을 막는 것은 없다 — HANDOFF 의심점 #1에 대한 답: 현 시점 정합. 다만 §5-2~5-5 확대 시 INFERRED 제안이 사람 승인 페이스에 적체되는데, **pending 적체를 사용자에게 알리는 표면이 없다**(status의 pending 카운트, 세션 종료 안내 등) — "수동 작업은 능동 안내"라는 AX 원칙과의 갭(R9).

### 3-2. R6 (🟡) — bootstrap auto-approve의 절반은 정당, 절반은 세탁 경로

HANDOFF 의심점 #2에 대한 판정. bootstrap이 ingest물을 `approved_by='bootstrap'`로 승격하는 것은:

- **ADR·glossary는 방어 가능**: 이들은 knowledge-curator/knowledge gate 경로의 산출물이고, 그 경로 자체가 "합의된 결정만"을 계약으로 가진다. knowledge의 신뢰 모델도 (사람 승인 버튼이 아니라) convention+gate이므로, bootstrap 승격은 **기존 신뢰 모델과 등가**다. ADR이 라운드 1 이전부터 approved decision으로 들어가던 것과도 일관.
- **handoff archive는 다르다**: `.ditto/local/handoff/archive/*.md`는 세션 종료 시 agent가 자동 생성하는 산출물로 사람 큐레이션 단계가 없다. "bootstrap = 이미 큐레이션된 자산" 전제가 여기선 성립하지 않는다.
- **세탁 루프홀**: hook은 repo 내부 쓰기를 막지 않으므로, agent가 ① `.ditto/knowledge/`나 handoff archive에 파일을 쓰고 ② `ditto memory bootstrap`을 실행하면 propose→approve를 통째로 우회해 approved 사실을 만든다. F3로 닫은 문 옆의 더 넓은 문이다. 완화 정황: `approved_by='bootstrap'` 라벨이 감사 가능, bootstrap은 수동 CLI, warm-start 주입물은 노드 id뿐이라 오염 텍스트가 패킷에 직접 실리지 않음 — 그래서 High가 아닌 Med.
- **권고**: handoff 유래 이벤트는 approved 대신 별도 신뢰 라벨(예: `approved_by='bootstrap:handoff'` 유지하되 설계서에 신뢰 등급 명시)로 구분하고, ADR-0013에 bootstrap 신뢰 모델("upstream 큐레이션을 신뢰한다, 그 한계는 X") 한 단락 추가.

### 3-3. R8 (🟡) — 기억이 사는 곳이 셋인데 경계 문서는 둘만 안다

설계 §3-5는 `.ditto/knowledge`(사람 큐레이션·durable) vs `.ditto/memory`(기계 추출·advisory)의 경계를 잘 그어놨다. 그러나 **호스트 메모리**(`~/.claude/projects/*/memory/MEMORY.md` — Claude Code가 매 세션 자동 주입)가 이 경계 논의에 전혀 없고, 실제로 그 파일에는 이미 ditto 관련 사실들이 산다. hook 확대(R4)로 ditto 작업 중 agent가 호스트 메모리에 쓰는 것이 공식화되면서 같은 사실이 세 곳에 살 수 있게 됐는데, 어느 쪽이 SoT이고 무엇이 어디로 가는지 규칙이 없다. F5(knowledge↔memory drift)는 ADR에 기록됐지만 호스트 축은 미인지. 권고: §3-5 표에 호스트 메모리 행 추가(용도: 개인·세션 연속성·repo 무관 사실 / ditto memory와 겹치는 사실은 ditto 쪽이 SoT).

### 3-4. ADR-0013 결정 4건의 사후 평가

- **D1(인프로세스)·D2(2-tier)·D3(supersedes 승인)**: 코드와 일치 유지. D3의 단일-체인-head invariant는 double-approve 차단으로 잘 강제되나, R3가 보여주듯 **체인에 빼기 방향 게이트가 빠졌다** — D3 보완 필요.
- **D4(measure-before-expand)**: 구조는 건전하나 측정기가 아직 절반이다(§5 참조).

---

## 4. 보안 위험 (ac-4)

### 4-1. R4 (🔴) — hook 확대: 필요한 구멍이지만 너무 넓고, 문서가 없다

`isClaudeMemoryPath`(`pre-tool-use.ts:203-213`)의 실제 허용 범위(9케이스 실측):

- 허용: `~/.claude/projects/<아무 프로젝트>/.../memory/...` — **현재 프로젝트로 한정되지 않음**, `memory` segment가 임의 깊이에 있어도 허용(주석의 "`<project>/` 바로 아래"보다 넓음 — `segs.slice(1).includes('memory')`), `MEMORY.md` 인덱스 포함.
- 차단 유지: `..` 탈출(lexical resolve로 정규화 확인), `memorystuff` 같은 prefix, 그 외 `~/.claude/*` 전부. secret 검사(파일명 패턴)는 양 경로 모두 allow보다 **먼저** 평가됨(`:549-557,589-596`) — 순서 올바름.

**위험**: prompt-injected agent가 임의 프로젝트의 `MEMORY.md`에 지시문을 써넣으면 **그 프로젝트의 모든 미래 세션에 시스템 컨텍스트로 자동 로드**된다 — 세션 경계를 넘는 영속 주입 채널이자(cp dest 허용이므로) repo 내용 유출 통로. 교차-프로젝트 허용이 blast radius를 사용자의 전 프로젝트로 넓힌다. 이 허용은 hook 주석에 "agent 연속성"으로만 적혀 있고, **호스트 메모리 오염 위험은 ADR 어디에도 없다**. scope-out의 존재 이유가 바로 주입 방어인데, 자기 편의로 뚫은 구멍의 위험 수지를 기록하지 않은 것.

**권고**: ① 허용을 **현재 프로젝트의** memory 디렉토리로 좁히기(`<home>/.claude/projects/<현재 repo의 슬러그>/memory/` — hook은 repoRoot를 이미 안다), 깊이도 주석 의도대로 `<project>/memory/` 직하로. ② 남는 위험(현재 프로젝트 메모리 오염은 여전히 가능 — 이는 Claude Code 자체의 메모리 신뢰 모델과 같은 등급)을 ADR로 수용 기록. 이 둘이면 High→Low로 내려간다.

### 4-2. R5 (🔴) — 배포 드리프트: 지금 돌고 있는 정책은 이틀 전 코드다

런타임 hook은 `hooks/hooks.json:51`이 가리키는 `${CLAUDE_PLUGIN_ROOT}/bin/ditto`. 실측:

- repo `bin/ditto`: 6/10 **10:37** 빌드 — hook 소스 수정(13:06) 이전. `strings bin/ditto | grep -c isClaudeMemoryPath` → **0** (dist/ditto는 3).
- **활성 설치본** `~/.claude/plugins/cache/ditto-local/ditto/0.0.0/bin/ditto`: 6/8 **19:42** 빌드 — 이 작업트리보다 이틀 전. 이 세션 중 실제로 구버전 hook이 `/tmp` 쓰기를 차단하는 것을 관찰(살아있는 증거).

즉 **8건 수정도, hook 확대도, 지금 어떤 세션에서도 실제로 동작하지 않는다.** 단위테스트(소스 컴파일) 녹색과 실제 게이트가 다른 코드라는 것 — 검증을 테스트로만 하면 영영 못 보는 종류의 드리프트다. 역설적으로 R4의 주입 채널도 아직 살아있지 않다(구버전 hook이 호스트 메모리 쓰기를 여전히 차단 중).

**권고**: 커밋 후 MEMORY.md `ditto-global-plugin-refresh` 절차(두 진입점 빌드 + uninstall→install)로 반영하고, **빌드 산출물과 소스의 drift를 잡는 가드**(예: CI/pre-commit에서 `bin/ditto` 재빌드 후 diff 검사, 또는 버전 스탬프 비교를 doctor에 추가)를 후속으로. 이건 memory만이 아니라 ditto의 hook 기반 보안 전체에 걸리는 구조적 위험이다.

### 4-3. secret 커버리지 매트릭스 (수정 후 현황)

| 경로 | secret 필터 | 비고 |
|---|---|---|
| projection nodes/edges | ✅ (`memory-project.ts:79,233`) | F6 실재 |
| wiki/serving/warm-start/audit | ✅ (projection 상속) | |
| `build --semantic` chunk | ❌ 미배선 | R7 — 필터 존재하나 도달 불가 |
| `query --text`/fallback 본문검색 | ❌ 무필터 | R1 — pending/rejected도 노출 |
| `events list` | ❌ 전 이벤트 `text` 평문 출력(`memory.ts:284`) | 로컬 CLI 표면, 저위험이나 비일관 |
| scan 분류 | 전부 'internal' 하드코딩 | 의도된 follow-up(주석 명시) |

---

## 5. 방향성 — ditto에 좋은 추가인가 (ac-5)

**라운드 1 판정 유지·강화: 그렇다. 컨셉은 ditto의 결 그대로고, 수정으로 옵션 A의 "확실한 바닥"이 실제로 측정 가능해졌다. 남은 것은 거버넌스의 honor-system성과 측정기의 나머지 절반이다.**

- **컨셉 정합**: 출처-동반·freshness-stamped·propose→approve 그래프는 "증거 기반 완료" prime directive와 동형이고, 무서버·per-entity·단일 플래그 되돌림이 기층을 안 깬다. measure-before-expand(D4)는 charter §4-3의 자기절제가 ADR로 굳은 모범 사례다.
- **F1/F2 수정이 계측 편향을 부분 해소**: 라운드 1의 핵심 우려("측정기가 ADR 제목 매칭률만 잰다")는 절반 풀렸다 — projection이 Episode·Source를 노출하고 본문검색이 런타임 도달 가능해졌다.
- **그러나 측정기는 아직 절반이다**: ① warm-start push는 여전히 `queryNeighbors`(노드 id/name 토큰)만 쓴다 — 본문검색은 **pull(CLI) 경로에만** 배선됐고 자동 주입 경로엔 없다. "본문 recall이 title-token보다 넓다"(ac-14)는 push 측면에서 여전히 미측정. ② pull 계측(`recordPullQuery`)은 발화 수·neighbor_count를 기록하지만 "그 답이 agent 행동을 바꿨나"(actionability)는 못 본다. ③ hit이 ADR Decision에 편중되는지 의미층(INFERRED) 기여가 있는지 분해할 수 없다. **게이트를 열고 닫을 데이터가 이 셋을 분해해 보여줘야 D4의 철회조건이 작동한다.**
- **falsification 기준(제안)**: 운영 ingest 후 (a) warm-start actionable율 바닥, (b) pull-usage 거의 무발화, (c) hit의 의미층 기여 0 — 중 하나면 "그래프 기계장치는 색인 대비 증분 가치 없음"으로 D4 철회조건 발동. 현 계측은 (a)만 본다.

**종합**: 기능을 줄이거나 되돌릴 이유는 없다. 거버넌스(R1~R3·R6)를 honor-system에서 메커니즘으로 올리고 배포 드리프트(R5)를 닫으면, 이 서브시스템은 ditto의 "증거로 말하는 자율성"을 기억 축으로 확장하는 올바른 기반이다.

---

## 6. 권고 (우선순위)

| 순위 | 항목 | 근거 | 규모 |
|---|---|---|---|
| **P0** | R1 `queryBodies`에 approved+non-secret 필터 (또는 `--include-pending` 명시 분리) | 커밋 전 — 같은 묶음의 F6을 형제 경로가 무효화 | 소 |
| **P0** | R5 커밋 후 두 진입점 재빌드+재설치(글로벌 반영) + 빌드 drift 가드 후속 등록 | 모든 수정이 런타임 미반영, hook 보안 전반의 구조 위험 | 소(반영)+중(가드) |
| **P1** | R4 hook 허용을 현재 프로젝트·`<project>/memory/` 직하로 축소 + 잔여 위험 ADR 기록 | 교차 프로젝트 영속 주입/유출 채널 | 소 |
| **P1** | R3 supersede 효력을 approved superseding 이벤트로 한정(reducer) | pending이 approved 사실을 철회하는 §4-5 비대칭 | 소 |
| **P1** | R2 위협모델 문서화(honor-system 명시) + hook의 `memory approve` 호출 경로 게이트 검토 | push 확대 전 거버넌스 | 소(문서)+중(게이트) |
| **P2** | R7 chunk에 source sensitivity 전달 + 런타임 경로 테스트 | tested-but-not-wired 재발 차단 | 소 |
| **P2** | R6 bootstrap 신뢰 모델 ADR 기록(handoff archive 신뢰 등급 구분) | 세탁 경로 인지 | 소 |
| **P2** | R8 §3-5에 호스트 메모리 경계 행 추가 | 3중 중복 drift 예방 | 소 |
| **P3** | R9/R10: pending 적체 노출(AX) · exit 의미 신호 · NUL 바이트 · `searchEventBodies` 거처 정리(Tidy) · F9 잔존 테스트 · 측정기 분해(actionability·의미층 기여) | 품질·측정 완성 | 소~중 |

> P0 2건은 커밋·배포와 같은 단위로, P1 3건은 §5 push 확대 work item을 열기 전 차단 게이트로 다루기를 권한다.

---

## 부록 A — 검토 범위·미검증

- **방법**: 병렬 조사 3건(8건 수정 검증 / post-fix 코드리뷰 / 컨셉·hook·통합 분석) — 각각 격리 repo 실측 동반. R1·R2(코드)·R3 재현, queryBodies·approveEvent·CLI 배선·scan 하드코딩·hook 매처는 메인 세션이 코드 레벨에서 전건 재확인.
- **테스트**: `bun test` 전체 1555 pass/1 fail(무관한 기존 로컬상태 결합 테스트), 메모리·hook 스위트 별도 재실행 전건 통과(core 103, cli+hook 180).
- **검증 못 한 것**: `build --semantic`의 host-LLM 추출 end-to-end(provider 필요 — chunk 방출까지만 실측), 멀티 repo workspace rooting(ADR-0011 v0 비범위), semantic fragment의 노드 id 충돌(추론만), hook 확대의 **런타임** 동작(R5로 인해 설치본에 코드가 없음 — 소스 테스트 163건으로만 검증).
- **이 보고서가 라운드 1과 다른 점**: F1~F9는 라운드 1 번호, R1~R10은 이번 라운드 신규(또는 재분류) 발견. 라운드 1의 §2(기층 정합)·§4(방향성) 판정은 재검토 후 유지.
