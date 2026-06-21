---
title: "에이전트 장기기억 3종 통합 연구 — GBrain · claude-mem · ditto memory"
kind: research
last_updated: 2026-06-18 KST
work_item: wi_260618za3
scope: "세 에이전트-메모리 시스템을 동일한 코드레벨 깊이로 정리하고 비교한다. GBrain(garrytan/gbrain) · claude-mem(thedotmack/claude-mem) · ditto memory(이 저장소)."
sources:
  - "reports/research/gbrain-code-level-research.md (GBrain 원본 deep-dive, clone v0.42.47.0 @ 2026-06-17)"
  - "reports/harnesses/claude-mem-research-ko.md (claude-mem 원본 deep-dive, clone v13.6.2 @ commit aafbb3a2, 2026-06-17)"
  - "reports/research/ditto-memory-vs-gbrain.md (기존 2-way 비교)"
  - "ditto memory: 이번 세션 fresh 코드 확인 (src/core/memory-*.ts · src/schemas/memory-*.ts · 설계 · ADR-0013/0015/0020)"
evidence_levels: "[코드]=소스 file:line 직접 확인 · [웹]=2차 자료 · [자가보고]=저자/벤더 주장(제3자 미감사) · [설계]/[ADR]/[스펙]=ditto 내부 문서 · [추론]=직접 확인 안 됨(최소화·명시)"
---

# 에이전트 장기기억 3종 통합 연구

> **이 문서는 세 보고서를 대체하지 않고 통합·비교한다.** 원본 deep-dive 3개(위 `sources`)는 그대로 보존되며, 이 문서는 그 위에 동일 깊이의 단일 비교 레이어를 얹는다.

## 0. 이 문서에 대하여 — 범위·근거 출처·정직성 경계

**소비자**: ditto memory 설계 의사결정자(특히 `memory-librarian` 스펙 진행) + 에이전트 메모리 시스템을 비교 평가하려는 사람.

**근거 출처의 비대칭(중요).** 세 시스템의 `[코드]` 태그는 출처가 다르며, 이 문서는 그 차이를 숨기지 않는다:

| 시스템 | `[코드]` 근거의 출처 | 이번 세션 재검증 |
|---|---|---|
| **GBrain** | 원본 보고서가 `git clone`(master, v0.42.47.0, 2026-06-17)을 정독해 기록한 file:line. | **아니오** — 재clone 안 함. file:line은 그 시점 기준이며 현재와 다를 수 있다. |
| **claude-mem** | 원본 보고서가 `git clone --depth 1`(v13.6.2, commit `aafbb3a2`, 2026-06-17)을 정독해 기록한 file:line. 일부 웹 자료는 페처 403으로 검색 스니펫 의존. | **아니오** — 재clone 안 함. |
| **ditto memory** | `src/core/memory-*.ts`·`src/schemas/memory-*.ts`를 **이번 세션(2026-06-18) 직접 열어** 확인한 현재 file:line. | **예** — fresh. |

즉 GBrain·claude-mem의 정밀 라인 번호는 **해당 clone 시점의 정확한 사실**이되 오늘 기준 재검증된 것은 아니다(외부 저장소 재clone은 비용이 커 기본 비수행). ditto memory만 오늘 기준이다. 외부 두 시스템의 정밀 재검증이 필요하면 별도 재clone을 수행할 수 있다.

**정직성 규칙**: 모든 사실 주장에 근거 태그를 붙였다. `[자가보고]`(벤치마크·운영 규모 등)는 제3자 미감사이며 마케팅 주장으로 취급한다. `[추론]`은 직접 확인 못 한 항목에만 붙였고 최소화했다.

---

## 1. 한눈에 — 세 시스템 한 줄 정의와 분류

| | **GBrain** | **claude-mem** | **ditto memory** |
|---|---|---|---|
| 한 줄 정의 | Postgres를 엔진으로 쓰는 **AI 에이전트용 범용 장기기억** — 검색이 아니라 *답을 합성* | Claude Code **세션 간 기억상실 해결** — 관찰자 LLM이 세션을 압축·재주입 | 코드·결정·근거의 **출처·신선도 보장 거버넌스 그래프** — 답 합성이 아니라 *자문* |
| 저자/맥락 | Garry Tan (YC CEO), OpenClaw/Hermes 프로덕션 brain `[웹/자가보고]` | Alex Newman (@thedotmack) `[웹]` | 이 저장소(DITTO) |
| 분류 | RDB(Postgres/PGLite) + 하이브리드 RAG + 도메인 엔티티 그래프 | LLM-as-observer 압축 파이프라인 + SQLite/Chroma | 인프로세스 거버넌스 그래프(무서버, 무벡터) |
| 핵심 가치 | 검색 품질 + 합성 + 외부 수집 + 24/7 자율 | 자동·암묵·전수 캡처 + 토큰 절약형 회상 | 출처·2축 신선도·확신도 계급·승인 기반 쓰기 |
| 규모 | **~243k LOC** src, 857 tests, MIT, Bun 전용 `[코드]` | TS+일부 Python, 수만 stars(편차 큼, 미단정) `[웹]` | memory core **~3.3k LOC** `[코드]` |
| 라이선스/런타임 | MIT / Bun ≥1.3.10 `[코드]` | Apache-2.0 / Node≥20·Bun·uvx `[코드]` | (이 저장소) / Bun+TS `[ADR]` |

**세 줄 결론**: GBrain은 *범용 지식 검색 엔진*, claude-mem은 *세션 자동 압축기*, ditto memory는 *엔지니어링 거버넌스 그래프*다. 같은 "에이전트 메모리" 영역이지만 캡처 철학(전수 자동 vs 승인 명시)·검색 패러다임(벡터 RAG vs 그래프 traversal)·신뢰 모델(LLM 위임 vs 형식적 확신도 계급)에서 **다른 종(種)**이다.

---

## 2. GBrain (garrytan/gbrain) — 코드레벨

> 근거: 원본 `reports/research/gbrain-code-level-research.md` (clone v0.42.47.0, 2026-06-17; 딥리서치 99 에이전트·25 주장 적대검증 → 확인 21/기각 4). 이 절의 file:line은 그 시점 기준.

### 2.1 정체성·규모
- `package.json` `name:"gbrain"`, `version:"0.42.47.0"`, `"Postgres-native personal knowledge brain with hybrid RAG search"` `[코드]`. North Star(CLAUDE.md): "the next Postgres for memory" — 단일 기능이 아니라 BrainBench 전체로 증명하는 시스템 주장 `[코드]`.
- 규모: TypeScript **~243k LOC**(`src`), 소스 781, 테스트 857, MIT, Bun ≥1.3.10 전용 `[코드]`.
- 생태계 3분할: `gbrain`(코어) ↔ `gstack`(에이전트 코딩 교습 mod) ↔ `gbrain-evals`(BrainBench, gbrain을 git 의존성으로 import) `[웹+코드]`.
- 자가보고 운영 규모: 146,646 pages, 24,585 people, 5,339 companies, 66 cron jobs `[자가보고]`.

### 2.2 설계 사상 (5축)
1. **"검색이 아니라 답을 준다."** 출처 붙은 합성 산문 + 모르는 것(gap) 명시 `[웹]`.
2. **"Code for data, LLMs for judgment."** 수집은 결정적 코드, 판단(엔티티 인식)만 LLM `[웹]`.
3. **Contract-first 단일 진실원.** `src/core/operations.ts` 한 곳이 모든 op 정의 → CLI·MCP 둘 다 생성 `[코드]`.
4. **Engine parity 불변식.** PGLite↔Postgres lockstep, e2e로 고정 `[코드]`.
5. **Fail-closed 트러스트.** `OperationContext.remote` 타입 필수, `false` 아니면 untrusted `[코드]`.
- 추가: **자율성 우선** — 24/7 데몬이 수집·강화·통합 `[웹]`.

### 2.3 아키텍처 — Contract-first + Dual Engine
- **Operation 계약**: `operations.ts`(5,104 LOC), `scope:` 표기 **97개**(`grep -c`; README "~47"은 과소, CLAUDE.md "~90") `[코드]`. 각 op `scope: read|write|admin` + `localOnly`, HTTP MCP가 핸들러 실행 **전에** 강제 `[코드]`. `src/mcp/tool-defs.ts`의 `paramDefToSchema` 단일 매퍼를 stdio/HTTP MCP·subagent 레지스트리 셋이 공유 `[코드]`.
- **Dual Engine**: `engine-factory.ts` 동적 import. `PGLiteEngine`(5,659 LOC) = Postgres 17.x WASM 임베드, `gbrain init --pglite` 2초, 개인 brain(~50K pages) 기본. `PostgresEngine`(5,803 LOC) = postgres.js, Supabase/자체호스트 `[코드]`.
- **두 직교 축**: Brain(어느 DB) × Source(DB 안 어느 repo), `(source_id, slug)` 복합키. 모든 read가 `sourceScopeOpts(ctx)`로 라우팅 — source isolation이 데이터유출 방지 핵심 불변식 `[코드]`.

### 2.4 저장·스키마
- 벡터 `VECTOR(1536)` + **HNSW**(`vector_cosine_ops`), pgvector 0.7+ `[코드]`. 전문검색 `TSVECTOR` + 트리거(`update_chunk_search_vector`), `doc_comment`·`symbol_name_qualified`=weight A, `chunk_text`=weight B `[코드]`. DDL은 `migrate.ts` `MIGRATIONS` 단일 소스, `CREATE INDEX CONCURRENTLY`는 Postgres `transaction:false`로 분기 `[코드]`.
- 지식은 git repo 마크다운(frontmatter+wikilink)으로 살고 sync가 Postgres로 투영, git 삭제 = DB soft-delete `[웹+코드]`.

### 2.5 하이브리드 검색 파이프라인 (핵심 IP)
- `src/core/search/hybrid.ts`(87KB) 헤더: "**keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup**" `[코드]`. `RRF_K=60`, `COMPILED_TRUTH_BOOST=2.0`, blend `0.7*rrf + 0.3*cosine` `[코드]`.
- 부속 모듈(같은 디렉터리): `autocut`·`rerank`·`query-intent`/`intent-weights`·`relational-recall`/`graph-signals`·`recency-decay`·`query-cache`·`two-pass`·`token-budget`·`dedup`·`telemetry`·`embedding-column` `[코드]`.
- 웹 정정: "HNSW+BM25+RRF"는 확인, BullMQ·특정 임베딩 제공자 묶은 확대 변형은 만장일치 기각 `[웹/코드]`.

### 2.6 자가배선 지식 그래프 (Zero-LLM)
- `link-extraction.ts`(1,229 LOC), **모든 함수 순수(DB 접근 0)**, **LLM 호출 0** — `inferLinkType`이 정규식(`FOUNDED_RE` 등) `[코드]`.
- 엣지 타입: `mentions/works_at/invested_in/founded/advises/attended/wikilink_basename`. 우선순위 `founded>invested_in>advises>works_at>role prior>mentions`(line 688) `[코드]`. 세 추출 경로(마크다운 링크/위키링크/frontmatter), 버전 스탬프 재추출 `[코드]`.
- 효과: 240페이지 코퍼스 P@5 49.1%/R@5 97.9%, 그래프-off 대비 +31.4 P@5 — **메커니즘은 코드 확인, 수치는 `[자가보고]`(BrainBench, 제3자 미감사)**.

### 2.7 자율 유지보수 — Dream Cycle · Minions
- `cycle.ts`(2,424 LOC) `runCycle()` 단일 소스. 페이즈: `lint --fix → backlinks --fix → sync → synthesize → extract → patterns → recompute_emotional_weight → embed --stale → orphans` + calibration wave + `extract_atoms/facts`·`schema-suggest` `[코드]`. 동시성 잠금: Postgres `gbrain_cycle_locks` 행+TTL 30분, PGLite 파일잠금 `[코드]`.
- Minions: **BullMQ 아님**(웹 주장 기각) — 자체 durable queue(`queue.ts`) + `MinionSupervisor`(자식 프로세스 spawn, 지수 백오프, PID 원자잠금) `[코드]`. rate-leases·budget·quiet-hours·self-fix·error-classify. **Postgres 전용**(PGLite 단일 writer가 별도 워커 차단) `[코드]`.

### 2.8 AI 게이트웨이·임베딩·Contextual Retrieval
- `ai/gateway.ts` = 모든 AI 호출 단일 seam(`embed/expand/generateText/generateObject`). Vercel AI SDK(`ai`^6) + `@ai-sdk/{anthropic,google,openai,openai-compatible}` + 직접 번들 `[코드]`. `configureGateway()` 1회 주입, 호출시 `process.env` 안 읽음, `abortSignal` 기본 `[코드]`. **멀티 제공자, 기본 임베딩 하드코딩 없음**(웹 "ZeroEntropy 기본" 기각) `[코드]`.
- `contextual-retrieval-service.ts`(593 LOC): 각 청크를 LLM synopsis와 함께 재임베드, 2-페이즈(phase1 인메모리 수집, 디스크 중간상태 0; phase2 단일 트랜잭션), synopsis=Haiku `[코드]`.

### 2.9 보정 (Calibration / "Hindsight" — 독특)
- `calibration/` + `propose_takes/grade_takes/calibration_profile`. **takes** = 채점 가능한 주장/예측, accept/reject→judge verdict(자동해소 OFF 기본), **Brier score** 추적 `[코드]`. Voice gate(`gateVoice`, Haiku judge가 학술 어투 reject, 최대 2회 재생성, 손작성 fallback), 서버렌더 SVG 차트 `[코드]`.

### 2.10 MCP·배포·의존성
- MCP: `server.ts`(stdio) + HTTP(`StreamableHTTPServerTransport`) **OAuth 2.1 PKCE**, `@modelcontextprotocol/sdk` 1.29.0 `[코드/웹]`. 배포: OpenClaw 플러그인/GStack mod/clawhub, `bun build --compile` 단일 바이너리, 설치 `bun install -g github:garrytan/gbrain`(npm 경로 없음, **Bun 전용**) `[코드]`.
- 부가: `chunkers/`의 **tree-sitter** 코드 청킹(`web-tree-sitter` 0.22.6), CLI `code-callers/callees/def/refs` 심볼 그래프 질의 `[코드]`.
- 의존성: PGLite 0.4.3, postgres ^3.4, pgvector ^0.2, ai ^6, mcp-sdk 1.29.0, tiktoken, gray-matter, jsquash/heic/exifr(멀티모달), express 5, chokidar, zod ^4, fast-check `[코드]`.

### 2.11 위험·한계
- 벤치마크 **자가보고**(제3자 미감사), 빠른 변화(master 활발), **Bun 락인**(Node 경로 없음), **PGLite 단일 writer**(자율 데몬 일부 Postgres 전용) `[웹/코드]`.

### 2.12 목표·사용자 가치
- **목표**: "the next Postgres for memory" — 회사 brain·개인 AI를 위한 검색+에이전트 기억 시스템. 단일 청크 검색이 아니라 **출처 붙은 합성 답 + 모르는 것(gap) 명시**를 주는 것이 명시 목표 `[코드]` CLAUDE.md North Star, `[웹]` README.
- **사용자 가치**:
  - 에이전트가 사람·회사·미팅·아이디어를 영속 기억 → 매 세션 재학습 불필요 `[웹]`.
  - "검색 결과 N개"가 아니라 합성 산문 답 + brain이 모르는 것 heads-up `[웹]`.
  - 24/7 dream cycle이 사용자 개입 없이 수집·강화·통합 `[코드]` `cycle.ts`.
  - PGLite로 2초 무서버 시작(개인 ~50K pages) → Postgres로 팀 공유·대규모 확장(동일 SQL lockstep) `[코드]`.
  - MCP(OAuth)·CLI로 범용 호스트에서 소비, 단일 바이너리 배포 `[코드]`.
  - (검증 한계) 운영 규모 146k pages·검색 정확도(P@5 49.1%/R@5 97.9%)는 저자 `[자가보고]`(제3자 미감사).

---

## 3. claude-mem (thedotmack/claude-mem) — 코드레벨

> 근거: 원본 `reports/harnesses/claude-mem-research-ko.md` (clone v13.6.2 @ `aafbb3a2`, 2026-06-17; 4개 영역 서브에이전트 분할 정독 + 웹). 일부 웹은 403로 스니펫 의존. file:line은 그 시점 기준.

### 3.1 정체성·목적
- `package.json`: "Memory compression system for Claude Code - persist context across sessions" `[코드]`. 단순 로그가 아니라 **LLM-as-observer 압축 파이프라인** — 별도 관찰자 Claude가 세션을 보고 타입드 `<observation>`으로 증류 `[코드]`.
- 정적 `CLAUDE.md`/Anthropic Memory tool과 **상호보완**(대체 아님). 채우는 칸 = "세션 히스토리 자동 캡처 + 검색형 회상" `[코드/웹]`.

### 3.2 설계 사상
- **자동·암묵·전수 캡처**(에이전트 결정 불요) — 작업 중 모든 것을 디폴트 캡처(`<private>` 제외) `[코드]`.
- **관찰자 LLM 패턴**: 1차 세션을 별도 Claude가 관찰 `[코드]`. **로컬-퍼스트**(데이터가 머신을 안 떠남, ONNX 임베딩) `[코드]`.
- **3계층 점진적 공개**로 토큰 절약 `[코드]`.

### 3.3 아키텍처 — 훅 계층 + 관찰자
- 훅(얇은 `node bun-runner` 셸): `SessionStart`(start+context), `UserPromptSubmit`(session-init, 의미검색 기본 OFF), `PostToolUse`(observation), `PreToolUse:Read`(file-context), `Stop`(summarize) `[코드]`. 주입 = `hookSpecificOutput.additionalContext` stdout JSON(`context.ts:80-83`) `[코드]`.
- 훅↔워커 = **무인증 loopback HTTP**(`worker-utils.ts:169-171`) `[코드]`. 워커 down 시 `WorkerFallback` no-op로 세션 안 막음(`:642-652`) `[코드]`. Windows 규율: transient는 exit 0, 연속 3회 실패만 exit 2(`hook-command.ts:121-131`) `[코드]`.
- **위험**: `PreCompact`·`SessionEnd` 미등록 → 크래시로 `Stop` 안 불리면 그 세션 미요약 `[코드]`.

### 3.4 압축 파이프라인 — 관찰자 LLM
- 워커가 세션마다 `@anthropic-ai/claude-agent-sdk` `query()`로 자식 Claude spawn(`ClaudeProvider.ts:232-246`) `[코드]`. 출력 `<observation>` XML(type/title/facts/narrative/concepts/files_read/files_modified) 정규식 파싱(`parser.ts:87-90`) → SQLite(`ResponseProcessor.ts:174-176`) `[코드]`. 모드 템플릿(`prompts.ts:24-79`); `code` 모드 8종(bugfix/feature/refactor/change/discovery/decision/security_alert/security_note) `[코드]`. 모델 tier alias `$TIER:fast|smart`, Gemini/OpenRouter 대안 `[코드]`.

### 3.5 저장·데이터 모델
- 정본 = `~/.claude-mem/claude-mem.db`(`bun:sqlite` WAL). 테이블: `sdk_sessions`, `observations`(`UNIQUE(memory_session_id, content_hash)` 디둡), `session_summaries`, `user_prompts`, `pending_messages`(durable 큐), `observation_feedback` `[코드]`.
- **"knowledge-graph"는 마케팅**: 노드/엣지 테이블 없음, `concepts`는 JSON 문자열 컬럼, `knowledge/`는 그래프 DB가 아니라 코퍼스 RAG `[코드]`.
- Chroma는 **외부 Python 프로세스**: `uvx chroma-mcp==0.2.6 --client-type persistent`(`ChromaMcpManager.ts:241-247`), 임베딩 **all-MiniLM-L6-v2(384차원 ONNX)**, 부재 시 SQLite FTS5/LIKE 폴백 `[코드]`. (server-beta) Postgres `embedding` JSONB 컬럼은 정의됐으나 벡터로 미사용, 검색은 `tsvector` `[코드]`.

### 3.6 검색 — 하이브리드 + 3계층
- `SearchOrchestrator` 전략 패턴: Chroma는 랭커, 본문은 항상 SQLite에서 하이드레이트(정본=SQLite) `[코드]`. FTS5 contentless + BM25 `rank` `[코드]`.
- 3계층(`mcp-server.ts:433-457`): `search`(ID 인덱스 ~50-100토큰) → `timeline` → `get_observations` `[코드]`. **"~10x 토큰 절약"은 벤더 주장, 독립 벤치 아님** `[자가보고]`.

### 3.7 MCP·워커
- MCP: `mcp-server.ts` stdio, JSON Schema(zod 아님), ~21개 도구(3계층 검색, observation CRUD(server-beta), tree-sitter `smart_*`, 코퍼스 `build/prime/query_corpus`) `[코드]`.
- 워커/수퍼바이저(과거 고아 프로세스 #1090, ~$183/day 이력): bind `127.0.0.1`, 포트 `37700+(uid%100)`, SDK 동시성 캡 10, 종료 캐스케이드 SIGTERM→SIGKILL, PID 재사용 탐지, **env-sanitizer**가 spawn 전 `ANTHROPIC_API_KEY` 등 제거(`EnvManager.ts:23-48`) `[코드]`.
- 멀티 호스트: Claude Code·Codex·Gemini CLI 풀, OpenCode 풀; Cursor/Windsurf/OpenClaw 부분; **Copilot 사실상 스텁**(MCP만, `McpIntegrations.ts:110`) `[코드]`.

### 3.8 기술 스택
- TS, Node≥20/**Bun**, 일부 Python(`uvx` chroma-mcp). `@anthropic-ai/claude-agent-sdk`·`@modelcontextprotocol/sdk`·all-MiniLM-L6-v2(ONNX). SQLite(FTS5/BM25)+Chroma /(server-beta) Postgres+Redis·BullMQ(옵션). Express 5, React 19 웹뷰어, better-auth, tree-sitter 20+, posthog-node `[코드]`.

### 3.9 위험 (코드 확인)
- **로컬 워커 데이터플레인 전체 무인증**(`/api/settings`, `/api/observations`, `/api/sessions`, `/api/import`) — 방어는 loopback 바인드뿐 `[코드]`.
- **`GET /api/settings` 평문 키 반환 — 현재도 미수정**(`SettingsRoutes.ts:48-53`, 마스킹 없음) `[코드]`. `0.0.0.0` 바인드 허용(`:242`) + 무인증 `POST /api/settings`로 변경 가능 `[코드]`. 자격증명 권한 비대칭(.env `0600` vs settings.json 키 chmod 없음, `install.ts:771`) `[코드]`.
- 외부 감사 #1251(v10.5.2) HIGH·4 critical(경로순회·무인증 30+·0.0.0.0·평문키); 현재 경로순회는 완화, **무인증·평문키 잔존** `[웹/코드]`.
- **텔레메트리 기본 ON(opt-out) + 내장 PostHog 키**(`common.ts:18-20`), `disableGeoip:false`. **`SECURITY.md:157` "텔레메트리 미수집" 문구가 코드와 모순** `[코드]`.
- 거버넌스 신호: "CMEM" 암호화폐 토큰(Base 체인), `meme-tokens`/`law-study`/`email-investigation`(epstein-mode 예시) 모드 — 방향성 분산 신호(사실 적시) `[코드/웹]`.
- 효과 과장 경고: "~10x/63x/best-in-class"는 측정 아닌 주장, stars 46K~83K 편차로 미단정 `[자가보고/웹]`.

### 3.10 도메인 범용성
- 일반형 = "세션 트랜스크립트 → LLM 타입드 압축 관찰 → 검색 가능 로컬 스토어". 저자가 이미 `modes/`(meme-tokens/law-study/email-investigation·`ragtime/`)로 코딩 외 도메인 증명 `[코드]`.

### 3.11 목표·사용자 가치
- **목표**: Claude Code의 "세션 간 기억상실" 해결 — 세션에서 일어난 일을 압축 캡처해 다음 세션에 자동 재주입, 컨텍스트 영속성 확보 `[코드]` package.json.
- **사용자 가치**:
  - 끄거나 `/compact` 후에도 "이 프로젝트의 결정·버그·함정"이 증발하지 않음 `[코드/웹]`.
  - **에이전트 결정·설정 불요** — 자동·암묵·전수 캡처(`<private>` 제외) `[코드]`.
  - 3계층 점진적 공개로 회상 토큰 비용 절감(벤더 "~10x" 주장은 `[자가보고]` 미검증).
  - 다중 호스트(Claude Code/Codex/Gemini CLI) 간 "portable working memory" `[코드]`.
  - 로컬-퍼스트 — 데이터가 사용자 머신을 안 떠남(ONNX 임베딩) `[코드]`.
  - 도메인 모드 교체로 코딩 외(법학·이메일 등)에도 사용 `[코드]`.
  - (대가) 자동·전수 캡처는 무인증 데이터플레인·평문키 등 넓은 보안 표면을 동반 — §3.9.

---

## 4. ditto memory (이 저장소) — 코드레벨

> 근거: **이번 세션(2026-06-18) fresh 확인**. file:line은 현재 코드 기준.

### 4.1 정체성·규모
- 코드·결정·핸드오프를 출처(provenance) 동반 그래프로 묶어 cross-entity 맥락을 질의 가능하게 하는 **읽기 자문(advisory) 메모리 서브시스템**. DITTO 기능 4축 중 **지식 축** `[스펙]` `.ditto/specs/memory-librarian.md:15`, `[ADR]` ADR-0013.
- 규모(`wc -l` 직접 측정): memory core+schema **3,279 LOC** `[코드]`. 주요: `memory-project.ts` 657, `memory-bootstrap.ts` 398, `memory-query.ts` 395, `memory-build.ts` 366, `memory-ir.ts` 293, `memory-warmstart.ts` 251, `memory-scan.ts` 225, `memory-store.ts` 225, `memory-reduce.ts` 82, `memory-flag.ts` 17; 스키마 `memory-graph-ir.ts` 180·`memory-event.ts` 74·`memory-source.ts` 62·`memory-projection-manifest.ts` 54. (CLI `memory.ts` 1,129+행, autopilot 통합은 미포함.)

### 4.2 설계 사상
- **거버넌스 우선 / 자문 층.** 그래프는 읽기 자문이며 에이전트가 무시하고 차갑게 일해도 시스템은 돈다 `[설계]` §5:171,176. 추측은 사실로 안 굳음(세탁 방지) `[설계]` §4-2:127.
- **결정적 바닥 + measure-before-expand.** 색인-shaped는 증명됨, 의미층(INFERRED)은 미검증 → bounded·measurable·reversible 확장 `[ADR]` ADR-0013 D4(라인 32-37).
- **벡터 RAG 비채택.** v0 검색은 그래프 traversal + 라벨/식별자 매칭으로 충분, 벡터는 필요 증명 후 별도 증분 `[설계]` §3-6:89. 코드에 임베딩/벡터 의존 없음(§4.12).
- **판단은 host LLM, ditto는 검색·라우팅·투명성만.** ditto는 LLM 키를 직접 안 듦 `[설계]` §3-4:73, `[ADR]` ADR-0001. ADR 모순 검출도 "충돌 존재?"는 host에 위임, ditto는 검색(adrGist)·라우팅·투명성만 `[ADR]` ADR-0020 D4(라인 28-30).
- **무서버.** 그래프 DB 상시 런타임 기각, 인프로세스 빌드. Neo4j는 선택적 export일 뿐 SoT/런타임 아님 `[ADR]` ADR-0013 D1(라인 14-18).

### 4.3 아키텍처 — 런타임·저장
- **인프로세스 그래프.** `graph-ir.json`에서 빌드, 서빙 그래프(`graph.json`) 인프로세스 read로 `query/path/explain` `[ADR]` ADR-0013 D1. read/write `memory-store.ts:206-214`(`writeServing/readServing`), traversal `memory-query.ts:133`(`queryNeighbors`) `[코드]`.
- **2-tier 저장** `[ADR]` ADR-0013 D2:
  - SoT(git-tracked, per-entity JSON) = `dittoDir/memory/`: `sources/`(`memory-store.ts:54`), `events/`(`:97`) `[코드]`.
  - 파생물(gitignored, 재생성 가능) = `localDir/memory/`: `ir/graph-ir.json`(`:163`), `projections/`(`:181`) `[코드]`.
- **이벤트 불변(append-only).** 이벤트당 불변 JSON, `open(path,'wx')`로 기존 존재 시 실패 → 불변·TOCTOU 차단(`memory-store.ts:115`, `MemoryEventExistsError` `:117-119`) `[코드]`.

### 4.4 데이터 모델 — 노드/엣지 (전부 `memory-graph-ir.ts` 현재 라인)
- **노드 11종**(`memoryNodeType` :31-45): `Source, Artifact, Symbol, DocumentSection, Entity, Concept, Claim, Decision, Episode, MemoryEvent, GraphReport` `[코드]`.
- **엣지 13종**(`memoryEdgeType` :47-63): `CALLS, IMPORTS, EXTENDS, IMPLEMENTS, MENTIONS, ASSERTS, SUPPORTS, CONTRADICTS, SIMILAR_TO, RELATED_TO, RATIONALE_FOR, ALIAS_OF, SUPERSEDES` `[코드]`.
- **하이퍼엣지 3종**(`memoryHyperedgeRelation` :65-67): `PARTICIPATE_IN, IMPLEMENT, FORM`. N-ary, `nodes ≥ 3` 강제(:149-160) `[코드]`.
- **confidence_kind 3종**(:5-9): `EXTRACTED`(출처 명시)/`INFERRED`(연역)/`AMBIGUOUS`(불확실). **밴드 강제**(`enforceConfidenceBands` :98-125, `superRefine` :144-146/:159): EXTRACTED=정확히 1.0, AMBIGUOUS=[0.1,0.3], INFERRED=[0.4,0.95], 위반은 loud fail `[코드]`.
- **provenance 필수.** 엣지 `provenance` 필수(:69-79), `extraction_run_id` + `extracted_by`(enum: tree-sitter/codeql/impact/llm/node2vec/human/other) + `schema_version` → 그래프 항상 재생성 가능 `[코드]`.

### 4.5 추출 — 구조적 vs 의미적
- **(A) 결정적 흡수 — EXTRACTED=1.0** `memory-ir.ts`: `absorbAcgIntoIr`(:113)가 기존 ACG 산출물(Impact/boundary/Semantic scan)을 IR로 변환(순수). impact affected → Symbol + per-kind `RELATED_TO`(EXTRACTED=1.0), `acg_kind` 보존(과단언 금지 D3, :157-173). boundary import → Artifact×2 + `IMPORTS`(:235-249). unresolved → `AMBIGUOUS`=0.1+`requires_review`(:197-211). 미지원 kind는 `UnsupportedAcgKindError` loud fail(:48-56) `[코드]`.
- **(B) 의미 추출 — INFERRED/AMBIGUOUS, host 위임** `memory-build.ts`: ditto는 프로바이더 직접 호출 안 함(:10, `[ADR]` ADR-0001). `chunkSources()`(기본 22파일, `CHUNK_FILE_COUNT=22`)가 `memory-extractor` 에이전트용 패킷 생성, host LLM이 IR 조각 반환. 추출기 confidence는 EXTRACTED **제외**(:88). `mergeIrFragments()`(:190) 결정적 병합, extracted_by='llm'. **secret 파일은 청크 전 제거되어 host LLM에 절대 미도달**(:73-75) `[코드]`.

### 4.6 검색·질의 (`memory-query.ts`, READ-ONLY)
- **그래프 traversal = 무방향 BFS.** `queryNeighbors`(:133) depth 기본 2, `neighborsOf`(:106)가 out+in 모두 모음. `shortestPath`(:240)도 무방향 `[코드]`.
- **라벨/식별자 매칭 + 본문검색 fallback.** node id 부재 시 이벤트 본문 검색(`searchEventBodies` :181: substring 또는 토큰 len≥3 공유), CLI 자동 fallback(`memory.ts:629`) `[코드]`.
- **임베딩/벡터 없음.** 코드 어디에도 벡터·코사인 검색 없음, 매칭은 토큰/substring/인접만. `[설계]` §3-6:89 명시 기각 `[코드]`.
- 모든 답에 freshness envelope 동봉(§4.8).

### 4.7 쓰기 거버넌스 (`memory-project.ts` :289-442) `[ADR]` ADR-0013 D3
- **에이전트 직접 쓰기 금지.** 그래프/IR 쓰기 API 미노출(:289-299). 영향 경로 = `proposeEvent`(:360)→pending → `approveEvent`(:396)→새 불변 approved 이벤트가 원본 supersede → 재projection 뿐 `[코드]`.
- **propose→approve→re-projection.** `approveEvent`는 원본 불변, `status=approved`+`approved_by`+`decided_at`+`supersedes=원본id` 새 이벤트 append 후 즉시 `projectMemory` 재실행(:430-441) `[코드]`.
- **자기승인 차단.** agent 제안+agent 승인 → `MemorySelfApprovalError`(:419-422). 단 honor-system(자기신고 `--actor`) `[ADR]` ADR-0013 R2 `[코드]`.
- **supersedes 효력 규칙.** reducer가 체인 head 해소, superseding 이벤트가 effective(approved)일 때만 효력(`memory-reduce.ts:57-65,73-75`), pending은 무효력 `[코드]`. 이중승인 차단 `MemoryEventAlreadyDecidedError`(:411-415). approval invariant 스키마 강제(`memory-event.ts:45-69`) `[코드]`.

### 4.8 신선도 (2축) `[ADR]` ADR-0015
- 축1(SoT↔파생)+축2(코드↔SoT). `Freshness` enum = `fresh|stale|absent|code_drift|code_dirty`(`memory-project.ts:451`) `[코드]`.
- `code_drift` = owning-repo HEAD ≠ 저장 `git_commit`, `code_dirty` = 워킹트리 더티(`detectAxis2` :520-577) `[코드]`. **신규 스키마 0** — baseline은 `source_revisions[].git_commit` 재사용(:251-259) `[ADR]` ADR-0015 D2.
- 우선순위 `code_drift > stale > code_dirty > fresh`(:635-642) — stale이 dirty에 마스킹돼 주입되던 회귀 차단 `[ADR]` ADR-0015 D3 `[코드]`. 읽기마다 envelope(`projection_id·freshness·dirty_sources·drifted_sources`, `memory-query.ts:51-61`) `[코드]`. root porcelain은 `.ditto/`(tracked SoT) 제외(:498-501) `[코드]`.

### 4.9 통합·소비 지점
- **warm-start push — §5-1 단 1지점만 배선.** 호출부는 `autopilot-loop.ts:274`(wave)+`:357`(single-node) 2곳이나 둘 다 같은 dispatch loop의 동일 push(researcher/planner spawn 직전)이고 유일 진입점은 `warmStartMemoryContext`(`memory-warmstart.ts:162`). 결과는 `buildDelegationPacket`의 optional `memory` 필드로 주입(`autopilot-dispatch.ts:26,128-129`) `[코드]` `[ADR]` ADR-0013 D4.
- **§5-2~5-5 미배선.** knowledge-bridge·charter·user-prompt-submit·completion-contract 어디에도 memory query 호출 없음(grep 0건). `[설계]` §5는 "설계 제안"으로 명시, §10-6 표는 #1만 구현 `[코드]`.
- **CLI pull(보편).** `ditto memory`: `scan/events/bootstrap/build/project/status/query/path/explain/audit/propose/approve/usage`(전부 `cli/commands/memory.ts`) `[코드]`.
- **자동 트리거 유무.** scan은 githook 자동화 가능하나 의미 빌드는 명시 호출만 `[설계]` §4-6. audit→curator 자동 트리거 미배선("never triggers curator", `memory-query.ts:13-14`) `[ADR]` ADR-0013 D4. warm-start 사용 계측(`MemoryUsageRecord`, `memory-warmstart.ts:44-66`)이 확장 게이트 데이터원 `[코드]`.
- **MCP/스킬.** `skills/memory-graph/SKILL.md` 소비자 계약 존재, 배포본 복사됨. MCP 전용 노출은 미발견 `[코드]`.

### 4.10 되돌림·강등 (`memory-flag.ts`, 17행)
- **마스터 `DITTO_MEMORY`**: unset⇒on(기본), `off`/`0`⇒off(`isMemoryEnabled` :14-17). off는 자동 주입·계측만 단락, 명시 CLI는 계속 동작 `[코드]`. granular `DITTO_MEMORY_WARMSTART=0`(`memory-warmstart.ts:78-80`) `[코드]`.
- **fail-open.** warm-start 모든 degrade 경로(non-owner/disabled/projection 부재/NOT fresh/no coverage/no related/모든 throw)가 `undefined` 반환 ⇒ packet 무변경(:162-251, catch :242-250) `[코드]`.

### 4.11 알려진 빈틈 — 코드↔결정 다리 미배선 (이번 세션 재확인)
- **`RATIONALE_FOR`는 `Source → Decision`만 잇는다.** `memory-project.ts:101`(`edgeType = isDecision ? 'RATIONALE_FOR' : 'MENTIONS'`), `from`=`sourceNodeId`(`source:<id>` :104,:123), `to`=`nodeId`(`decision:<eventId>` :84,:124). 즉 정당화 **문서 Source→Decision**이며 **코드 Symbol→지배 Decision이 아니다** `[코드]`.
- **`memory-project.ts`에 `symbol:` 리터럴 전무**(`grep` 0건). Symbol 노드는 `memory-ir.ts` ACG 흡수에서만 생성되고, 그 Symbol을 ADR/Decision에 잇는 엣지 생성 경로가 없음 `[코드]`.
- **다리 데이터는 있으나 배선만 안 됨.** ADR 머리말 `관련:`이 지배 코드를 인용하나(ADR-0015 머리말이 `memory-project.ts` 등 인용), `memory-bootstrap.ts`는 ADR을 gist만 적재(`adrGist`, 이벤트 :235-250)하고 `관련` 참조를 코드 엣지로 파싱 안 함 `[코드]` `[스펙]` `.ditto/specs/memory-librarian.md:25-26`.
- 결과: 계획 에이전트가 파일에서 그래프를 타도 그 코드를 만든 ADR에 traversal로 도달 못 함(단 ADR 본문은 body-search fallback `queryBodies`로는 검색됨 — traversal 경로만의 빈틈) `[코드]`. 이 빈틈은 식별·정식화됐으나 **미구현**(스펙 §5·6·8·10·11 미작성, review=pending) `[스펙]`.

### 4.12 의존성·기술스택
- `package.json` deps = `citty`, `smol-toml`, `yaml`, `zod`만 `[코드]`. 메모리가 실제 import: **zod**(스키마·밴드 강제), **Node/Bun 내장만**(`node:crypto` sha256, `node:fs/promises`, `node:path`, `Bun.file/spawnSync` git 호출). **외부 DB/벡터/임베딩/ML 라이브러리 0**(`grep "sqlite|neo4j|embedding|vector|tree-sitter|@anthropic|openai"` → 0건) `[코드]`. 런타임 Bun+TS `[ADR]` ADR-0001.

### 4.13 미해결·미확인
- §5-1 warm-start 실제 hit율·actionability는 코드만으로 판정 불가(ADR-0013 ac-10 "미측정 명시 보류") `[ADR]`.
- impact→RELATED_TO 흡수의 **설계↔코드 불일치**: 설계 §4-1:112는 CALLS/IMPLEMENTS, 코드(`memory-ir.ts:165`)는 RELATED_TO+acg_kind로 보수화 — 의도된 최종이 어느 쪽인지 ADR 명시 기록 미발견 `[코드/미확인]`.
- MCP 도구 노출 여부 미확인(`src/mcp*` 경로 없음). 배포 번들에서 `ditto memory` 실행 검증 미수행(읽기전용 범위).

### 4.14 목표·사용자 가치
- **목표**: 에이전트가 **코드만 보고 그 뒤의 결정·제약·개발 중 발견을 못 본 채 자신 있게 계획·구현하는 환각**을 막는다 — 코드·결정·근거를 출처·신선도·확신도 보장 그래프로 묶어 **자문(advisory)**으로 제공 `[스펙]` `memory-librarian.md:19`, `[설계]` §1.
- **사용자 가치 (현재 구현 기준)**:
  - "이 코드/결정이 무엇과 왜 얽혔나"를 **출처 동반**으로 질의 — grep 전 consult `[코드]` `memory-query.ts`, CLI `query/path/explain`.
  - 모든 답에 **2축 freshness envelope** → 낡은·드리프트된 지식을 사실로 오인 안 함 `[ADR]` ADR-0015 `[코드]`.
  - **EXTRACTED/INFERRED/AMBIGUOUS 계급**으로 추측과 사실 구분, 세탁 방지 `[코드]`.
  - **propose→approve 불변 이벤트 + supersedes**로 감사·되돌림 가능한 기억 `[ADR]` ADR-0013 D3.
  - **무서버·git-native** → 핸드오프·머지·다중 PC에서 보존(이번 세션의 PC 이동에도 SoT는 git으로 따라옴) `[ADR]` ADR-0013 D1/D2.
  - **`DITTO_MEMORY=off` 단일 플래그·fail-open** → 언제든 무력화하고, 부재가 작업을 막지 않음 `[코드]`.
  - autopilot warm-start로 계획 에이전트에 자동 push `[코드]`(현재 §5-1 **1지점만** 배선).
- **설계 목표지만 아직 미실현(정직성)**: 환각 차단의 핵심인 "코드 Symbol → 지배 ADR(기각된 대안·불변식)" traversal은 **코드↔결정 다리 미배선**이라 아직 제공되지 않음(§4.11). 즉 *현재* 가치는 "결정·문서 그래프 + 신선도/확신도 거버넌스"이고, "코드에서 그 코드를 지배한 결정으로 도달"은 설계 목표(미구현).

---

## 5. 3-way 비교 (차원별)

> ditto 열은 fresh 확인. GBrain·claude-mem 열은 dated clone 보고서 근거(§0 비대칭).

| 차원 | GBrain | claude-mem | ditto memory |
|---|---|---|---|
| **목적** | 범용 에이전트 장기기억 + 답 합성 | Claude Code 세션 자동 캡처·재주입 | 코드·결정 거버넌스 지도(자문) |
| **캡처 철학** | 수집 결정적 + 판단 LLM | **자동·암묵·전수**(관찰자 LLM) | **명시·승인 기반**(propose→approve) |
| **저장 런타임** | Postgres/PGLite(WASM) 실 DB | SQLite(정본) + Chroma(외부) | 인프로세스 그래프 + JSON, 무서버 |
| **검색 패러다임** | 하이브리드 RAG(벡터 HNSW+BM25+RRF+rerank+intent+contextual) | 하이브리드(Chroma 벡터+FTS5) + 3계층 공개 | 그래프 BFS + 라벨/본문 매칭, **벡터 없음** |
| **답 합성** | synthesis + gap("모르는 것" 명시) | 없음(관찰 회상) | 없음(관계·출처만 자문) |
| **그래프** | zero-LLM 정규식 자가배선(도메인 엔티티) | **그래프 아님**(concepts=JSON, RAG) | 코드 구조(결정적)+의미(LLM 위임), 코드↔결정 다리 미배선 |
| **확신도 계급** | 명시 계급 없음(엣지=사실) | 없음(관찰=관찰자 LLM 신뢰) | **EXTRACTED/INFERRED/AMBIGUOUS 강제(superRefine)** |
| **출처·신선도** | sync(git→DB)+soft-delete, page provenance | observation 타임스탬프, freshness 형식화 없음 | **2축 freshness + 읽기마다 envelope + code_drift/dirty** |
| **쓰기 거버넌스** | 페이지 직접 쓰기(takes만 큐) | 직접 적재(전수) | **propose→approve 불변 이벤트 + supersedes + ADR 충돌 가드** |
| **자율 유지보수** | dream cycle 24/7 + Minions 워커 풀 | Stop 훅 summarize(데몬 워커) | 수동 scan/build/project, push 1지점 |
| **수집 범위** | 외부 세계(Gmail/Calendar/X/transcript) | 세션 트랜스크립트(+도메인 모드) | 저장소 내부(코드·문서·ADR) |
| **소비 인터페이스** | MCP(OAuth) + CLI, 범용 호스트 | 훅 주입 + MCP(stdio), 다중 호스트 | autopilot push(1) + CLI pull, 내부 전용 |
| **provider 결합** | Vercel AI SDK 직접 멀티 제공자 | claude-agent-sdk 직접(+Gemini/OpenRouter) | **직접 호출 안 함**(host 위임, ADR-0001) |
| **보안 표면** | OAuth 2.1·fail-closed trust·source isolation | **무인증 데이터플레인·평문키 잔존**(반면교사) | 무서버·secret 청크전 제거·승인 게이트 |
| **멀티모달** | 이미지 임베딩/디코드 | (코드 도구 tree-sitter) | 없음(스키마 슬롯만) |
| **성숙도/규모** | v0.42, ~243k LOC, 857 tests, 프로덕션 146k pages `[자가보고]` | v13.6.2, 수만 stars `[웹]` | v0, ~3.3k LOC, measure-before-expand |
| **라이선스/런타임** | MIT / Bun 전용 | Apache-2.0 / Node·Bun·uvx | (이 저장소) / Bun+TS |

---

## 6. 핵심 통찰 — 같은 영역, 세 철학

1. **검색 vs 압축 vs 거버넌스.** GBrain은 "무엇을 아는가"를 풍부하게 꺼내는 데(하이브리드 RAG+합성+외부수집+24/7), claude-mem은 "세션에서 무슨 일이 있었나"를 자동 압축·회상하는 데, ditto는 "무엇이 무엇에 왜 묶였고 최신인가·확신·승인됐나"를 보장하는 데 최적이다. 세 시스템은 경쟁이 아니라 **다른 질문**에 답한다.

2. **캡처 철학이 보안·신뢰 표면을 결정한다.** claude-mem의 자동·전수 캡처는 강력하지만(에이전트 결정 불요) 무인증 데이터플레인·평문 키·텔레메트리 기본 ON이라는 넓은 표면을 동반한다(§3.9, 코드 확인). ditto의 명시·승인 모델(secret 청크전 제거, propose→approve, 직접 provider 호출 안 함)은 캡처 편의를 희생하는 대신 그 표면을 구조적으로 좁힌다. GBrain은 fail-closed trust·source isolation·OAuth로 중간 지점을 택한다.

3. **"그래프"라는 단어의 세 의미.** GBrain의 그래프 = zero-LLM 정규식 도메인 엔티티 그래프(실재, 코드 확인). claude-mem의 "knowledge-graph" = 마케팅(노드/엣지 테이블 없음, RAG). ditto의 그래프 = 코드·결정 거버넌스 그래프(노드 11·엣지 13종, confidence 계급 강제) — 단 **코드↔결정 다리가 아직 미배선**(§4.11).

4. **벡터 RAG는 선택이지 필수가 아니다.** GBrain·claude-mem은 벡터를 1급으로 쓰고, ditto는 v0에서 의도적으로 기각하고 그래프 traversal+라벨 매칭으로 간다(§4.2, 설계 §3-6). ditto의 "완성형"조차 벡터 RAG를 깔지 않으므로(기존 vs-gbrain 보고서 §3), ditto는 "더 나은 RAG"가 아니라 "더 강한 거버넌스 그래프" 방향으로 자란다.

5. **확신도의 형식화가 ditto의 고유 자산.** 세 시스템 중 ditto만 EXTRACTED/INFERRED/AMBIGUOUS를 스키마 superRefine으로 강제하고, 모든 읽기에 2축 freshness envelope를 실어 소비자가 calibrate/abstain 하게 한다. GBrain·claude-mem은 엣지/관찰을 사실로 적재한다.

---

## 7. DITTO 관점 — 차용할 메커니즘 / 반면교사

**ditto가 차용을 검토할 만한 것** (단, ditto는 벡터를 안 깔고 자문 모델이라는 제약 하에):
- **GBrain contextual retrieval**(청크에 LLM synopsis 부착) → ditto는 임베딩 대신 "synopsis를 라벨/식별자 인덱스에" 적용하는 변형. **dream cycle류 페이즈 오케스트레이션** → ditto의 수동 scan/build/project/audit를 의미순서 페이즈로(단 24/7 데몬 아닌 작업 경계 트리거). **자가배선 즉시성**(매 쓰기에 엣지 추출) → 쓰기 후크로 당겨 freshness 격차↓.
- **claude-mem 3계층 점진적 공개**(search→timeline→detail funnel) → 회상 토큰 예산 강제. **워커-down no-op 강등**(호스트 세션 안 막음) → ditto의 fail-open과 같은 철학(이미 보유, §4.10). **`uvx` 외부 MCP로 무거운 의존성 격리** → ADR-0018 "도구 부재가 의도를 막지 못한다"의 한 구현형.

**반면교사**:
- claude-mem의 무인증 데이터플레인·평문 키 반환·SECURITY 문구 모순은 "자동·전수 캡처"가 보안/프라이버시 표면을 얼마나 넓히는지 보여준다. ditto의 명시·승인·secret-제거 모델이 이 표면을 좁히는 근거다.
- GBrain·claude-mem 모두 핵심 효과 수치가 **자가보고/벤더 주장**(제3자 미감사)이다. ditto의 measure-before-expand(확장 전 hit율 계측)는 이 함정을 피하려는 설계 선택과 정합한다.

---

## 8. 부록

### 8.1 근거 출처 위치 (1차)
- GBrain: `operations.ts`(scope 97), `search/hybrid.ts`(RRF_K=60, BOOST=2.0), `link-extraction.ts`(:688), `cycle.ts`, `minions/supervisor.ts`, `ai/gateway.ts` — 상세는 원본 `gbrain-code-level-research.md` 부록.
- claude-mem: `SettingsRoutes.ts:48-53`(평문키), `common.ts:18-20`(텔레메트리), `ChromaMcpManager.ts:241-247`, `mcp-server.ts:433-457`(3계층) — 상세는 원본 `claude-mem-research-ko.md` §10.
- ditto memory: `memory-graph-ir.ts`(노드/엣지/밴드), `memory-project.ts`(:101 RATIONALE_FOR, 쓰기·freshness), `memory-ir.ts`(흡수), `memory-build.ts`(host 위임), `memory-query.ts`(BFS), `memory-warmstart.ts`(push·fail-open), `memory-flag.ts`(되돌림). ADR-0013/0015/0020, 설계 `memory-graph-plugin-design.md`, 스펙 `memory-librarian.md`.

### 8.2 미해결·미검증
- **GBrain/claude-mem 정밀 라인 번호의 현 시점 유효성**: 재clone 안 함(§0). 필요 시 재검증 가능.
- **GBrain 실제 기본 임베딩·리랭커**, BrainBench 독립 재현성 — 원본 §14 미해결.
- **claude-mem "~10x 토큰 절약" 실측** — 벤더 주장, 미검증.
- **ditto warm-start hit율·actionability** — 미측정(ADR-0013 ac-10). impact→RELATED_TO 설계↔코드 불일치 — ADR 명시 기록 미발견.

### 8.3 정직성 메모
이 문서의 ditto memory 사실은 이번 세션 코드 직접 확인. GBrain·claude-mem 사실은 dated clone 기반 원본 보고서를 충실히 옮긴 것으로, 이번 세션 재clone 재검증은 하지 않았다(§0 비대칭 표). 근거 없는 가정·미래상상은 배제했고, `[추론]`/`[미확인]`/`[자가보고]`로 불확실성을 명시했다.
