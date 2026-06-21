# GBrain (garrytan/gbrain) — 코드레벨 연구 보고서

- 작성일: 2026-06-17
- 대상: `https://github.com/garrytan/gbrain` (master, v0.42.47.0, 2026-06-17 clone)
- 방법: 저장소 직접 clone 후 소스 정독(1차 근거) + 딥리서치 웹 검증(99 에이전트, 25개 주장 적대적 검증 → 확인 21 / 기각 4)
- 근거 표기: `파일:라인` 또는 실행 출력은 **코드 확인**, 웹 출처만 있는 항목은 **웹**으로 구분. 자가보고 수치는 **자가보고**로 표시.

---

## 0. 한 줄 요약

GBrain은 **Postgres를 저장·검색 엔진으로 쓰는 AI 에이전트용 영속 장기기억(brain) 레이어**다. 지식은 git 저장소 안 마크다운으로 살고, 그것을 Postgres로 sync해 **하이브리드 RAG(벡터+키워드+RRF) + 매 쓰기마다 LLM 없이 자가배선되는 타입드 지식 그래프 + 합성(synthesis) 응답 + 야간 자율 유지보수(dream cycle)**를 제공한다. 작성자는 Y Combinator CEO Garry Tan으로, 본인 에이전트(OpenClaw/Hermes)의 프로덕션 brain이라고 README에서 밝힌다.

규모(코드 확인): TypeScript **약 243k LOC**(`src` 하), 소스 **781**개, 테스트 **857**개, MIT, Bun ≥1.3.10 전용.

---

## 1. 정체성과 위치

- **이름/버전**: `package.json` `name: "gbrain"`, `version: "0.42.47.0"`, `"Postgres-native personal knowledge brain with hybrid RAG search"`. (코드 확인)
- **저자/맥락**: README 1인칭 — "I'm Garry Tan, President and CEO of Y Combinator. ... the production brain behind my OpenClaw and Hermes deployments." 자가보고 운영 규모: 146,646 pages, 24,585 people, 5,339 companies, 66 cron jobs. (웹/README, **자가보고**)
- **North Star**(CLAUDE.md): "the **next Postgres for memory**" — 회사 brain·개인 AI용 검색+에이전트 기억 시스템. "gbrain is best"는 단일 기능이 아니라 BrainBench 전체로 증명하는 **전체 시스템 주장**이라고 못박음. (코드 확인 `CLAUDE.md`)
- **생태계 분리**: `gbrain`(코어 엔진) ↔ `gstack`(에이전트에게 코딩을 가르치는 mod, 트러스트 티어·원격 연결 담당) ↔ `gbrain-evals`(BrainBench 벤치마크, gbrain을 git 의존성 라이브러리로 import). (웹 + 코드 확인 — `package.json`의 `exports` 21개 진입점이 라이브러리 import를 뒷받침)

---

## 2. 설계 사상 (Design Philosophy)

코드와 문서에서 일관되게 드러나는 다섯 가지 축.

1. **"검색이 아니라 답을 준다."** README의 중심 주장 — 경쟁 도구가 "쿼리에 맞는 10개 청크"를 주는 반면 GBrain은 **출처가 붙은 합성 산문 + 모르는 것(gap)을 명시**한다. "brain이 모르는 것을 알려주는 heads-up"이 핵심 차별점. (웹/README)

2. **"Code for data, LLMs for judgment."** 수집기(collector)는 결정적 코드로 데이터를 신뢰성 있게 잡고, 판단(엔티티 인식·분석)만 LLM에 맡긴다. (웹, `docs/integrations/README.md` 검증)

3. **Contract-first 단일 진실원**. `src/core/operations.ts` 한 곳이 모든 op을 정의하고 **CLI와 MCP 서버를 둘 다 거기서 생성**한다. (코드 확인 — 아래 §3)

4. **Engine parity 불변식**. PGLite/Postgres 두 엔진은 **lockstep**으로 움직인다(새 SQL·메서드는 둘 다에 동시 착지, e2e 테스트로 고정). (코드 확인 `CLAUDE.md` cross-cutting invariants)

5. **Fail-closed 트러스트 경계**. `OperationContext.remote`가 타입에 필수이고, `false`가 아닌 모든 것은 untrusted로 취급. 로컬 CLI=신뢰(OS 권한), MCP 에이전트=비신뢰. (코드 확인)

추가로 **자율성 우선**: "채팅으로 에이전트를 굴리는 것보다 24/7 데몬이 수집·강화·통합하게 두는 게 쉽다"는 명제가 dream cycle 설계의 사상적 근거. (웹/README)

---

## 3. 아키텍처 — Contract-first + Dual Engine

### 3.1 Operation 계약
- `src/core/operations.ts`(5,104 LOC)에 공유 op 정의. **`scope:` 표기 97개**(코드 확인: `grep -c`), CLAUDE.md는 "~90 shared operations"로 기술, 웹/README는 "~47"로 표기 — **실제 코드 기준 약 90+가 정확**하고 README의 47은 과소 표기.
- 각 op은 `scope: 'read'|'write'|'admin'` + 선택적 `localOnly`를 갖는다. HTTP MCP dispatch가 핸들러 실행 **전에** scope/localOnly를 강제. (코드 확인)
- `src/mcp/tool-defs.ts`: `ParamDef → JSON Schema` 변환이 단일 함수(`paramDefToSchema`)로 통일 — stdio MCP·HTTP MCP·subagent 레지스트리 세 소비처가 한 매퍼를 공유(과거 드리프트 버그를 아키텍처 레벨에서 봉합). (코드 확인)

### 3.2 Dual Engine (PGLite ↔ Postgres)
- `src/core/engine-factory.ts`: 설정값으로 **동적 import** — PGLite WASM이 Postgres 사용자에게는 로드조차 안 됨. (코드 확인)
- `PGLiteEngine`(`pglite-engine.ts`, 5,659 LOC) = **Postgres 17.x를 WASM로 임베드**, 서버 0, `gbrain init --pglite`로 2초 만에 brain 생성. 개인 brain(~50K pages)용 기본. (코드 + 웹)
- `PostgresEngine`(`postgres-engine.ts`, 5,803 LOC) = `postgres` (postgres.js) 드라이버로 Supabase/자체호스트 연결. 공유·대규모·다중머신용. (코드 확인)
- 두 엔진은 동일 SQL 형상을 lockstep 유지(§2-4). PGLite→Postgres 마이그레이션 경로 존재. (코드/웹)

### 3.3 두 직교 축 (Brain × Source)
- **Brain** = 어느 DB(개인 `host` + `gbrain mounts add`로 마운트한 팀 brain).
- **Source** = DB 안 어느 repo(wiki, gstack, openclaw 등). 슬러그 유일성은 `(source_id, slug)` 복합키.
- 모든 read op이 `sourceScopeOpts(ctx)`로 라우팅 — **source isolation은 데이터 유출 방지의 핵심 불변식**(놓친 thread = cross-source 유출). 회사 brain 모드에서 로그인별 scope, fuzz 테스트로 "zero leaks" 자가보고. (코드 확인 + 웹)

---

## 4. 저장·스키마

- **벡터**: `VECTOR(1536)` 컬럼 + **HNSW 인덱스**(`USING hnsw (embedding vector_cosine_ops)`), pgvector 0.7+ (PGLite·Postgres 양쪽 지원). (코드 확인 `migrate.ts`)
- **전문검색(FTS)**: `TSVECTOR` 컬럼 + 트리거(`update_chunk_search_vector`)로 가중치 부여 — `doc_comment`·`symbol_name_qualified`는 weight **A**, `chunk_text`는 weight **B**(`setweight`). (코드 확인)
- **마이그레이션**: DDL은 `migrate.ts`의 `MIGRATIONS` 배열 단일 소스. `CREATE INDEX CONCURRENTLY`는 `transaction:false`(Postgres), PGLite는 평범한 `CREATE INDEX`로 분기. (코드 확인)
- **JSONB 함정 가드**: `JSON.stringify`를 `::jsonb` 캐스트에 넣지 말 것(postgres.js 이중 인코딩) — 스크립트로 검사. (코드 확인 `CLAUDE.md`)
- **소스 형상**: 지식은 git brain repo의 마크다운(frontmatter + wikilink)으로 살고, sync가 Postgres로 투영. git 삭제 = DB soft-delete. (웹/README, 코드의 `import-file.ts`/`sync.ts`가 뒷받침)

---

## 5. 하이브리드 검색 파이프라인 (핵심 IP)

`src/core/search/hybrid.ts`(**87KB**, 단일 최대 검색 모듈) 헤더가 파이프라인을 명시: "**keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup**". 프로덕션 Ruby 구현(`content_chunk.rb`)에서 포팅. (코드 확인)

코드로 확인한 구성요소:
- **RRF(Reciprocal Rank Fusion)**: `RRF_K = 60`, score = `Σ 1/(60 + rank)`. (코드 확인 `hybrid.ts`)
- **Compiled-truth boost**: `compiled_truth` 청크에 RRF 정규화 후 **2.0배** 부스트. (코드 확인 `COMPILED_TRUTH_BOOST = 2.0`)
- **Cosine re-score**: `0.7*rrf + 0.3*cosine` 블렌딩으로 쿼리별 재정렬. (코드 확인 헤더)
- **부속 단계 모듈**(같은 디렉터리): `autocut.ts`(컷오프), `rerank.ts`(리랭커), `query-intent.ts`/`intent-weights.ts`(쿼리 의도 분류 → intent별 가중치·RRF k 조정), `relational-recall.ts`/`graph-signals.ts`(그래프 arm — 관계 질의), `recency-decay.ts`(시간 감쇠), `query-cache.ts`(시맨틱 쿼리 캐시), `two-pass.ts`(앵커 확장 + 청크 hydrate), `token-budget.ts`(반환 토큰 예산), `dedup.ts`, `telemetry.ts`(검색 계측), `embedding-column.ts`(동적 임베딩 컬럼 라우팅). (코드 확인 — `ls src/core/search/`)
- **비동기 캐시 쓰기 bounded drain**: 검색 핫패스가 in-flight 캐시 쓰기에 매달리지 않도록 타임아웃 레이스. (코드 확인 `awaitPendingSearchCacheWrites`)

> 웹 검증 노트: "HNSW + BM25 + RRF" 문서 주장은 확인(2-1). 단, BullMQ·특정 임베딩 제공자까지 묶은 **확대 변형은 만장일치 기각(0-3)** — 문서화된 검색 파이프라인만 살아남음. 내 코드 조사가 이를 뒷받침.

---

## 6. 자가배선 지식 그래프 (Zero-LLM, 차별 기능)

`src/core/link-extraction.ts`(1,229 LOC). **모든 함수가 순수(DB 접근 없음)** — 페이지 내용을 후보 엣지로 바꾸고 호출자가 engine으로 영속. (코드 확인 파일 헤더)

- **LLM 호출 0**: 엣지 타입 추론은 정규식/휴리스틱. (코드 확인 — `inferLinkType`이 `FOUNDED_RE`/`INVESTED_RE`/`ADVISES_RE`/`WORKS_AT_RE`.test로 분기, LLM/fetch 호출부 없음)
- **엣지 타입**: `mentions`, `works_at`, `invested_in`, `founded`, `advises`, `attended`, `wikilink_basename`. (코드 확인)
- **추론 우선순위**: `founded > invested_in > advises > works_at > role prior > mentions`. meeting 페이지면 즉시 `attended`. (코드 확인 `link-extraction.ts:688,694-721`)
- **세 추출 경로**: ① 마크다운 링크 `[Name](../people/slug.md)`(DIR_PATTERN 화이트리스트), ② 위키링크 `[[slug]]`/`[[bare-name]]`(global_basename resolver로 해소), ③ frontmatter 필드(`key_people`→incoming `works_at`, `investors`→`invested_in`, `attendees`→`attended` 등 방향성 보존). (코드 확인)
- **버전 스탬프 기반 재추출**: `LINK_EXTRACTOR_VERSION_TS`를 올리면 이전 스탬프 페이지가 stale 처리되어 `gbrain extract --stale`에서 재추출(chunking의 `CHUNKER_VERSION`과 동일 역할). (코드 확인)
- **자가보고 효과**: 240페이지 Opus 생성 코퍼스에서 **P@5 49.1%, R@5 97.9%**, 그래프 비활성 변형 대비 **+31.4 P@5**. (**자가보고** — gbrain-evals/BrainBench, 제3자 미감사. 메커니즘(zero-LLM 정규식)은 코드 확인, 수치는 자가보고.)

---

## 7. 수집·야간 자율 유지보수·워커 풀

### 7.1 Dream Cycle (`src/core/cycle.ts`, 2,424 LOC)
야간 유지보수의 단일 진실원. `gbrain dream`(원샷 cron)·`gbrain autopilot`(데몬)·Minions `autopilot-cycle` 핸들러 셋이 전부 `runCycle()`로 수렴. (코드 확인 파일 헤더)

**의미 기반 페이즈 순서**(파일 우선 → 인덱스): `lint --fix → backlinks --fix → sync → synthesize(transcript→page) → extract(링크) → patterns(세션 횡단 테마) → recompute_emotional_weight → embed --stale → orphans`. 추가로 calibration wave(`propose_takes → grade_takes → calibration_profile`), `extract_atoms`, `extract_facts`, `schema-suggest`. (코드 확인 `CyclePhase`)

**동시성 잠금**: Postgres는 `gbrain_cycle_locks` 행 + TTL 30분(PgBouncer 트랜잭션 풀링 통과 위해 advisory lock 대신 행 잠금). PGLite는 `~/.gbrain/cycle.lock` 파일 잠금(PID+mtime, 동일 TTL). 읽기·FS-only 페이즈는 잠금 스킵. (코드 확인)

### 7.2 Minions (워커 풀/잡 큐, `src/core/minions/`)
- **BullMQ가 아니다** — 자체 구현 durable queue(`queue.ts`) + supervisor. (코드 확인 — 웹의 "BullMQ" 주장은 0-3 만장일치 기각, 내 코드 조사가 실제 메커니즘으로 정정)
- `MinionSupervisor`(`supervisor.ts`)가 `gbrain jobs work`를 **별도 자식 프로세스로 spawn**, 크래시 시 지수 백오프 재시작, PID 파일 잠금(`O_CREAT|O_EXCL` 원자적), graceful shutdown. 자식 격리로 misbehaving 핸들러가 supervisor를 죽이지 못함. (코드 확인)
- 부대 메커니즘: `rate-leases.ts`(전역 레이트 임대), `budget-tracker.ts`/`budget-meter.ts`(예산), `quiet-hours.ts`/`niceness.ts`(조용시간/우선순위), `backpressure-audit.ts`, `self-fix.ts`, `error-classify.ts`. **Postgres 전용**(PGLite 단일 writer 잠금이 별도 워커 프로세스를 막아 CLI에서 거부). (코드 확인)

---

## 8. AI 게이트웨이·임베딩·Contextual Retrieval

### 8.1 게이트웨이 (`src/core/ai/gateway.ts`)
- **모든 AI 호출의 단일 seam**. `embed`/`expand`/`generateText`/`generateObject`를 한 곳으로 통과. (코드 확인 파일 헤더)
- **Vercel AI SDK**(`ai` ^6) + 제공자 어댑터: `@ai-sdk/anthropic`·`@ai-sdk/google`·`@ai-sdk/openai`·`@ai-sdk/openai-compatible`, 추가로 `@anthropic-ai/sdk`·`openai` 직접 번들. **멀티 제공자**. (코드 확인 `package.json`)
- **설계 규칙**: 호출 시점에 `process.env`를 읽지 않음(`configureGateway()` 1회 주입), AI SDK 에러를 `AIConfigError`/`AITransientError`로 정규화, 제공자별 모델 캐시 키=(provider, modelId, baseUrl). (코드 확인)
- **AI-HTTP 타임아웃**: plain `fetch`는 기본 타임아웃이 없어 반열림 소켓이 `await`를 영영 안 풀고 PGLite 단일 writer 잠금을 점유 → 모든 generateText/generateObject/embed에 `abortSignal` 기본 주입(내부 재시도 포함 전체 호출 bound). (코드 확인)
- **recipe/touchpoint 라우팅 + 티어 기본값**(`model-resolver.ts`, `TIER_DEFAULTS`), guardrails 훅, "모든 AI는 게이트웨이 경유, 직접 anthropic 금지" 검사 스크립트. (코드 확인)

### 8.2 임베딩
- `src/core/embedding.ts`는 게이트웨이로의 **얇은 위임**. 비대칭 제공자(query/document 분리)를 위해 `embedQuery`가 `input_type: 'query'`를 전달, 대칭 제공자는 필드 드롭. 멀티모달 임베딩(텍스트+이미지)도 노출. (코드 확인)
- **기본 임베딩 제공자는 코드에 하드코딩되지 않음** — 게이트웨이 멀티 제공자 + 설정 가능. `evals/embedding-provider-eval.json` 존재. (코드 확인 — 웹의 "ZeroEntropy 기본" 주장은 1-2로 기각/미확정, 실제는 설정 가능한 멀티 제공자)

### 8.3 Contextual Retrieval (`contextual-retrieval-service.ts`, 593 LOC)
Anthropic의 contextual retrieval 기법 구현 — **각 청크를 LLM 생성 synopsis(맥락)와 함께 재임베드**. 2-페이즈 빌드: PHASE 1이 모든 synopsis+임베딩을 메모리에 수집(refusal/empty 시 더 낮은 'title' 티어로 **재시작**, 디스크 중간상태 0), PHASE 2가 단일 트랜잭션으로 청크 교체 + 모드/세대 스탬프. synopsis는 Haiku. 레이트 임대는 호출자 책임. (코드 확인)

---

## 9. Calibration / "Hindsight" — 예측 보정 (독특)

`src/core/calibration/` + cycle의 `propose_takes`/`grade_takes`/`calibration_profile`. (코드 확인)

- **takes** = 산문에서 추출한 채점 가능한 주장/예측. LLM이 스캔해 리뷰 큐에 제안 → 사용자 accept/reject → 미해결 takes를 증거 검색 후 judge 모델이 verdict(자동 해소 OFF 기본). 해소된 부분집합을 2~4개 서사형 pattern statement + bias 태그로 집계. **Brier score**로 보정 추적. (코드 확인 `cycle.ts` CyclePhase 주석, `DESIGN.md`)
- **Voice gate**: 5개 사용자 표면(pattern_statement, nudge, forecast_blurb, dashboard_caption, morning_pulse)이 `gateVoice()`(`voice-gate.ts`)를 통과 — Haiku judge가 학술적 어투를 reject, 최대 2회 재생성, 실패 시 손작성 템플릿 fallback. (코드 확인 `DESIGN.md`)
- 차트는 **서버 렌더 SVG**(`svg-renderer.ts`, 순수 함수 data→SVG, 클라이언트 차트 라이브러리 0, `escapeXml` XSS 방어). (코드 확인 `DESIGN.md`)

---

## 10. 코드 인텔리전스 (부가 — 코드도 색인)

`src/core/chunkers/`에 **tree-sitter** 기반 코드 청킹: `code.ts`, `symbol-resolver.ts`, `qualified-names.ts`, `edge-extractor.ts`. 의존성 `web-tree-sitter` 0.22.6 + `tree-sitter-wasms` 0.1.13. CLI에 `code-callers`/`code-callees`/`code-def`/`code-refs` 명령 — **심볼 그래프 질의**. FTS의 weight-A 컬럼이 `symbol_name_qualified`·`doc_comment`인 이유. (코드 확인)

---

## 11. MCP·배포·생태계

- **MCP 서버**(`src/mcp/`): `server.ts`(stdio, `StdioServerTransport`) + HTTP 전송(`http-transport.ts` / `serve-http.ts`, `StreamableHTTPServerTransport`) **OAuth 2.1**(PKCE, `.well-known` 디스커버리, `/authorize /token /register /revoke`). `@modelcontextprotocol/sdk` 1.29.0. op이 typed tool로 노출 — `claude mcp add gbrain -- gbrain serve`. (코드/웹 확인)
- **원격/연합 온보딩**: `run_onboard` op(admin scope)으로 thin-client가 brain 건강 probe + 교정 제출, LLM-bearing 핸들러는 `run_protected_onboard` scope **추가** 요구. 로컬 CLI는 scope 우회(트러스트=OS). (웹, `operations.ts:4812+` 인용)
- **배포 형태**: OpenClaw 플러그인(`openclaw.plugin.json`, `openclaw-context-engine.ts`), GStack mod, clawhub 퍼블리시. `bun build --compile`로 단일 바이너리(런타임 번들). 에이전트 설치형(`INSTALL_FOR_AGENTS.md` — 에이전트가 직접 설치·키 입력·43 skills 로드·dream cycle 구성·검증). (코드/웹 확인)
- **설치**: `bun install -g github:garrytan/gbrain` (npm 경로 없음, **Bun 전용**). (코드 확인 `package.json` engines + 웹)

---

## 12. 의존성 스택 (코드 확인 — `package.json`)

| 범주 | 패키지 | 역할 |
|---|---|---|
| 런타임 | Bun ≥1.3.10 (+ `@types/bun`, `bun-types`) | 실행·번들·패키지 매니저, TS 직접 실행 |
| DB(임베디드) | `@electric-sql/pglite` 0.4.3 | Postgres 17.x WASM, 서버리스 기본 |
| DB(서버) | `postgres` ^3.4 (postgres.js), `pgvector` ^0.2 | Supabase/자체호스트 + 벡터 |
| AI | `ai` ^6, `@ai-sdk/{anthropic,google,openai,openai-compatible}`, `@anthropic-ai/sdk`, `openai` | 멀티 제공자 게이트웨이 |
| MCP | `@modelcontextprotocol/sdk` 1.29.0 | stdio/HTTP MCP 서버 |
| 코드 인텔 | `web-tree-sitter` 0.22.6, `tree-sitter-wasms` 0.1.13 | 심볼 청킹·그래프 |
| 토큰/마크다운 | `@dqbd/tiktoken`, `gray-matter`(frontmatter), `marked`, `js-yaml` | 청킹·파싱 |
| 멀티모달 | `@jsquash/{avif,png}`, `heic-decode`, `exifr` | 이미지 수집/디코드 |
| HTTP/유틸 | `express` 5, `cors`, `cookie-parser`, `express-rate-limit`, `eventsource-parser`, `chokidar`(파일 감시), `@aws-sdk/client-s3` | 서버·동기 |
| 검증/테스트 | `zod` ^4, `fast-check`(property 기반 퍼징), TypeScript ^5.6 | 스키마·테스트 |

---

## 13. 웹 주장 vs 코드 — 정정 사항

딥리서치가 기각/미확정한 항목을 코드 조사가 실제 메커니즘으로 해소:

| 웹 주장 | 웹 판정 | 코드 확인 결론 |
|---|---|---|
| Minions = BullMQ | 만장일치 기각(0-3) | **자체 durable queue + child-process supervisor**. BullMQ 아님. (`src/core/minions/queue.ts`, `supervisor.ts`) |
| ZeroEntropy 기본 임베딩 + OpenAI/Voyage fallback | 기각/미확정(1-2) | 게이트웨이 **멀티 제공자, 기본은 설정 가능**. 코드에 ZeroEntropy 하드코딩 없음. |
| "~47 operations" | README 추정치 | `operations.ts` `scope:` **97개**, CLAUDE.md "~90". README 47은 과소. |
| Postgres 17 | — | 코드는 "PostgreSQL 17.5"(반올림 표기). |
| 그래프 자가배선 zero-LLM (정밀 변형) | 확인(3-0) / 부정밀 변형은 1-2 | 메커니즘 **코드 확인**(정규식, LLM 호출부 없음). 벤치 수치는 **자가보고**. |

---

## 14. 평가·한계·미해결

**강점(코드로 확증)**: 계약-우선 단일 소스 → CLI/MCP 자동 생성, 엔진 parity 불변식, fail-closed 트러스트, source isolation, 검색 파이프라인의 깊이(의도 분류·그래프 arm·캐시·토큰 예산까지), zero-LLM 그래프, 자율 유지보수 데몬, contextual retrieval 2-페이즈 무중간상태. 테스트 857개 + 다수 `check:*` 가드 스크립트로 불변식을 CI에서 집행.

**한계·주의**:
- **벤치마크 자가보고**: P@5 49.1%/R@5 97.9%는 저자 자신의 gbrain-evals(Opus 생성 코퍼스), **제3자 미감사**. 메커니즘은 사실이나 수치는 마케팅 주장으로 취급.
- **빠른 변화**: v0.42.47.0, master 활발. 버전 핀·기능 기본값은 릴리스 간 변동.
- **Bun 락인**: Node 경로 없음. Bun 미설치 환경은 진입 불가.
- **PGLite 단일 writer**: Minions supervisor·별도 워커는 Postgres 전용. 개인(PGLite) 모드는 자율 데몬 일부 제약.

**미해결 질문**(코드만으로 결론 못 낸 것):
1. 오늘 출하되는 **실제 기본 임베딩 모델·리랭커**가 무엇이고 어떻게 설정되는가(`evals/embedding-provider-eval.json`·`model-config.ts` 추가 정독 필요).
2. BrainBench 수치의 **독립 재현성**.
3. OpenClaw/Hermes 생태계와 gbrain↔gstack 책임 분리가 실제 배포에서 어떻게 매핑되는가.

---

## 부록 — 1차 근거 위치 요약

- 검색: `src/core/search/hybrid.ts`(RRF_K=60, COMPILED_TRUTH_BOOST=2.0), `search/` 33개 모듈
- 그래프: `src/core/link-extraction.ts`(`inferLinkType`, 우선순위 라인 688)
- 엔진: `engine-factory.ts`, `pglite-engine.ts`, `postgres-engine.ts`, 스키마 `migrate.ts`
- 계약: `operations.ts`(scope 97), `src/mcp/tool-defs.ts`
- 자율: `cycle.ts`(페이즈), `minions/supervisor.ts`(워커)
- AI: `ai/gateway.ts`, `embedding.ts`, `contextual-retrieval-service.ts`
- 보정: `calibration/`, `DESIGN.md`
- 사상/불변식: `CLAUDE.md`, `AGENTS.md`, `docs/integrations/README.md`

> 딥리서치 원본 결과(JSON, 99 에이전트·25 주장 검증)는 task `wwd5f4aug` 출력에 보존.
