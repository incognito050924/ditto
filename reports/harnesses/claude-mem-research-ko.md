---
title: "claude-mem 연구 보고서: Claude Code용 영속 메모리 압축 시스템"
kind: research
last_updated: 2026-06-18 KST
scope: "thedotmack/claude-mem v13.6.2 — 목적·적용·위험·기술스택·기반개념·메커니즘·확장가능성"
evidence_level: "공개 저장소 코드 정적 분석(file:line) + 다출처 웹 리서치(2차 자료, 일부 403로 검색 스니펫 의존)"
analyzed_commit: "aafbb3a21ae88f97562ffd3d6cd5a523347e6549 (v13.6.2, 2026-06-17)"
local_clone: "/tmp/claude-mem (git clone --depth 1)"
---

# claude-mem 연구 보고서

## 0. 초록

`claude-mem`(저자: Alex Newman / @thedotmack)은 **Claude Code의 "세션 간 기억상실"을 해결하려는 영속 메모리 시스템**이다. 핵심 아이디어는 단순하다: 코딩 세션에서 일어나는 일을 별도의 "관찰자(observer)" LLM이 실시간으로 지켜보며 구조화된 **관찰(observation)** 로 압축해 로컬 DB에 적재하고, 다음 세션이 시작될 때 관련 기억을 자동으로 컨텍스트에 다시 주입한다. Claude Code의 **lifecycle hook**과 **MCP(Model Context Protocol)** 표면을 둘 다 활용하는 것이 특징이다.

이 보고서의 결론을 먼저 요약하면 다음과 같다.

1. **목적은 "컨텍스트 영속성"이지만, 구현은 단순 로그 저장이 아니라 LLM-as-observer 압축 파이프라인이다.** 원시 트랜스크립트를 그대로 저장하지 않고, 별도 Claude Agent SDK 세션이 작업을 관찰해 타입이 부여된 관찰로 증류한다(`src/sdk/prompts.ts`, `plugin/modes/code.json`).
2. **검색은 "FTS5 키워드 + Chroma 벡터" 하이브리드**다. 단, Chroma는 npm 의존성이 아니라 `uvx`로 띄우는 **외부 Python MCP 서브프로세스**(`chroma-mcp==0.2.6`)라서 `package.json`에는 보이지 않는다. 도구가 없으면 키워드 검색으로 우아하게 강등된다.
3. **토큰 절약의 핵심은 "3계층 점진적 공개(progressive disclosure)"** — `search`(인덱스) → `timeline`(주변 맥락) → `get_observations`(전체 상세)로, 필터링 후에만 본문을 가져온다.
4. **위험은 실재하며 일부는 현재 버전에도 남아 있다.** 로컬 워커 API 전체가 **무인증**이고, `GET /api/settings`가 provider API 키를 **평문으로** 반환하며(`SettingsRoutes.ts:48-53`), SECURITY.md의 "텔레메트리 수집 안 함" 문구는 코드와 **모순**된다(텔레메트리는 기본 ON·opt-out, PostHog 키 내장).
5. **이미 코딩 외 용도로 확장되어 있다.** `plugin/modes/`에는 Solana 밈코인 트레이딩(`meme-tokens.json`), 법학 시험 대비(`law-study.json`), 이메일 엔터티/관계 추출(`email-investigation.json`, `ragtime/`)용 모드가 들어 있어, 이 시스템이 본질적으로 **도메인-범용 "관찰→압축→검색" 엔진**임을 저자 스스로 증명한다.

> **DITTO 관점 시사점**: claude-mem은 DITTO 메모리 서브시스템(ADR-0013)이 푸는 문제 — "에이전트 작업을 영속 지식으로 전환" — 와 같은 영역에 있다. 다만 설계 철학이 다르다. claude-mem은 **자동·암묵·LLM 압축**(에이전트가 결정하지 않아도 전부 캡처)이고, DITTO/ADR 모델은 **명시적·승인 기반 결정 기록**이다. §7과 §9에서 이 대비를 다룬다.

## 1. 조사 방법과 한계

- 저장소를 `--depth 1`로 `/tmp/claude-mem`에 클론하고 기준 커밋을 `aafbb3a2`(v13.6.2)로 확정했다. 이하 모든 `path:line` 근거는 이 커밋 기준이다.
- 코드 레벨 분석은 4개 영역으로 분할해 서브에이전트에 위임했다: (a) 훅·컨텍스트 주입, (b) 저장·검색·데이터모델, (c) 워커·서버·MCP·압축, (d) 설치·텔레메트리·보안. 각 결론은 직접 읽은 `path:line`로 뒷받침된다.
- 외부 평판/이론적 배경/위험 이력은 별도 웹 리서치로 수집했다. **한계**: github.com·npm·docs.claude-mem.ai·HN 등이 페처에 HTTP 403을 반환해 일부 2차 자료는 검색 스니펫에 의존한다. 별점 등 일부 수치는 출처/시점마다 달라 **단정하지 않는다**(§4-2).
- 동작 테스트나 실제 설치/LLM 호출은 하지 않았다. 런타임 수치(타임아웃, 포트 공식 등)는 코드 상수에서 직접 인용했다.

## 2. 프로젝트의 목적

`package.json`의 한 줄 정의: *"Memory compression system for Claude Code - persist context across sessions"*. 저장소 설명은 *"Captures everything your agent does during sessions, compresses it with AI, and injects relevant context back into future sessions"* 다.

해결하려는 통증은 명확하다. LLM은 세션 간 **무상태(stateless)** 이고, 세션 내에서도 입력이 길어질수록 품질이 떨어진다(§5 context rot). Claude Code를 끄거나 `/compact`가 일어나면 그동안 쌓은 "이 프로젝트의 결정·버그·함정"이 증발한다. claude-mem은 이 휘발성 작업기억을 **외부 영속 저장소로 빼내고**, 필요할 때만 일부를 되살려 컨텍스트 예산을 아끼는 것을 목표로 한다.

중요한 구분: 이것은 Claude Code의 정적 `CLAUDE.md`(사람이 관리하는 규칙/선호, 매 세션 통째 로드)나 Anthropic 공식 Memory tool(모델이 스스로 파일을 CRUD)과 **상호보완**이지 대체가 아니다. claude-mem이 채우는 칸은 **"세션 히스토리의 자동 캡처 + 검색형 회상"** 이다.

## 3. 아키텍처와 동작 메커니즘 (코드 레벨)

전체 데이터 흐름은 다음과 같다:

```
[사용자가 Claude Code에서 작업]
   │ PostToolUse 훅(도구 사용마다)
   ▼
[훅 = 얇은 bash→node 셸] ──HTTP(loopback)──> [백그라운드 워커 데몬]
                                                  │ 관찰 이벤트 버퍼링
                                                  ▼
                                    [관찰자 Claude (Agent SDK query())]
                                                  │ <observation> XML 방출
                                                  ▼
                            [파서 → SQLite(observations) + Chroma(임베딩)]
   ┌──────────────────────────────────────────────┘
   │ 다음 세션 SessionStart 훅
   ▼
[워커가 컨텍스트 조립] ──stdout(additionalContext JSON)──> [새 세션에 주입]
```

### 3-1. 훅 계층 — 얇은 셸, 무거운 일은 워커가

훅은 `node bun-runner.js worker-service.cjs hook claude-code <event>` 형태의 단명(short-lived) 셸이다. 등록된 lifecycle 훅(`plugin/hooks/hooks.json`):

| 이벤트 | 핸들러 | 역할 |
|---|---|---|
| `SessionStart`(startup\|clear\|compact) | `start` + `context` | 데몬 부팅 후 과거 기억 주입 |
| `UserPromptSubmit` | `session-init` | 세션 행 생성, 선택적 의미검색 주입(기본 OFF) |
| `PostToolUse`(*) | `observation` | 도구 사용마다 관찰 이벤트 적재 |
| `PreToolUse`(Read) | `file-context` | 읽으려는 파일에 대한 과거 관찰 주입 |
| `Stop` | `summarize` | 세션 요약/압축 트리거 |

설계상 주목점(모두 코드 근거):
- **주입 메커니즘**: Claude Code의 `hookSpecificOutput.additionalContext`를 stdout에 JSON 한 줄로 출력한다(`src/cli/handlers/context.ts:80-83`, `src/shared/hook-io.ts:117-124`). 내용은 워커가 SQLite를 조회해 헤더/타임라인/요약 섹션으로 조립한다(`src/services/context/ContextBuilder.ts:162-216`).
- **무인증 loopback HTTP**로 훅↔워커 통신(IPC/소켓 아님). URL은 `http://host:port`(`src/shared/worker-utils.ts:169-171`).
- **우아한 강등**: 워커가 죽어 있으면 `WorkerFallback` 센티넬을 반환하고 각 핸들러는 빈 `additionalContext`로 no-op 처리 — 메모리 주입은 조용히 누락되지만 **세션은 막지 않는다**(`worker-utils.ts:642-652`).
- **Windows/터미널 규율**: 일시적 워커 오류는 exit 0(윈도우 터미널 탭 누적 방지), 진짜 실패만 exit 2. 연속 N회(기본 3) 실패해야 차단 오류를 모델에 노출(`hook-command.ts:121-131`, `:580-616`). 타임아웃은 Windows에서 ×1.5(`hook-constants.ts`).
- **주의(위험)**: **`PreCompact`·`SessionEnd` 훅은 등록돼 있지 않다.** 세션 마무리는 전적으로 `Stop`→summarize에 의존하므로, 크래시/강제종료로 `Stop`이 안 불리면 그 세션은 요약되지 않는다. 또한 압축 입력은 워커의 **인메모리 대화 히스토리**이지 트랜스크립트 재생이 아니라서, 워커가 세션 중간에 재시작되면 복구 표면이 얇다.

### 3-2. 압축 파이프라인 — "관찰자 LLM" 패턴

핵심 통찰은 정규식 추출이 아니라 **별도의 LLM이 1차 세션을 관찰한다**는 점이다. 모드 프롬프트가 이를 명시한다(`plugin/modes/code.json`):

> *"You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS. ... You do not have access to tools. ... Create observations from what you observe - no investigation needed."*

- 워커는 세션마다 `@anthropic-ai/claude-agent-sdk`의 `query()`로 **자식 Claude 프로세스**를 띄운다(`src/services/worker/ClaudeProvider.ts:232-246`). 비동기 제너레이터가 init→관찰별 프롬프트→종료 시 요약 프롬프트를 순차 yield한다(`:459-554`).
- 출력은 `<observation>` XML 블록(`<type>/<title>/<facts>/<narrative>/<concepts>/<files_read>/<files_modified>`)으로, 정규식 파싱 후(`src/sdk/parser.ts:87-90`) SQLite에 저장된다(`src/services/worker/agents/ResponseProcessor.ts:174-176`).
- 프롬프트는 **모드 템플릿**으로 조립된다(`src/sdk/prompts.ts:24-79`). 모드 = `plugin/modes/*.json`(관찰 타입·개념·프롬프트 정의). 기본 모드 `code`는 bugfix/feature/refactor/change/discovery/decision/security_alert/security_note 8종 관찰 타입을 정의한다.
- 모델은 요청 시점에 tier alias(`$TIER:fast|smart`)로 해석되며, Gemini·OpenRouter provider 대안이 있다(`GeminiProvider.ts`, `OpenRouterProvider.ts`).

### 3-3. 저장·데이터 모델 — SQLite 정본 + Chroma 인덱스

- **정본(로컬 기본 경로)**: `~/.claude-mem/claude-mem.db` (Bun 내장 `bun:sqlite`, WAL). 주요 테이블(`src/services/sqlite/schema.sql`): `sdk_sessions`, `observations`(중심 단위, `UNIQUE(memory_session_id, content_hash)`로 디둡), `session_summaries`(request/investigated/learned/completed/next_steps 형태), `user_prompts`, `pending_messages`(durable 큐), `observation_feedback`(tier 라우팅용 사용 신호).
- **"knowledge-graph"는 마케팅**: 관계형 노드/엣지 테이블은 없다. `concepts`는 observations의 JSON 문자열 컬럼일 뿐이고, `src/services/worker/knowledge/`는 그래프 DB가 아니라 **코퍼스 기반 RAG**(전체 코퍼스를 Agent SDK 세션에 priming 후 질의)다.
- **Chroma는 존재하되 외부 Python 프로세스**: `uvx --python ... chroma-mcp==0.2.6 ... --client-type persistent`로 스폰(`src/services/sync/ChromaMcpManager.ts:241-247`). 임베딩은 chroma-mcp 내부의 **all-MiniLM-L6-v2(384차원, ONNX)** 로 생성. 데이터는 `~/.claude-mem/chroma`. 도구 부재/연결 실패 시 SQLite FTS5/LIKE로 폴백(`SearchOrchestrator.ts:46-49,82-87`).
- **(서버-베타 한정)** Postgres 스택은 별도 멀티테넌트 제품 표면(teams/api_keys/audit_log)이며 `CLAUDE_MEM_RUNTIME=server-beta`에서만 활성. 여기 `embedding` JSONB 컬럼은 정의돼 있으나 **실제 벡터로 쓰이지 않고**, 검색은 순수 `tsvector` 풀텍스트다(`src/storage/postgres/observations.ts:164-165`).

### 3-4. 검색 — 하이브리드 + 3계층 점진적 공개

- **전략 패턴**(`src/services/worker/search/SearchOrchestrator.ts`): 쿼리 없음→SQLite 필터, 쿼리+Chroma 가용→Chroma 시맨틱, 그 외→폴백. Chroma는 랭커/인덱스 역할이고, 매칭된 doc-id를 SQLite id로 역매핑해 **본문은 SQLite에서 하이드레이트**한다(시스템 정본은 항상 SQLite).
- **FTS5**: `observations_fts`/`session_summaries_fts` contentless 가상 테이블을 런타임에 생성하고 트리거로 동기화, BM25 `rank` 정렬(`SessionSearch.ts:73-149,234`).
- **3계층 MCP 워크플로**(`src/servers/mcp-server.ts:433-457`): `search`(ID 인덱스, ~50-100토큰/건) → `timeline`(앵커 주변 맥락) → `get_observations`(ID 배치로 전체 상세). 저자가 주장하는 "~10x 토큰 절약"의 근거 메커니즘이다. (단, 이 수치는 **벤더 자체 주장**이며 독립 벤치마크 아님 — §4-2.)

### 3-5. MCP 서버 — stdio, 약 21개 도구

- 실제 가동 서버는 `src/servers/mcp-server.ts`, **stdio 트랜스포트**, `@modelcontextprotocol/sdk` 기반. 입력 검증은 zod가 아니라 **JSON Schema**.
- 도구군: 3계층 검색(`search`/`timeline`/`get_observations`), observation CRUD(서버-베타 백엔드), **tree-sitter 코드 도구**(`smart_search`/`smart_unfold`/`smart_outline`, 로컬 FS), 지식 코퍼스(`build_corpus`/`prime_corpus`/`query_corpus` 등).

### 3-6. 워커·수퍼바이저 — 고아 프로세스 이력의 흔적

과거 "고아 프로세스로 토큰 폭주"(이슈 #1090) 이력이 있어 현재 코드에는 방어가 두껍다:
- 기본 바인드 **`127.0.0.1`**, 포트는 UID 파생 `37700 + (uid % 100)`(명목값 37777; `SettingsDefaultsManager.ts:91-92`).
- 기본 큐 엔진 `sqlite`(BullMQ/Redis는 server-beta 옵션, 로컬 기본 설치엔 불필요; `SettingsDefaultsManager.ts:155`).
- SDK 프로세스 동시성 하드캡 10(기본 2), 슬롯 대기, 세션당 중복 프로세스 선킬(`process-registry.ts:489-561`).
- 종료 캐스케이드(SIGTERM→5s→SIGKILL 프로세스그룹→1s), **PID 재사용 탐지**(Linux `/proc/<pid>/stat` 시작토큰 비교), owner-guarded PID 파일 제거(`src/supervisor/*`).
- **env-sanitizer**: 서브프로세스 스폰 전 `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/프록시 변수 등을 제거(`src/shared/EnvManager.ts:23-48`) — 자격증명/프록시 누출 방지.

## 4. 어디에 적용 가능하고 어떤 효과를 얻나

### 4-1. 적용처와 효과

- **장기·다세션 프로젝트**: 가장 분명한 가치. "이 코드베이스가 어떻게 진화했나, 어떤 결정을 왜 했나, 어떤 함정을 밟았나"를 수초 내 회상. 디버깅 히스토리·아키텍처 결정 복원에 강하다(2차 자료 다수, 검색 스니펫 기준 medium-high).
- **다중 호스트 연속성**: 어댑터가 Claude Code·Codex·Gemini CLI(이상 풀), OpenCode(풀 캡처)까지 실하게 구현돼 있어, 한 프로젝트를 호스트를 바꿔가며 작업해도 기억이 이어질 수 있다("portable working memory"). Cursor·Windsurf·OpenClaw는 부분, **Copilot은 사실상 스텁**(MCP만, 캡처 불가; `McpIntegrations.ts:110`).
- **토큰 비용 최적화**: 3계층 공개로 "전체 트랜스크립트 덤프" 대비 회상 비용을 줄이는 것이 설계 의도. 효과 크기는 검증되지 않음(§4-2).

### 4-2. 효과 주장에 대한 경고 (하이프 vs 사실)

- **검증된 사실**: 저장소 설명/라이선스(Apache-2.0)/기술 토픽, 코드상의 하이브리드 검색·3계층·우아한 강등 메커니즘.
- **벤더 주장(독립 검증 안 됨)**: "~10x 토큰 절약", "63x 압축", "best-in-class". 이는 측정 결과가 아니라 **주장**으로 다뤄야 한다.
- **별점 등 인기 지표**: 출처/시점마다 46K~83K로 편차가 커서 본 보고서는 정확한 수치를 단정하지 않는다("수만 stars 규모, 빠르게 성장"으로만). GitHub API 직접 확인은 페처 403으로 실패.

## 5. 기반 개념·이론·사상

claude-mem의 각 부품은 잘 정립된 이론에 대응한다.

1. **Context rot / Lost-in-the-middle**: 입력이 길수록(윈도 한도 전부터) 모델 신뢰도가 떨어지고, 중간 위치 정보의 회상이 U자형으로 약해진다. → "전부 우겨넣기" 대신 외부 메모리가 필요한 이유. (Chroma context-rot 연구; Liu et al.)
2. **에이전트 메모리 아키텍처(작업기억 vs 장기기억; episodic/semantic/procedural)**: claude-mem의 "관찰"은 **episodic**(특정 과거 사건), `concepts`/코퍼스는 semantic에 가깝다. 컨텍스트 윈도=작업기억, 외부 DB=장기기억. (IBM/MongoDB/Redis/mem0 정리와 일치.)
3. **RAG·임베딩·시맨틱 검색**: 임베딩(의미 유사도=기하 근접) + ANN으로 "관련 기억만" 회상 → context rot 완화의 직접 수단.
4. **Compaction & structured note-taking(agentic memory)**: Anthropic의 "원하는 결과 확률을 최대화하는 최소 고신호 토큰 집합" 원칙. 컨텍스트를 요약·외부화하고 필요 시 회수 — claude-mem의 모델 그 자체.
5. **Progressive disclosure**: 항상 로드되는 건 메타/요약, 상세는 필요 시. claude-mem의 `search→timeline→get_observations` funnel이 이 원리의 구현.
6. **Claude Code hooks + MCP**: SessionStart(주입)·Stop(캡처) 같은 결정론적 lifecycle 이벤트로 메모리 쓰기/복원 트리거를 확보하고, MCP 서버로 세션 중 능동 질의를 노출. (공식 문서 기준 high.)
7. **로컬-퍼스트 벡터 스토어(Chroma) + ONNX 임베딩**: 데이터가 사용자 머신을 떠나지 않는 프라이버시 모델.

## 6. 기술 스택

- **언어/런타임**: TypeScript, Node ≥20 / **Bun**(워커·바이너리 빌드), 일부 Python(`uvx`로 chroma-mcp).
- **AI**: `@anthropic-ai/claude-agent-sdk`(관찰자 LLM), `@modelcontextprotocol/sdk`(MCP), 임베딩 all-MiniLM-L6-v2(ONNX).
- **저장/검색**: SQLite(`bun:sqlite`, FTS5/BM25) + Chroma(외부 chroma-mcp) / (server-beta) Postgres(`pg`, tsvector) + Redis·BullMQ(옵션).
- **서버/UI**: Express 5, React 19 웹뷰어(localhost), SSE 스트림, better-auth(server-beta 한정).
- **코드 분석**: 다수 **tree-sitter** 문법(20+ 언어) — `smart_*` 코드 도구용.
- **운영/기타**: zod, handlebars, picocolors, **posthog-node**(텔레메트리), shell-quote, dompurify, glob.
- **빌드/배포**: esbuild, np, Claude Code 플러그인 마켓플레이스 + npm + `curl|bash`(OpenClaw 게이트웨이). 30+ 언어 README 자동 번역 파이프라인.

## 7. 위험

### 7-1. 보안 (코드 확인)

- **로컬 워커 데이터플레인 전체 무인증**: `/api/settings`, `/api/observations`, `/api/sessions/*`(AI 지출 유발·프롬프트 인젝션 가능), `/api/import` 등이 인증 없이 동작. 방어는 오직 loopback 바인드 + CORS(브라우저 한정). 관리 엔드포인트만 `requireLocalhost` IP 체크.
- **`GET /api/settings` 평문 키 반환 — 현재도 미수정**: `res.json(settings)`에 마스킹 없음(`SettingsRoutes.ts:48-53`). Gemini/OpenRouter 키가 settings.json에 저장되므로 워커에 도달 가능한 모든 클라이언트에 평문 노출.
- **`0.0.0.0` 바인드 허용**: 기본은 localhost지만 `CLAUDE_MEM_WORKER_HOST=0.0.0.0` 허용(`SettingsRoutes.ts:242`). 게다가 그 설정을 **무인증 `POST /api/settings`로 변경 가능** → 무인증 표면 전체가 네트워크 노출될 수 있다.
- **자격증명 권한 비대칭**: `.env`의 Anthropic 키는 `0600`(chmod 명시)이나, settings.json의 Gemini/OpenRouter 키는 chmod 없이 기록(기본 umask, 통상 `0644` = 사용자 외 읽기 가능; `install.ts:771`).
- **외부 보안 감사(이슈 #1251, v10.5.2, 2026-02)** 는 HIGH 위험·4 critical(경로순회, 무인증 30+ 엔드포인트, 0.0.0.0, 평문 키)로 평가했다. 현재 v13.6.2에서 **경로순회는 완화**(파일 읽기 MCP 도구를 노출하지 않음), 무인증 데이터플레인·평문 키는 **여전히 잔존**.

### 7-2. 프라이버시

- **텔레메트리 기본 ON(opt-out) + 내장 PostHog 키**(`src/services/telemetry/common.ts:18-20`). non-TTY/CI 설치는 동의 프롬프트를 못 보고 ON 유지. 전송 데이터는 약 120개 화이트리스트 enum/카운터로 스크럽되어(경로·프롬프트·쿼리·프로젝트명 제거, 200자 절단) **화이트리스트 범위 내에선 익명적**. 단 `disableGeoip:false`로 IP 기반 국가/지역 추정 수행.
- **모순**: `SECURITY.md:157`은 "Claude-mem does not collect telemetry"라고 적었으나 v13.6.2 코드와 **불일치**. 익명화 여부와 별개로 문구 자체가 부정확.
- `<private>` 태그로 캡처 제외는 가능하나, 그 외 모든 작업이 디폴트로 캡처·압축되어 로컬 DB에 영속된다.

### 7-3. 안정성·운영

- 과거: **고아 Claude CLI 프로세스 누적으로 토큰/비용 폭주**(이슈 #1090, ~$183/day 보고, 현재 Closed), **CLAUDE.md "read 이후 수정" 가드와 충돌**해 쓰기 실패 루프(이슈 #859), Windows/Git Bash에서 키입력당 수초 지연·수십 자식 프로세스(써드파티 gist), 설치/제거 취약성. 다수는 버전별로 수정되었으나, 훅 기반 다중 프로세스 설계의 구조적 부담은 남는다.
- **SessionEnd/PreCompact 미등록**(§3-1)으로 비정상 종료 세션 누락 가능.
- **로컬/서버-베타 두 summarize 파이프라인 공존**으로 드리프트 위험(`runtime-selector.ts`).

### 7-4. 거버넌스/신뢰 신호

- README 하단에 **"CMEM" 암호화폐 토큰**(Base 체인 컨트랙트 주소 명시)을 저자가 공식 지지. 또한 `plugin/modes/meme-tokens.json`(Solana 밈코인 트레이딩 모드)·`ragtime/`의 "epstein-mode" 이메일 코퍼스 예시 등은, 순수 개발자 도구로 보기엔 **방향성 분산**과 잠재적 신뢰/거버넌스 리스크 신호로 읽힐 수 있다(가치판단이 아닌 사실 적시).

## 8. 잠재적·알려지지 않은 다른 활용

claude-mem의 일반형은 **"세션 트랜스크립트 → LLM이 타입 부여한 압축 관찰 → 검색 가능한 로컬 스토어"** 다. 이 일반형은 코딩에 국한되지 않는다 — **저자가 이미 증명**하고 있다:

- **(이미 구현됨) 도메인 모드 교체**: `meme-tokens`(밈코인 펌프/덤프 신호), `law-study`(판례 holding·쟁점 패턴·교수 프레임워크), `email-investigation`/`ragtime`(이메일 엔터티·관계·타임라인 추출). 즉 관찰 타입 JSON만 갈아끼우면 임의 도메인 관찰 엔진이 된다.

추가로 **추론(문서화되지 않음, 추정으로 표시)**:

- **결정/ADR 마이닝**: `decision` 관찰을 ADR·체인지로그 생성기로 연결 — 세션 후 증발하던 근거를 영속화. (DITTO ADR 모델과 직접 맞닿음.)
- **온보딩·팀 지식 이전**: 공유 압축 메모리를 "이 코드베이스가 어떻게 진화했나" 검색형 로그로.
- **인시던트/포스트모템 재구성**: 디버깅 세션의 압축 관찰을 재생해 시도·근거 복원.
- **에이전트 자기 텔레메트리**: 타입별 관찰을 데이터셋 삼아 "에이전트가 어디서 헛수고하나/같은 사실을 반복 재발견하나" 측정.
- **드리프트 탐지**: 과거 압축 결정 vs 현재 코드 비교로 의도-구현 괴리 표시(DITTO 코드↔SoT 정합성 축과 인접).
- **스펙/테스트 시드**: `discovery`/`decision` 관찰을 회귀 테스트·스펙 초안 입력으로.

## 9. DITTO 관점의 종합 시사점

| 축 | claude-mem | DITTO(ADR-0013 등) |
|---|---|---|
| 캡처 방식 | **자동·암묵·전수** 캡처(에이전트 결정 불요) | **명시·승인 기반** 결정 기록(supersedes 승인) |
| 단위 | LLM이 압축한 episodic 관찰 | ADR/메모리 이벤트(되돌리기 어려운 결정의 영속 기록) |
| 신뢰 모델 | 압축 정확도는 관찰자 LLM에 위임(증거 약함) | 추론 시점 일관 적용·충돌 드러내기(ADR-0020) |
| 검색 | FTS5+Chroma 하이브리드, 3계층 공개 | 메모리 projection/query(`ditto memory query`) |
| 강등 | 도구 부재 시 우아한 강등(키워드 폴백) | 선택적 외부도구 우아한 강등 불변식(ADR-0018) |

claude-mem에서 DITTO가 참고할 만한 **구체 메커니즘**: (1) 3계층 점진적 공개로 회상 토큰 예산을 강제하는 funnel, (2) 워커-down 시 no-op 강등으로 호스트 세션을 막지 않는 훅 규율, (3) `uvx` 외부 MCP로 무거운 의존성(벡터DB)을 호스트 밖에 격리하는 패턴(ADR-0018의 "도구 부재가 의도를 막지 못한다"의 한 구현형). 반대로 **반면교사**: 무인증 데이터플레인·평문 키 반환·SECURITY 문구 모순은 "자동·전수 캡처"가 보안/프라이버시 표면을 얼마나 넓히는지 보여준다 — DITTO의 명시·승인 모델이 이 표면을 구조적으로 좁히는 이유.

## 10. 검증 메모

- **직접 코드 근거(file:line)**: §3 전체, §6 기술스택, §7-1/7-2 보안·프라이버시 핵심 주장은 클론 저장소(`aafbb3a2`)를 정적으로 읽어 확인했다(예: `SettingsRoutes.ts:48-53`, `common.ts:18-20`, `SECURITY.md:157`, `ChromaMcpManager.ts:241-247`, `SettingsDefaultsManager.ts:91-92`).
- **2차 자료(검색 스니펫 의존, 일부 403)**: §4-2 인기/효과 주장, §7-3 일부 이슈 이력 수치(#1090의 $183/day 등), 외부 감사(#1251). 단정 대신 출처·신뢰도를 병기했다.
- **추정 표시**: §8 후반 목록은 코드/문서로 확인되지 않은 추론임을 명시했다.
- **미검증**: 동작 테스트·실제 설치·LLM 호출은 하지 않았다. 별점 정확 수치, PostHog가 "IP를 ingest 후 폐기"한다는 주석의 사실 여부는 코드만으로 검증 불가.
