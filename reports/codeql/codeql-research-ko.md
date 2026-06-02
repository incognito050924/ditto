---
title: "CodeQL 통합 연구 보고서 — 플랫폼 기초 + 코딩 에이전트 통합"
kind: research
last_updated: 2026-06-02 KST
scope: "github/codeql, CodeQL CLI, code scanning, query/model packs, MCP/CLI 통합, LLM-friendly 지식 그래프 전달"
evidence_level: "공식 문서 + 공개 GitHub 저장소/API 스냅샷 + 다중 소스 적대적 검증(deep-research)"
merged_from:
  - "codeql-research-ko.md (2026-06-01, 플랫폼 기초 조사)"
  - "2026-06-02-codeql-coding-agents.md (deep-research, 에이전트 통합 패턴)"
note: "BPMN/Camunda 활용 절은 본 통합 시 의도적으로 제외함"
---

# CodeQL 통합 연구 보고서 — 플랫폼 기초 + 코딩 에이전트 통합

> **검증 표기 규칙**(메모리: harness-verify-marker-convention)
> - 1차 소스로 확인된 사실은 그대로 기술한다.
> - 추론·미실증 항목은 `[VERIFY]` 토큰으로 표시한다(`grep '\[VERIFY\]'`로 조회).
> - 적대적 검증(deep-research)을 통과한 주장은 `[✓검증]`과 투표 결과를 병기한다.
> - 본 보고서 작성 중 공식 문서로 재확인한 항목은 `[✓2026-06-02 재확인]`으로 표시한다.

---

## 0. 이 문서의 구성

두 개의 선행 보고서를 하나로 통합했다.

- **Part A — CodeQL 플랫폼 기초**: CodeQL이 무엇이고 어떻게 동작하는가, 저장소 구조, 분석 범위, 커스텀 룰. (2026-06-01 조사, 본 통합 시 버전·상태 재검증)
- **Part B — 코딩 에이전트 통합**: CodeQL을 코딩 에이전트 워크플로우에 통합하는 검증된 패턴, MCP/CLI 통합, LLM-friendly 지식 그래프 전달, 실제 사례와 한계. (deep-research, 다중 소스 적대적 검증)
- **Part C — 창의적 활용 + 실증 여부 주석**: 플랫폼 기능 위에 올린 활용 아이디어를, Part B에서 확인된 실제 선례와 대조해 "실증/추론/투기"로 등급화.

핵심 한 줄 요약:

> CodeQL의 본질은 "코드 검색기"가 아니라 **코드 의미 그래프에 대한 재사용 가능한 질의 시스템**이다. 코딩 에이전트 관점에서 증거가 가장 탄탄한 통합 형태는 **CodeQL을 결정론적 사실(데이터플로우 경로) 생성기로 쓰고, LLM은 그 위에서 판단(fuzzy reasoning)만 하며, 검증 가능한 작업은 MCP 서버에 남기는** 구조다.

---

## 1. 조사 기준과 한계

| 항목 | 값 |
|---|---|
| 통합 기준일 | 2026-06-02 KST |
| github/codeql 조사 기준 HEAD | `a16f1c555cea339ef5c8b4c7c9285b6e578c396c` (2026-05-30 pushed) |
| Part A 검증 | 공식 문서 확인, GitHub API 조회, 저장소 구조 확인 |
| Part B 검증 | deep-research — 6개 각도 · 소스 20개 · 주장 99개 추출 → 25개 적대적 검증(24 확정 / 1 기각) |
| 라이선스 | 저장소 코드 MIT, CodeQL CLI/engine은 별도 라이선스 |

공통 한계:

- CodeQL 엔진 내부 구현은 공개 저장소 범위 밖이다. 본 문서는 공식 문서, 공개 저장소 구조, pack 규약, 공개 1차 소스에 기반한다.
- **이 저장소에 CodeQL을 실제 설치해 로컬 분석을 실행하지는 않았다.** 검증은 문서 확인·API 조회·산출물 확인·다중 소스 교차검증으로 제한된다.
- Part B의 통합 도구(MCP 서버, mrva, graphify, QLCoder, Vulnhalla 등)는 대부분 2025말~2026초 산출물로 변동이 빠르다. **착수 전 재확인 필수.**

---

# Part A — CodeQL 플랫폼 기초

## A-1. CodeQL은 어떤 라이브러리인가

CodeQL은 **코드를 데이터베이스로 추출하고, QL 질의 언어로 그 데이터베이스를 분석하는 정적 분석 플랫폼**이다. 링크된 `github/codeql` 저장소는 플랫폼 전체가 아니라, GitHub Advanced Security와 code scanning에 쓰이는 **표준 라이브러리·쿼리·테스트·언어별 팩**의 공개 저장소다. CLI와 엔진은 별도 저장소·별도 라이선스다.

네 가지 구성:

| 구성 요소 | 역할 |
|---|---|
| CodeQL CLI/engine | 데이터베이스 생성, 쿼리 컴파일/실행, 결과 해석, SARIF 출력 |
| extractor | 언어별 소스/빌드 정보를 CodeQL database로 추출 |
| QL language | database를 질의하는 선언형·객체지향 논리 질의 언어(의미론은 Datalog 계열) |
| standard libraries/queries | 언어별 AST/CFG/DFG 추상화, 보안/품질 쿼리, suite |

두 층을 구분해야 한다.

- **분석 플랫폼으로서 CodeQL**: CLI, engine, extractor, database, VS Code 확장, Actions integration 포함.
- **`github/codeql` 저장소로서 CodeQL**: 표준 query/library pack의 소스(`codeql/javascript-queries`, `codeql/java-all` 등). 코드는 MIT지만 CLI는 별도 조건(public repo 무료, private은 GitHub Code Security 라이선스).

## A-2. 어떻게 동작하는가

**핵심 3단계**: ① extractor가 소스+빌드 정보로 언어별 CodeQL database 생성(AST·DFG·CFG 포함) → ② `.ql` 쿼리 또는 suite/pack 실행 → ③ 결과를 SARIF, VS Code UI, code scanning alert, 원시 BQRS로 해석.

**빌드 모드 3종**:

| build mode | 의미 | 대표 사용 |
|---|---|---|
| `none` | 빌드 없이 소스에서 database 생성 | 해석 언어 전체, 추가로 C/C++·C#·Java·Rust |
| `autobuild` | 가장 가능성 높은 빌드 방법 자동 감지·실행 | C/C++·C#·Go·Java/Kotlin·Swift 등 |
| `manual` | 사용자가 명시한 빌드 명령 실행 | 복잡 mono-repo, custom build, 정확한 coverage |

> `[✓2026-06-02 재확인]` 공식 supported-languages 페이지는 GitHub Actions·JavaScript·Python·Ruby·TypeScript를 "컴파일러 불필요(Not applicable)"로 명시한다. C/C++·C#·Java·Rust의 build-mode `none` 지원은 code scanning 기능 차원의 별도 사실이다(두 진술 양립).

**쿼리 유형 4부류**:

| 유형 | 예 |
|---|---|
| 구조 쿼리 | 특정 API 호출/import/annotation 사용 찾기 |
| 제어 흐름 쿼리 | check 없이 dangerous operation에 도달하는 경로 |
| 데이터 흐름 쿼리 | user input이 sanitizer 없이 sink로 흐르는 경로 |
| 메트릭/진단 쿼리 | 복잡도, 사용 패턴, extractor 진단, custom inventory |

보안 분석의 핵심은 **data flow와 taint tracking**: source(오염 입력 시작점) → sink(위험 사용 지점), sanitizer/barrier(흐름 차단). path query는 source→sink 경로를 alert와 함께 보여준다.

> `[✓검증 2-1]` (deep-research) 공식 docs: 데이터플로우 그래프의 **노드 = 런타임 값을 운반하는 의미적 요소**(구문적 AST 아님), **엣지 = 값 전파**. 보안 쿼리는 "잠재적으로 악의적이거나 안전하지 않은 데이터의 행로"를 추적. 단 "이 그래프를 곧바로 KG로 변환 가능"이라는 추론 부분에서 1표 반대. (출처 [7])

**결과 해석 파이프라인**:

```bash
codeql database create codeql-dbs --source-root=src --db-cluster --language=java,python --command=./build
codeql database analyze codeql-dbs/java java-code-scanning.qls --format=sarif-latest --output=java.sarif
codeql github upload-results --sarif=java.sarif
```

쿼리 metadata가 결과 해석에 중요: code scanning alert로 보이려면 `@id`, `@kind`, severity, precision, tags 필요. `@kind`에는 단일 위치 `problem`, 경로 표시 `path-problem`, 진단 `diagnostic`, 메트릭 `metric` 등이 있다.

> **에이전트 통합 관점(Part B 연결)**: `path-problem` 쿼리가 내보내는 SARIF `codeFlow`→`threadFlow` 구조가 "source→sink를 LLM이 읽기 좋은 사실 단위"로 만드는 핵심 변환점이다. → B-3 참조.

## A-3. `github/codeql` 저장소 구조

조사 기준 HEAD의 top-level은 언어별 디렉터리 + 공통 모듈:

| 경로 | 역할 |
|---|---|
| `cpp` `csharp` `go` `java` `javascript` `python` `ruby` `rust` `swift` | 언어별 extractor 관련 파일, library/query pack, suite, tests |
| `actions` | GitHub Actions workflow/action metadata 분석 팩 |
| `shared` `unified` `config` | 공통 라이브러리, 설정, cross-pack 구성 |
| `ql` | "QL for QL" 실험적 분석 |
| `docs` `change-notes` | 저장소 내부 문서·변경 기록 |
| `codeql-workspace.yml` | 다중 pack 동시 개발 workspace 설정 |

언어별 일반 패턴:

| 하위 경로 | 의미 |
|---|---|
| `ql/lib` | library pack (예: `codeql/javascript-all`) |
| `ql/src` | query pack (예: `codeql/javascript-queries`) |
| `ql/src/Security/CWE-*` | CWE별 보안 쿼리 |
| `ql/src/codeql-suites` | `*-code-scanning.qls`, `*-security-extended.qls`, `*-security-and-quality.qls` |
| `extractor` | 언어별 extraction 구성/구현 |

CodeQL의 "룰"은 단순 JSON 설정이 아니라, 언어별 semantic library 위에 작성된 재사용 가능한 프로그램이다.

## A-4. 어디까지 분석 가능한가

### A-4.1 지원 언어 — `[✓2026-06-02 재확인]` 공식 supported-languages 페이지와 전 항목 일치

| 언어군 | 버전 |
|---|---|
| C/C++ | C89/99/11/17/23, C++98/03/11/14/17/20/23 |
| C# | C# up to 14, .NET 5-10 (+ VS up to 2019 / .NET up to 4.8) |
| Go | up to 1.26 |
| Java/Kotlin | Java 7-26, Kotlin 1.8.0-2.3.2 |
| JavaScript/TypeScript | ECMAScript 2022 이하, TypeScript 2.6-5.9 |
| Python | 2.7, 3.5-3.13 |
| Ruby | up to 3.3 |
| Rust | editions 2021, 2024 |
| Swift | 5.4-6.3 (host macOS 필요) |
| GitHub Actions | workflow YAML, action metadata YAML |

PHP, Scala 등 목록에 없는 언어는 **미지원**(공식 명시). "파일을 읽을 수 있나"와 "정확한 의미 분석을 지원하나"는 다르다.
참고: CodeQL 2.24.0 changelog(2026-01-29)가 Swift 6.2 / .NET 10 지원을 추가 — 버전 목록은 최신 상태로 유지되고 있음.

### A-4.2 지원 프레임워크/라이브러리

CodeQL은 언어뿐 아니라 주요 프레임워크 모델을 갖는다(데이터플로우의 source/sink 의미를 알기 위해 필수).
- JS/TS: Express, Fastify, Koa, React, Vue, Nest.js, Electron, axios, node, DB client
- Python: Django, FastAPI, Flask, Starlette, Tornado, requests/httpx, SQLAlchemy, Pydantic, PyYAML, DB driver
- Java/Kotlin: Spring MVC/JDBC, JPA, Hibernate, Jackson, MyBatis

`req.body`가 source이고 `db.query`가 sink라는 사실은 문법만으로 부족하고 프레임워크 API 의미를 알아야 한다.

### A-4.3 잘하는 질문 / 약한 질문

**잘함**: 입력 검증 없이 user data가 SQL/shell/path/template/SSRF/deserialization sink로 흐르는가; 암호·random·TLS·cookie·CORS·redirect API의 위험 사용; deprecated/금지 API; 위험 조합; Actions workflow의 injection/unsafe checkout/secrets exposure; call/import/inheritance/annotation 위치; 여러 저장소의 같은 취약 variant.

**약함**: 런타임 설정·DB 상태·네트워크 응답·feature flag 의존 동작; reflection/dynamic import/metaprogramming 다수; 소스 없는 binary dependency 내부; extractor가 모르는 custom framework 의미; build 재현 안 되는 compiled 프로젝트; 타입 정보 약하거나 generated code 누락; "좋은 설계인가" 같은 가치 판단.

정리: **"정확한 의미 그래프 위의 반복 가능한 질문"에 강하고, "실행해야 알 수 있는 사실"에 약하다.**

## A-5. 커스텀 룰 — 4단계

1. **단일 `.ql`** — metadata 붙여 작성. 개념 예시:
   ```ql
   /**
    * @name Direct eval call
    * @kind problem
    * @problem.severity warning
    * @id js/custom/direct-eval
    * @tags security
    */
   import javascript
   from CallExpr call
   where call.getCalleeName() = "eval"
   select call, "Avoid direct eval."
   ```
   `codeql test run` 또는 test fixture로 검증 필요(쿼리는 프로그램이라 오탐/미탐·성능 문제 발생).

2. **Query suite `.qls`** — 자주 함께 실행할 쿼리 묶음. built-in: `default`(정밀도 우선), `security-extended`(넓은 보안, 오탐↑), `security-and-quality`(+유지보수성).

3. **Query pack** — 재사용 위해 `qlpack.yml`로 패키징. Actions advanced setup에서 `packs:`로 추가, `.github/codeql/codeql-config.yml`로 query/filter 지정.

4. **Model pack / data extension** — 기존 쿼리의 source/sink/summary/barrier 모델 확장. "우리 프레임워크의 어떤 함수가 request source인가" 등을 YAML tuple로 주입.
   > `[✓2026-06-02 재확인]` 공식: model pack은 **public preview**이며 C/C++·C#·Java/Kotlin·Python·Ruby·Rust 분석에 지원. VS Code model editor는 C#·Java/Kotlin·Python·Ruby dependency modeling 지원. **custom framework가 많은 조직은 query를 늘리기 전에 model pack을 먼저 만드는 것이 standard query 탐지력을 더 끌어올린다.**

## A-6. 알려진 활용 (공식 기능)

- **GitHub code scanning** — default setup(자동 언어/suite) 또는 advanced setup(build command, suite, pack, model pack, paths, filter 조정).
- **외부 CI / 로컬 CLI** — Actions 밖에서 database 생성→`database analyze`→SARIF, GitHub 업로드 없이 SARIF/CSV/BQRS를 내부 도구에 연결.
- **VS Code query development** — database 선택, 실행, quick eval, path 탐색, model editor, query test.
- **Multi-repository variant analysis (MRVA)** — VS Code에서 작성한 쿼리를 다수 저장소에 실행. `[✓2026-06-02 재확인]` 최대 **1,000개 repository**, Actions dynamic workflow로 병렬 실행. "같은 variant가 다른 저장소에도 있는가"에 적합.

---

# Part B — 코딩 에이전트 통합 (deep-research, 적대적 검증)

**연구 질문**: CodeQL의 정적 분석/데이터플로우/변종 분석을 코딩 에이전트 워크플로우(코드 이해, 취약점/버그 탐지, 테스트 설계, 리팩토링 안전성 검증)에 어떻게 통합하는가. 결과를 LLM-friendly 지식 그래프(graphify / karpathy LLM Wiki 개념)로 변환해 에이전트 컨텍스트로 줄 수 있는가. MCP/CLI 패턴, 실제 사례, 한계는?

지배적 아키텍처(증거 기반):

> **CodeQL/MRVA가 구조화된 발견을 생성 → SARIF/CSV/그래프 변환 → MCP로 노출된 구조화 도구 → LLM은 fuzzy reasoning만, 결정론적 검증은 MCP 서버에 잔류.**

통합은 3개 상보적 패턴으로 정리된다.

## B-1. 패턴 1 — MCP 서버로 CodeQL 스택을 에이전트에 연결

- **공식 MCP 서버 존재** `[✓검증 3-0/일부 2-1]`: `advanced-security/codeql-development-mcp-server`가 임의 LLM을 CodeQL 스택(AST/CFG/CLI/LSP)에 stdio/HTTP로 브리지. MCP tools·prompts·resources 제공. README: "designed specifically for agentic AI development of CodeQL (QL) code". (출처 [1])
  - ⚠️ **함정**: 이 서버는 **CodeQL 쿼리(QL 코드) 작성·검증·최적화용**이지, *대상 코드를 분석해 에이전트 컨텍스트로 주는 용도가 아니다*. 흔한 오해. 대상 코드 질의용은 별도 커뮤니티 서버(`JordyZomer/codeql-mcp` 계열). ("recommended client" 특성화에서만 1표 반대, 존재·전송·목적은 만장일치.)
- **연구급 사례 — QLCoder** `[✓검증 3-0]`: LLM을 synthesis loop + execution feedback에 넣고 LSP(문법)+RAG 벡터DB(쿼리·문서 의미검색)를 커스텀 MCP로 결합해 **CVE별 맞춤 CodeQL 쿼리 자동 생성**. 176 CVE / 111 Java 프로젝트에서 **53.4% 정확**(Claude Code 단독 10%), F1 0.7(CodeQL/IRIS 일반 스위트 0.073/0.048). (출처 [2])
  - `[VERIFY]` 비교가 "CVE-맞춤 합성 쿼리 vs 기본 일반 스위트"라 apples-to-oranges. 미공개 preprint(2025-11), n 제한적. QLCoder조차 CVE의 ~47%를 놓침.

## B-2. 패턴 2 — CodeQL=결정론적 생성기, LLM=트리아지 (가장 검증된 패턴)

- **GitHub Security Lab Taskflow Agent** `[✓검증 3-0]`: "We have **not** used any static or dynamic code analysis tools other than to generate alerts from CodeQL." CodeQL은 오직 alert 생성기. 트리아지는 YAML 정의 독립 task로 분해, **각 task는 fresh context**(복잡 멀티스텝은 제대로 안 끝남). 설계 원칙 **"Delegate to MCP server whenever possible"** — 검증 가능한 건 MCP에, 복잡 추론만 LLM. (출처 [3])
- **Vulnhalla (CyberArk)** `[✓검증 3-0]`: CodeQL DB 생성 → 쿼리 → 모든 alert을 LLM에 넘겨 진짜/오탐 분류. **최대 96% 오탐 감소**(유형별, 100개 C 저장소). 컨텍스트 구성이 시사적:
  - 줄 번호 대신 **함수 전체** 추출 — *모든 함수를 CSV로 덤프하는 단일 CodeQL 쿼리*
  - CodeQL 번들 `src.zip` 사용 → repo clone 불필요, 평균 **~3초** 검색. (출처 [4])
  - `[VERIFY]` 벤더 블로그 "up to" 최선값. recall은 90% 아래로 떨어질 수 있고 CWE/모델 의존. 방향성(오탐 감소)은 독립 연구(ZeroFalse, Datadog)로 확인.
- **GitHub 자체 선례** `[✓검증 3-0]`: CodeQL 팀이 LLM으로 API를 source/sink/propagator로 **자동 모델링**(수천 OSS 프레임워크, 수작업 대체) → MRVA 변종 분석과 결합해 **신규 CVE-2023-35947**(Gradle path traversal) 발견. LLM↔CodeQL 양방향 시너지 실제 선례. NVD 독립 확인. (출처 [5])

## B-3. 패턴 3 — 지식 그래프 전달 (graphify / LLM Wiki 직결)

- **CodeQL 데이터플로우는 그 자체가 그래프** (A-2 참조): path-problem 쿼리는 **SARIF v2.1.0**의 `codeFlow`→`threadFlow`로 **source→sink 추적**을 표준 JSON으로 방출. `[✓검증 3-0]` SARIF v2.1.0(OASIS 표준 JSON, `--format=sarifv2.1.0`/`sarif-latest`)이 구조화 진입점. (출처 [6][7])
- **graphify (지정 도구)** `[✓검증 3-0]`: 임의 입력(코드/SQL 스키마/문서/논문/이미지/영상)을 자연어 질의 가능한 지식 그래프로 변환, **MCP 서버로 노출** — `query_graph`, `get_node`, `get_neighbors`, `shortest_path` 등 7개 도구. KG-via-MCP 전달 메커니즘 실증. (출처 [8])
- **Codebase-Memory (대조 증거)** `[✓검증 2-1]`: Tree-Sitter 구조 그래프를 MCP로 노출 → 답변 품질 83%(파일탐색 92%)지만 **토큰 ~10배, 도구호출 ~2.1배 절감**. (출처 [9])
  - ⚠️ **결정적 한계**: 구문 구조(정의/콜그래프/import)만 추출, CodeQL의 dataflow/taint/변종 분석 안 함. 오히려 CodeQL을 *"heavyweight, LLM 소비용 설계 아님"*이라 **명시적 거부**. → KG-MCP 전달 *방식*은 검증하나, "CodeQL 의미 그래프를 통째로 graphify"에는 반대 증거.

## B-4. LLM Wiki 개념과의 연결

karpathy LLM Wiki 핵심(지식을 LLM 소비용으로 미리 정제, 결정론/판단 분리)이 모든 패턴을 관통:
- **결정론 vs fuzzy 분리**: CodeQL(사실) ↔ LLM(판단) — Taskflow "MCP 위임" 원칙과 동형
- **구조화된 진입점**: SARIF codeFlow = "LLM이 읽기 좋은 사실 단위"
- **컨텍스트 절약**: Vulnhalla 함수 단위 추출, Codebase-Memory 10배 토큰 절감 = 필요한 사실만 정제 제공

## B-5. CLI 통합 — mrva (Trail of Bits)

`[✓검증 3-0]` CodeQL MRVA를 **터미널 우선·로컬**로 돌리는 composable CLI. GitHub VS Code 기반 MRVA의 대안으로 결과를 stdout/SARIF로 출력 → 스크립트화·파이프라인화 용이. 3-커맨드 워크플로우: `mrva download`(GitHub API로 사전 빌드 DB) → `mrva analyze`(쿼리/팩) → `mrva pprint`(결과), `--` 뒤 플래그는 CodeQL 바이너리로 전달. (출처 [10])
- 뉘앙스: "entirely local"은 분석 *실행*이 로컬이란 뜻. DB는 GitHub API로 다운로드. 벤더 발표(2025-12).

---

# Part C — 창의적 활용 + 실증 여부 주석

> 아래는 플랫폼 기능 위에 올린 활용 아이디어다. Part B에서 확인된 실제 선례와 대조해 등급화했다: **[실증]** 실제 시스템 확인 / **[추론]** 기능상 가능하나 에이전트 사용 사례 미확인 / **[투기]** 실증 0.
> (선행 문서의 BPMN/Camunda 활용 절은 본 통합에서 제외.)

| # | 활용 | 등급 | 근거 |
|---|---|---|---|
| C-1 | **아키텍처 정책 엔진** (`ui/**`→`db/**` import 금지 등 경계 lint) | [추론] | call graph/class hierarchy/dataflow까지 엮어 ESLint보다 깊은 경계 검사 가능. 에이전트 사용 사례 미확인. |
| C-2 | **Agentic coding guardrail** (권한 우회 옵션/shell·file write sink/schema validation 누락 탐지) | **[실증]** | Taskflow Agent·Vulnhalla가 동형 패턴(B-2). agent runtime 성격 저장소에 일반 SAST보다 값짐. |
| C-3 | **LLM 코드리뷰 근거 그래프** (변경 함수 도달 sink, 새 source→sink path를 "review context bundle"로) — CodeQL을 agent용 semantic retriever로 | [추론] · `[VERIFY]` | 방향은 B-3과 정확히 일치하나, **CodeQL 의미 그래프→LLM KG→컨텍스트 서빙의 완전·벤치마크된 단일 시스템은 1차 소스에 없음**(아래 D-1). 빌딩블록은 검증됨, end-to-end는 미실증. |
| C-4 | **Privacy/data lineage** (PII/token이 log·analytics·LLM provider sink로 흐르는가) | [추론] | CodeQL dataflow로 표현 가능. 에이전트가 이 용도로 쓴다는 증거 미발견. |
| C-5 | **Migration acceptance gate** (deprecated API 간접호출, legacy config 잔존 path) | [추론] | 기능상 가능. 실증 사례 미발견. |
| C-6 | **내부 framework model pack** (request source/SQL sink/sanitizer 모델) | **[실증]**(기능) | model pack public preview 확인(A-5). GitHub 팀의 LLM 자동 API 모델링(B-2)이 같은 방향. |
| C-7 | **보안 사고 후 variant hunt** | **[실증]** | GitHub의 CVE-2023-35947 발견이 정확히 이 패턴(B-2). MRVA/mrva로 실행. |
| C-8 | **테스트 생성 타깃 찾기** (테스트 없는 source→sink path 추출) | **[투기]** · `[VERIFY]` | **실증 0.** deep-research에서 에이전트가 dataflow로 테스트 설계한다는 증거 전혀 미발견(D-3). 가장 투기적. |
| C-9 | **GitHub Actions 공급망 정책** (SHA pin 안 됨, `pull_request_target` 후 untrusted 실행 등) | [추론]→일부 공식 | CodeQL actions 분석 공식 지원(A-4.1). 조직 보안 효과 큼(권한·secret 집중 경계). |
| C-10 | **코드베이스 질의 API** (config key 읽는 runtime path, MCP tool schema 도달 handler 등) | [추론] · 메커니즘 [실증] | graphify/Codebase-Memory가 KG-via-MCP 메커니즘 실증(B-3). 단 Codebase-Memory가 CodeQL을 "너무 무겁다"고 거부 — CodeQL을 직접 그래프화할 때 비용 검증 필요. |

---

# Part D — 한계와 미해결 질문

1. **`[VERIFY]` End-to-end 시스템 부재 (최대 갭)**: *CodeQL dataflow/SARIF codeFlow를 LLM-friendly KG로 변환해 에이전트 컨텍스트로 서빙하는* 완전·벤치마크된 단일 시스템은 1차 소스에 없음. 본 보고서의 그 아키텍처는 검증된 조각들의 **합성 추론**이지 문서화된 단일 시스템이 아니다. (C-3 직결)
2. **`[VERIFY]` 비용 미지**: 인터랙티브 에이전트 루프 안에서 CodeQL DB 생성·질의의 토큰/지연 비용 불명. 리팩토링 안전성 같은 비보안 작업에 prohibitive한지 미확인. (Codebase-Memory가 "너무 무겁다"고 거부한 이유)
3. **`[VERIFY]` 용도 편중**: 검증 증거는 거의 전부 취약점/버그 탐지. 질문의 **테스트 설계**·**리팩토링 안전성 검증**(전후 dataflow 동등성)을 에이전트가 실제로 쓴다는 증거 미발견. (C-8 직결)
4. **`[VERIFY]` 합성 쿼리 신뢰성**: QLCoder조차 CVE의 ~47% 놓침. 에이전트 자동생성 쿼리 의존 시 false-negative/recall 위험 미해결.
5. **시간 민감도**: 통합 도구 대부분 2025말~2026초(mrva 2025-12, graphify v5-v8, MCP 서버 open issue 다수). 도구명·전송방식·벤치마크 수치 변동 가능.

**기각된 주장 1건** (deep-research 투표 1-2): repo-level codegen을 semantic sub-graph 검색으로 한다는 arXiv 2505.14394 주장 — 핵심 아키텍처 근거로 채택하지 않음.

---

# Part E — 실무 도입 판단 + 실행 제언

## E-1. 도입 가치가 높은 조건 / 맞지 않는 목적

**높음**: 지원 언어군 / 규칙을 semantic relation으로 표현 가능 / FP triage 인력 또는 precision 조정 시간 / custom framework면 model pack 작성 가능 / CI build 재현성 확보.

**맞지 않음**: 임의 언어 빠른 grep / runtime exploitability 단독 판정 / dependency CVE 관리 대체 / formatter·linter 수준 style rule 대량 집행 / source 거의 없고 generated·binary 의존이 대부분.

## E-2. DITTO 맥락 권장 순서

증거가 가장 탄탄한 진입점 순 (Part B 우선):

1. **CodeQL을 결정론적 생성기로 채택** — 에이전트 안에서 CodeQL DB → path-problem 쿼리 → **SARIF codeFlow를 구조화 사실로 추출** (B-2, 최검증).
2. **트리아지/판단만 LLM 위임**, 검증 가능한 건 MCP 도구 (Taskflow 원칙).
3. **컨텍스트는 함수 단위 + src.zip** (Vulnhalla, ~3초).
4. **GitHub Actions workflow + JS/TS 분석부터** 켠다(A-6). suite는 `security-extended`까지, noise 크면 filter.
5. **agent runtime 특화 custom query 3-5개**(C-2): 권한 우회 옵션, shell/file write sink, hook/plugin schema validation 누락. query pack + `qltest` fixture.
6. **모델 부족한 내부 abstraction 발견 시 query 늘리기 전에 model/data extension 검토** (A-5, C-6).
7. **graphify는 codeFlow→KG 변환 레이어로 실험** — 단 "CodeQL 통째 graphify"는 비용 검증 후(D-2). Codebase-Memory 경고 반영.
8. **CLI 파이프라이닝은 mrva**(B-5, terminal-first, stdout/SARIF).

## E-3. 결론

CodeQL은 단순 SAST를 넘어 **코드베이스에 대한 검증 가능한 지식층**으로 쓸 수 있다. 도입의 핵심은 query 수를 늘리는 것이 아니라 다음 질문에 답하는 것이다: 우리가 반복해서 놓치는 위험은 무엇인가 / 그것이 AST·call graph·data flow·type relation으로 표현 가능한가 / custom framework 모델이 필요한가 / 결과를 alert로 막을 것인가 report·context로 활용할 것인가.

코딩 에이전트 관점의 최선 진입점은 분명하다: **CodeQL을 결정론적 사실 생성기로, LLM을 판단자로 분리하고, 그 사이를 SARIF codeFlow / MCP 구조화 도구로 잇는다.** end-to-end KG 서빙은 아직 미실증 영역이므로 PoC로 직접 검증해야 한다.

---

# Part F — 도입 평가 (DITTO는 하네스, 분석 대상은 외부 target repo)

> **관점 정정(중요)**: CodeQL의 분석 대상은 **DITTO 자체가 아니라, DITTO가 감독하는 코딩 에이전트가 실제로 수정하는 외부 서비스 코드(target repo)**다. DITTO 멘탈 모델("자율주행 시스템을 자동차에 이식, 자동차는 안 만든다")대로, DITTO는 **오케스트레이터**이고 CodeQL은 DITTO가 에이전트에게 **제공하는 capability**다. 이 관점이 Part A~E의 원래 연구질문(coding agents가 코드를 분석/테스트/설계)과 일치한다.
>
> 평가 근거: Explore로 파악한 DITTO 아키텍처(file:line) + Part B 검증 + 부록2 PoC 실측.

## F-1. 한 줄 평가

DITTO가 제공하는 CodeQL의 가치는, **에이전트가 외부 target repo를 다룰 때 "조작 불가능한 결정론적 사실"을 공급**해, 에이전트의 이해·변경·검증을 LLM 추측이 아닌 검증된 dataflow 위에 올리는 것이다. DITTO는 그 사실을 증거/리뷰/게이트로 **오케스트레이션**한다.

## F-2. 도입 효과 — 에이전트 워크플로우 4단계에 주는 가치 (target repo 대상)

| 워크플로우 | 현재(LLM 단독) | CodeQL 공급 시 | 검증 |
|---|---|---|---|
| **코드 이해** | 파일 읽고 call chain 추측, 누락·환각 | target의 call graph / source→sink dataflow를 결정론 사실로 제공 | PoC-1 실증(codeFlow→구조화) |
| **취약점/버그 탐지** | LLM 패턴 매칭, 재현성 낮음 | taint 쿼리로 source→sink 경로 확정, LLM은 triage만(B-2 Vulnhalla) | PoC-1 + B-2 |
| **테스트 설계** | 커버리지 감 없이 생성 | 테스트 없는 source→sink path를 우선순위로 추출(C-8) | `[VERIFY]` 미실증(D-3) |
| **리팩토링 안전성** | "동작 동등" 자기선언 | 변경 전후 dataflow diff로 동등성 기계 검증(C-3/D-3) | ✅ **frontend 실증(부록3)** — 라인 정규화 과제 |

핵심: **에이전트가 target을 수정한 뒤 "새로 생긴 source→sink path = 0"을 CodeQL로 확정**하면, DITTO completion gate의 acceptance 증거가 된다. LLM의 "안전하게 고쳤습니다"를 결정론으로 대체.

## F-3. DITTO 오케스트레이션 매핑 — 하네스가 결과를 담는 그릇 (이미 준비됨)

CodeQL이 target repo를 분석한 결과를, DITTO의 기존 스키마/게이트가 **추가 추상화 없이** 수용한다:

| DITTO 메커니즘 | 역할 (target repo 대상) | 근거 |
|---|---|---|
| **`run-with` (reviewer profile)** | target repo에서 CodeQL CLI를 spawn하는 실행 단위. DB 생성·쿼리를 여기서 1회 수행·캐시 | `src/core/run-with.ts:159`, `src/core/hosts/spawn.ts:18` |
| **EvidenceStore** | target 분석 SARIF → `evidenceRef{kind:'artifact'}`+sha256 → evidence-index | `src/schemas/evidence-record.ts:22-47` |
| **ReviewerOutput(security-reviewer)** | target의 CodeQL findings가 `findings{severity,file,location,reason}`에 **거의 1:1 매핑** | `src/schemas/reviewer-output.ts:37-87` |
| **completionEvidenceGate** | "target 변경 후 CodeQL 검증" = verdict=pass의 결정론 증거(note 아님) | `src/core/gates.ts:188-200` |
| **handoff context packet** | target의 변경 함수 도달 sink 목록을 다음 세션에 전달(C-3/C-10) | work-item-handoff |
| **doctor capability** | **target repo의 언어**에 CodeQL 지원되는지 검증(빌드 재현성 포함) | `src/core/capability-inventory.ts:9` |

ReviewerOutput에 `security-reviewer`/`cross-provider-reviewer` kind가 이미 있어, CodeQL은 **provider 중립 결정론 리뷰어**로 자연스럽게 들어간다(LLM 리뷰어 간 불일치 중재).

## F-4. PoC 실증 재해석 — 메커니즘은 target-무관하게 검증됨

PoC는 DITTO 저장소를 **우연한 샘플 target**으로 썼을 뿐, 검증된 메커니즘은 임의 target repo에 동일 적용된다:

| PoC | target-무관 실증 결과 | 임의 target에의 함의 |
|---|---|---|
| PoC-0 | TS repo DB 생성→분석→SARIF v2.1.0 | target이 지원 언어면 작동 |
| PoC-1 | command-injection codeFlow → source→sink 10단계 구조화 | **target의 취약 경로를 에이전트 컨텍스트로 변환 가능** (핵심) |
| PoC-2 | custom 쿼리 작동, **구조 쿼리는 noisy(56건)** | target에도 동일 — **taint 쿼리+triage라야 게이트에 쓸모** |
| PoC-3 | DB생성 13.8초(143파일)/증분 ~4초/CLI 2.7GB | **target이 크면 비용 증가** — reviewer profile 1회 생성·캐시 필수 |

## F-5. 한계·위험 (target repo 관점에서 재평가)

- **target 다양성**: target 언어가 CodeQL 미지원(PHP/Scala 등)이거나 build 재현 안 되는 compiled 프로젝트면 무용. doctor capability로 **target별 사전 판정** 필요.
- **target 규모 비용**: 작은 PoC(143파일)는 13.8초였으나 대형 target은 DB 생성이 수분~수십분. reviewer 레인 한정 + per-target DB 캐시 전략 필수.
- **`[VERIFY]` 테스트 설계·리팩토링 안전성 미실증**: F-2의 가장 차별적인 두 가치(D-3)는 PoC 범위 밖. target에 대한 before/after dataflow diff PoC가 다음 과제.
- **구조 쿼리 noise**: PoC-2 실증. taint 쿼리로 좁히지 않으면 게이트가 거짓 차단.
- **`[VERIFY]` end-to-end 미실증**: SARIF→MCP→KG 자동화는 컨버터 스크립트까지만(D-1).

## F-6. 권고 — 최소 진입점 (하네스가 target에 가치 주는 가장 작은 경로)

charter "가장 간단하되 검증된 최소 구현" 기준:

> **1단계**: `doctor capability`로 target repo 언어의 CodeQL 지원 판정 → `run-with` reviewer profile에서 **target repo**에 CodeQL DB 생성·taint 쿼리 실행(1회 캐시) → SARIF를 `EvidenceStore.appendRecord(kind:'artifact')`로 기록 → `security-reviewer` ReviewerOutput으로 변환(PoC-1 컨버터 재사용) → completion gate 증거로 연결. **새 추상화 없음, 기존 스키마 재사용.**

가장 검증된 패턴(B-2)이자 PoC 실증 경로. 그 다음: target 대상 리팩토링 안전성 dataflow diff(D-3 PoC), handoff dataflow context, MCP/KG. (ADR 승격 후보: "CodeQL을 target repo의 결정론 증거원으로 하네스에 통합".)

---

## 참고 자료

### Part A (플랫폼, 공식)
- `github/codeql`: https://github.com/github/codeql — HEAD `a16f1c5...`: https://github.com/github/codeql/tree/a16f1c555cea339ef5c8b4c7c9285b6e578c396c
- About CodeQL: https://codeql.github.com/docs/codeql-overview/about-codeql/
- Supported languages and frameworks: https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/ — `[✓2026-06-02 재확인]`
- System requirements: https://codeql.github.com/docs/codeql-overview/system-requirements/
- About code scanning with CodeQL: https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/codeql/about-code-scanning-with-codeql
- About the CodeQL CLI: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-the-codeql-cli
- Code scanning for compiled languages: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-codeql-code-scanning-for-compiled-languages
- Custom CodeQL queries: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/custom-codeql-queries
- Creating and working with CodeQL packs: https://docs.github.com/en/code-security/tutorials/customize-code-scanning/creating-and-working-with-codeql-packs
- Workflow configuration options: https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/workflow-configuration-options
- Using the CodeQL model editor: https://docs.github.com/en/code-security/how-tos/scan-code-for-vulnerabilities/scan-from-vs-code/using-the-codeql-model-editor — `[✓2026-06-02 재확인]` (model pack public preview, 6개 언어)
- Customizing library models for Go: https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-go/
- Multi-repository variant analysis: https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/multi-repository-variant-analysis — `[✓2026-06-02 재확인]` (최대 1,000 repo)
- CodeQL 2.24.0 changelog (2026-01-29): https://github.blog/changelog/2026-01-29-codeql-2-24-0-adds-swift-6-2-support-net-10-compatibility-and-file-handling-for-minified-javascript/

### Part B (에이전트 통합, deep-research 적대적 검증)
- [1] codeql-development-mcp-server: https://github.com/advanced-security/codeql-development-mcp-server — *primary, QL 작성용임에 주의*
- [2] QLCoder: arXiv 2511.08462 / https://github.com/neuralprogram/qlcoder — *preprint*
- [3] Taskflow Agent: https://github.blog/security/ai-supported-vulnerability-triage-with-the-github-security-lab-taskflow-agent/ + https://github.com/GitHubSecurityLab/seclab-taskflow-agent
- [4] Vulnhalla: https://www.cyberark.com/resources/threat-research-blog/vulnhalla-picking-the-true-vulnerabilities-from-the-codeql-haystack + https://github.com/cyberark/Vulnhalla — *벤더 블로그*
- [5] CodeQL 팀 AI 모델링: https://github.blog/security/vulnerability-research/codeql-team-uses-ai-to-power-vulnerability-detection-in-code/ + NVD CVE-2023-35947
- [6] SARIF output: https://docs.github.com/en/code-security/codeql-cli/using-the-advanced-functionality-of-the-codeql-cli/sarif-output
- [7] Data flow / path queries: https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/ (+ creating-path-queries, exploring-data-flow-with-path-queries)
- [8] graphify: https://github.com/safishamsi/graphify
- [9] Codebase-Memory: arXiv 2603.27277 — *CodeQL을 명시적 거부*
- [10] mrva: https://blog.trailofbits.com/2025/12/11/introducing-mrva-a-terminal-first-approach-to-codeql-multi-repo-variant-analysis/ + https://github.com/trailofbits/mrva

---

## 부록 — 검증 로그

**deep-research 통계**: 6개 각도 · 소스 20개 fetch · 주장 99개 추출 → 25개 적대적 검증 (24 확정 / 1 기각) · 에이전트 103개 호출 · 약 9.3분.

**통합 시 추가 검증 (2026-06-02, 공식 문서 직접 재확인)**:

| 항목 | 검증 전 상태 | 재확인 결과 | 출처 |
|---|---|---|---|
| §A-4.1 언어 버전 전 항목 | 미검증(드리프트 민감) | 공식 supported-languages와 **전부 일치** | supported-languages 페이지 |
| §A-6 MRVA 1,000 repo 한계 | 미검증 | "up to 1,000 repositories from VS Code" **확정** | MRVA 페이지 |
| §A-5 model pack public preview + 6개 언어, 모델에디터 4개 언어 | 미검증 | "currently in public preview" + 언어 목록 **일치** | model editor 페이지 + 검색 교차 |

`[VERIFY]` 잔존 항목(추가 검증으로 해소 불가, PoC 필요): D-1(end-to-end KG 서빙 미실증), D-2(에이전트 루프 내 CodeQL 비용), D-3(테스트 설계/리팩토링 안전성 용도 실증 0), QLCoder/Vulnhalla 수치의 best-case 성격.

---

## 부록 2 — PoC 실행 결과 (2026-06-02, 실측 fresh evidence)

DITTO 저장소(143개 TS)에서 CodeQL CLI **2.25.5**(gh extension)로 직접 실행. 산출물은 `.codeql-poc/`(gitignore).

| PoC | 검증 대상 | 결과 | 판정 |
|---|---|---|---|
| **PoC-0** | DITTO에서 CodeQL 작동 | DB 생성→`security-extended`(104쿼리, 148파일+1 Actions)→SARIF v2.1.0. alert 1건(`js/biased-cryptographic-random`) | ✅ 통과. 저장소 대체로 깨끗 |
| **PoC-1** (D-1) | SARIF codeFlow→에이전트 컨텍스트 | 취약 fixture(CWE-078)로 `js/command-line-injection` codeFlow 트리거 → 컨버터로 **source→sink 10단계 dataflow 사실** 추출(file:line+변수명) | ✅ 통과. codeFlow는 LLM 컨텍스트로 쓸만함. 단 snippet/severity는 SARIF 기본 미포함 → source 파일에서 보강 필요(Vulnhalla 방식) |
| **PoC-2** (C-2) | 결정론적 가드레일 custom query | `js/ditto/direct-exec`(.ql)+qltest. 위험 케이스(execSync/exec) 탐지·안전 케이스 무시, 회귀 통과 | ✅ 통과. **단 구조 쿼리는 noisy**(아래) |
| **PoC-3** (D-2) | 에이전트 루프 내 비용 | 아래 실측 표 | ⚠️ 조건부 feasible(캐싱 전제) |

**PoC-3 실측 비용**:

| 항목 | 비용 | 성격 |
|---|---|---|
| CLI 번들 설치 | 1.025GB 다운로드 ~70초 / 디스크 **2.7GB** | 1회성 |
| 팩 캐시(queries+all+의존성) | 60MB | 1회성 |
| DB 생성 (143 TS) | **13.8초** / 디스크 77MB | 코드 변경 시마다 |
| 전체 `security-extended` (104쿼리) | **34초** | |
| **증분: DB 캐시 후 단일 custom 쿼리 재실행** | **~3.9초** (eval 310ms + 오버헤드) | 인터랙티브 가능 |

→ **결론**: 매 턴 DB 재생성(13~34초)은 에이전트 루프에 부담. **세션 시작 시 DB 1회 생성·캐시 → 쿼리만 증분 실행(~0.3~4초)** 패턴이면 실용적. Codebase-Memory의 "heavyweight" 지적은 사실이나 캐싱으로 완화 가능. D-2 부분 해소.

**부수 발견 (가드레일 정밀도 교훈)**: PoC-2 가드레일 쿼리를 DITTO 실코드에 돌리니 **56건** 탐지 — 대부분 test 파일, 핵심은 `src/core/hosts/spawn.ts:26`, `src/core/run-with.ts:339`, `src/core/work-item-handoff.ts` 등. 이는 **구조 쿼리(호출 존재만 탐지)는 noisy**함을 실증한다. 실용화하려면 ① test 경로 제외, ② **dataflow 쿼리로 좁혀** untrusted input이 실제로 sink에 흐르는 것만 탐지(PoC-1 방식), ③ 남은 noise는 LLM triage(Vulnhalla 패턴, B-2). 즉 **C-2 가드레일의 진짜 가치는 구조 쿼리가 아니라 taint 쿼리 + LLM triage 조합**에 있다.

**갱신된 `[VERIFY]` 상태**:
- D-1: **부분 해소** — codeFlow→구조화 사실 변환 실증(PoC-1). 단 MCP 서빙 레이어 + 자동 KG화는 미구현(컨버터 스크립트 수준까지만).
- D-2: **부분 해소** — 비용 실측 확보, 캐싱 전제로 feasible.
- D-3(테스트 설계/리팩토링 안전성): **미해소** — 본 PoC 범위 밖.
- 다음 PoC 후보: ① 컨버터를 MCP 서버로 노출(D-1 완결), ② taint 쿼리+test제외로 가드레일 정밀화, ③ 리팩토링 전후 dataflow diff(D-3). → ③은 부록3에서 실증함.

---

## 부록 3 — 실서비스 target PoC (2026-06-02, boxwood-workspace/frontend)

**관점 정정의 실증**: 부록2 PoC는 DITTO 자체를 샘플 target으로 썼다(F-4). 본 부록은 **DITTO가 감독하는 에이전트가 실제로 수정하는 외부 서비스 코드**(`boxwood-workspace/frontend`, turbo 모노레포, TS/TSX 708 + JS/JSX 81)를 진짜 target으로 삼아 재실증한다. ditto는 `git worktree`(codeql-poc 브랜치)로 격리해 PoC 수행.

### F-2 "코드 이해·취약점 탐지" 실서비스 실증 (PoC-1 재현)
- 785파일 분석 → **alert 37건, codeFlow(dataflow 경로) 11건** (DITTO 샘플은 1건/0건이었음 — 실서비스라야 의미)
- 컨버터로 실제 취약 경로를 에이전트 컨텍스트로 추출 성공. 예:
  - `js/prototype-pollution-utility`: `packages/bpmn/src/utils/ioParameterUtils.ts:246→260` (6단계 source→sink)
  - 동일 패턴 `parameterMergeUtils.js:243→253`
- → **F-4의 "샘플 target" 한계가 실제 외부 서비스 코드로 해소됨.**

### F-2 "리팩토링 안전성" 실증 (Step 2, D-3 — 가장 차별적 미검증 가치)
리팩토링 커밋 `67b27ccf`("bpmn 패키지 구조 개선 — 유틸 모듈 분리")의 before(`67b27ccf^`)/after를 각각 DB화·분석해 dataflow diff:

| 지표 | before | after | 판정 |
|---|---|---|---|
| 총 alert | 12 | 12 | **불변** |
| codeFlow 경로 | 5 | 5 | **불변** |
| line-key NEW/REMOVED | — | 4 / 4 | 전부 **동일 취약점의 라인 이동**(`ioParameterUtils.ts:235→249` 등) |

→ **이 리팩토링은 prototype pollution 취약성을 추가/제거 없이 보존** = Tidy First "구조변경=동작동등"이 보안 관점에서 지켜졌음을 기계 검증. sanitizer를 빠뜨린 리팩토링이었다면 after에 alert 순증 → 게이트가 차단했을 것. **F-2 리팩토링 안전성 가치 실증됨.**

### 실용 교훈 (D-3 실용화 과제)
- **line 기반 diff는 코드 이동만으로 noise**(4 added/4 removed가 실은 0 순변화). 안전성 판정은 **순 카운트(12=12) 또는 정규화(rule+함수명/스니펫 해시)**로 해야 한다.
- `LGTM_INDEX_FILTERS` 환경변수는 JS autobuild를 깨뜨림(즉시 exit 1) — **설정하지 말 것**. CodeQL JS extractor가 node_modules를 알아서 제외(source archive 7.5MB).

### 대형 target 비용 실측 (F-5 갱신)
| 작업 | frontend(789 src) | DITTO(143 src) 대비 |
|---|---|---|
| DB 생성 | ~30초(TRAP import 12~23초) | 13.8초의 ~2배 |
| security-extended 분석 | ~1분(104쿼리, threads=0) | 34초의 ~2배 |
| before/after 2회 | 각 ~1.5분 | — |

→ 5배 파일인데 ~2배 시간(병렬 threads). **reviewer profile에서 DB 1회 생성·캐시하면 대형 실서비스도 현실적.** 단 node_modules 984M는 추출 대상 아님(CodeQL JS 기본 제외).

### 갱신된 상태
- **F-2 리팩토링 안전성**: `[VERIFY]` → **실증**(라인 정규화는 실용화 과제).
- **F-4**: DITTO 샘플 → frontend 실서비스로 재실증, 관점 정정 완결.
- **F-5 대형 target 비용**: 실측 확보.
- 잔존: 테스트 설계(C-8) 미실증 / D-1 MCP·KG 자동화 미실증.

---

## 부록 4 — cross-service 풀스택 PoC (별개 repo·다른 언어, 2026-06-02)

**구도**: 하나의 서비스를 구성하는 frontend(`boxwood-workspace/frontend`, TS)와 backend(`boxwood-workspace/portal-backend`, **Kotlin/Spring**, 별개 git repo)에 대해 CodeQL 정적 분석이 가능한지 실증.

### 결정적 한계 (먼저)
CodeQL은 **언어당 1 DB**이고 **dataflow는 단일 DB 안에서만** 추적한다. 따라서 프론트 `fetch()` → HTTP → 백엔드 핸들러의 **cross-repo/cross-language dataflow는 단일 쿼리로 자동 추적 불가**(A-4.3 한계). 풀스택 연결은 **양측을 각각 추출 → URL 계약으로 매칭**(후처리)해야 한다.

### 실증 결과

**1) build 비대칭 — 컴파일 언어가 실질 장벽** (가장 중요한 발견):

| target | 방식 | 결과 |
|---|---|---|
| frontend (TS/TSX 708) | `--build-mode=none` | ✅ 즉시 추출 |
| backend (Kotlin 666) | `--build-mode=none` | ❌ **666파일 중 6클래스만 추출, annotation 0** (kotlinc 미실행) |
| backend | `--build-mode=autobuild` | ❌ gradle `testClasses` 컴파일 실패(exit 1) |
| backend | manual `compileKotlin` (원본) | ❌ UP-TO-DATE 스킵 → extractor 미후킹 |
| backend | **격리 worktree + clean compileKotlin** | ✅ **BUILD SUCCESSFUL 3분 26초 → annotation 370개** |

→ **Kotlin extractor는 실제 kotlinc 컴파일 중에만 후킹**한다. build-mode none·캐시된 빌드로는 추출 안 됨. **컴파일 언어 target은 build 재현 환경(JDK/gradle/의존성)이 필수**이며, 이것이 cross-service 분석의 실질 비용·장벽. → F-3 `doctor capability`의 "target 언어별 build 재현성 사전 판정"이 결정적임을 실증.

**2) cross-service 매칭 — URL 계약으로 풀스택 연결 합성**:
- backend: CodeQL Kotlin 쿼리로 `@*Mapping` 경로 추출 → **391개 endpoint 문자열** (`/api/v1/llm-tasks` 등)
- frontend: CodeQL JS 쿼리로 `/api/v[12]/...` 문자열 추출 → **26개 호출 경로**
- node 후처리로 path-param 정규화 + longest-prefix 매칭 → **18/26 정밀 매칭**:
  - `FE /api/v1/llm-tasks ↔ BE /api/v1/llm-tasks`
  - `FE /api/v1/connectors ↔ BE /api/v1/connectors`
  - `FE /api/v1/admin/i18n/locales ↔ BE /api/v1/admin/i18n/locales`

→ **다른 언어·다른 repo의 풀스택을 CodeQL 양측 추출 + 계약 매칭으로 연결 가능**(보고서 패턴: CodeQL=결정론 추출기, 매칭=후처리). 정밀 endpoint↔handler 매칭은 class@RequestMapping+method@GetMapping **경로 결합**까지 하면 더 정확(현재는 class-prefix 수준).

### 결론 (사용자 질문에 대한 답)
"프론트/백 별개 repo·다른 언어" 환경에서 CodeQL 정적분석은 **가능하다. 단**:
1. **언어별 DB 분리** + cross-service dataflow는 자동 안 됨 → **URL 계약 매칭으로 합성**.
2. **컴파일 언어(Kotlin)는 build 재현이 필수**. 해석/소스 언어(TS)와 난이도·비용이 크게 다름.
3. DITTO 하네스 관점: target별로 (a) 언어 판정 (b) **build 재현성 판정**을 `doctor capability`로 선행해야 reviewer 레인에서 실패 없이 돌릴 수 있다. backend는 `run-with`가 격리 환경에서 clean build를 수행하는 전제 필요.

---

## 부록 5 — 독립 서브에이전트 창발 연구 (2026-06-02, fresh perspective)

PoC 진행 중 형성된 편향을 배제하기 위해, **컨텍스트를 공유하지 않은 독립 서브에이전트**가 본 보고서와 DITTO 코드를 직접 읽고 "DITTO 특유 구조에서 비로소 가능한" 접목을 연구한 결과. baseline(Part F: security-reviewer 증거원)을 넘어서는 아이디어 위주.

### 관통 진단
> CodeQL의 가치는 "alert을 더 만드는 것"이 아니라 **DITTO 게이트가 현재 못 보는 빈칸을 채우는 것**이다.

핵심 근거: `completionEvidenceGate`(`src/core/gates.ts:188-200`)는 "verification이 *존재*하는가"(`length>0`)만 보고 **내용은 안 본다** → "테스트 돌렸으니 통과"의 빈 증거를 못 막음. CodeQL이 게이트에 처음으로 *의미*를 준다.

### 창발 아이디어

| # | 아이디어 | 왜 창발적(baseline 너머) | DITTO 접점 | 난이도/위험 |
|---|---|---|---|---|
| **E** ⭐ | **`doctor codeql` target 적합성 사전판정** (fail-closed) | 부록4 실증 "Kotlin build-mode none → 6클래스만 추출"은 게이트가 **빈 분석을 '깨끗함'으로 오판**하는 최악의 거짓통과. 이를 분석 전 차단 | `src/cli/commands/doctor.ts` 서브커맨드 + `capability-inventory.ts` 패턴 | 낮음 / 낮음 |
| **B** ⭐ | **CodeQL을 dialectic의 결정론 opponent로** | LLM opponent만 있던 변증법에 "기계가 든 objection". CodeQL finding이 `kind=finding,maps_to,backed_by` 모양에 **스키마 변경 0**으로 맞음. synthesizer가 명시 반박/수정해야만 종료 | `src/schemas/dialectic.ts:63-81`, `src/hooks/stop.ts:43-49` | 중 / 무한루프(taint+round_cap 필수) |
| C | 언어원장 → CodeQL model pack 컴파일 | 사용자와 *합의된* 도메인 용어(`agreed_with_user`)를 model pack 진실원으로 — standalone엔 없는 자산 | `src/schemas/language-ledger.ts` | 높음 / false negative |
| D | 핸드오프 패킷에 "도달성 델타(blast radius)" | 변경이 새로 연 sink를 다음 세션에. 핸드오프는 DITTO 고유 메커니즘 | `context-packet.ts:57-85` | 중 / 큰 target 비용 |
| G | convergence score에 도달성 델타를 결정론 입력 | "가장 적게 위험 늘린 버전"을 결정론 선택 | `src/core/gates.ts:204-213` | 중 / 과적용 주의 |
| H | cross-service 매칭(부록4)을 evidence sidecar로 승격 | `freshness/portability` 설계가 raw 없는 cross-repo 증거에 정확히 맞음 | `evidence-record.ts:43-46` | 낮음 / 매칭 정밀도 |

### 명시적 비판/기각
- **PreToolUse + CodeQL = 안티패턴** — PreToolUse는 동기·고빈도라 초 단위 CodeQL과 상극. 정규식 가드(`src/hooks/pre-tool-use.ts`)가 더 싸고 충분. **기각.**
- **stop hook 내 직접 CodeQL 호출 금지** — 비용 구조 불일치. reviewer lane 1회 캐시, stop은 산출물만 read.
- **DITTO가 CodeQL 쿼리/pack 직접 소유 금지** — "자동차는 안 만든다" 경계 침범. pack/model은 target 자산.

### 권고
1순위 **E**(전제조건·최저비용), 2순위 **B**(최고 창발성·스키마 변경 0). 둘 다 DITTO의 fail-closed/dialectic 구조와 동형. 상세 실행은 → `codeql-ditto-integration-plan.md`.

> 연구 한계: 어떤 아이디어도 구현·실행 검증 안 됨(연구·설계 범위). B의 무한루프 위험, C의 용어→tuple 매핑 정확도는 별도 PoC 필요.

---

## 부록 6 — C-8 PoC: dataflow → DoD·테스트 케이스 도출 (2026-06-02, 사용자 포인트1)

**목적**: "DoD/테스트를 데이터 흐름 관점으로 확장"(사용자 포인트1, 보고서 C-8)이 실제로 가능한지 실증. frontend(부록3)의 codeFlow 11건을 입력으로, 테스트 명세 + DoD 술어를 결정론 도출.

### 결과 — ✅ 도출 성공 (11건)
codeFlow → 다음을 결정론으로 생성:
- **테스트 명세** (GIVEN/WHEN/THEN): rule이 곧 위협모델 → 테스트 입력 패턴 제공
  - `js/prototype-pollution-utility` → GIVEN `__proto__`/`constructor` 키, THEN Object.prototype 미오염
  - `js/polynomial-redos` → GIVEN 백트래킹 유발 긴 문자열, THEN 평가시간 상한
  - `js/remote-property-injection` → GIVEN 동적 속성 키 주입, THEN 예약 속성 거부
- **DoD 술어**: `acceptance: "path src→sink 가 sanitizer로 차단됨"` — **11건 전부 현재 verdict=FAIL(alert 존재)**. completion contract acceptance로 그대로 투입 가능.

예시 (실제 도출):
```
■ [js/prototype-pollution-utility]  target: packages/bpmn/src/utils/ioParameterUtils.ts
  GIVEN 키 경로에 "__proto__"/"constructor" 포함
  WHEN  source :246 → sink :260
  THEN  Object.prototype 오염 없음
  DoD   "path :246→:260 가 sanitizer로 차단됨" — verdict=FAIL
```

### 실증된 것 / 한계
- ✅ **dataflow → DoD/테스트 명세 결정론 도출 가능** (포인트1 핵심). DoD가 "테스트 통과" 같은 빈 증거 대신 **검증 가능한 dataflow 명제**가 됨.
- ✅ **rule = 위협모델 = 테스트 입력 패턴**. CodeQL이 "무엇을 테스트할지"를 결정론으로 지정.
- ⚠️ **명세까지가 CodeQL 몫**. 실제 테스트 *코드 작성*은 LLM 몫(GIVEN/WHEN/THEN 명세 → 코드). 입력 패턴은 rule 기반 일반 힌트지 구체 값 자동생성은 아님.
- ⚠️ **부수 발견 — dist/ 빌드 산출물 noise**: 11건 중 6건이 `apps/automation/dist/.../css.worker.bundle.js`(monaco 번들). **진짜 소스는 5건.** → 분석에서 `dist/`·번들 제외 필요. 단 `LGTM_INDEX_FILTERS`는 JS autobuild를 깨뜨리므로(부록4), analyze 단계 `--paths-ignore` 또는 source-root 조정으로 해결해야 함(WI-1 구현 디테일).

### 결론
포인트1(dataflow DoD/테스트)은 **명세·DoD 도출 수준에서 실증됨** → 계획서 WI-5 전제 충족. 다음 단계는 (a) dist 제외로 noise 제거, (b) 명세→테스트 코드 생성을 LLM에 위임하는 흐름 검증.
