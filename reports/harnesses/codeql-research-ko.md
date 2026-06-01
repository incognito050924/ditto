---
title: "GitHub CodeQL 조사 보고서"
kind: research
last_updated: 2026-06-01 KST
scope: "github/codeql, CodeQL CLI, code scanning, query packs, model packs"
evidence_level: "공식 문서 + 공개 GitHub 저장소/API 스냅샷"
---

# GitHub CodeQL 조사 보고서

## 요약

CodeQL은 단순한 라이브러리라기보다 **코드를 데이터베이스로 추출하고, QL이라는 질의 언어로 그 데이터베이스를 분석하는 정적 분석 플랫폼**이다. 사용자가 링크한 `github/codeql` 저장소는 그 플랫폼 전체가 아니라, GitHub Advanced Security와 CodeQL code scanning에 쓰이는 **표준 CodeQL 라이브러리, 쿼리, 테스트, 언어별 팩**의 공개 저장소다. CLI와 분석 엔진은 별도 배포/라이선스 체계를 가진다.

핵심 작동 모델은 세 단계다.

1. 언어별 extractor가 소스코드와 빌드 정보를 읽어 **언어별 CodeQL database**를 만든다.
2. `.ql` 쿼리 또는 query suite/query pack을 그 데이터베이스에 실행한다.
3. 결과를 SARIF, VS Code UI, GitHub code scanning alert, 또는 원시 BQRS 결과로 해석한다.

CodeQL의 강점은 정규식 기반 검색이 아니라, AST, 타입/이름 바인딩, 제어 흐름, 데이터 흐름, taint tracking 위에서 "이 입력이 저 위험 sink까지 흐르는가", "이 API는 특정 조건 없이 호출되는가", "이 아키텍처 경계를 넘는 import/call이 있는가" 같은 질문을 질의로 만들 수 있다는 점이다.

커스텀 룰은 가능하다. `.ql` 파일로 직접 쓸 수 있고, 반복 사용하려면 `qlpack.yml` 기반 query pack, `.qls` query suite, model pack, data extension으로 배포할 수 있다. GitHub Actions code scanning에서는 advanced setup 또는 외부 CI/CodeQL CLI 경로가 필요하다.

## 조사 기준과 한계

조사 기준일은 2026-06-01 KST다.

확인한 공개 스냅샷:

| 항목 | 값 |
|---|---|
| 저장소 | `github/codeql` |
| 기본 브랜치 | `main` |
| 조사 기준 HEAD | `a16f1c555cea339ef5c8b4c7c9285b6e578c396c` |
| GitHub API 기준 pushed_at | 2026-05-30T06:28:47Z |
| GitHub API 기준 updated_at | 2026-05-31T12:50:42Z |
| 라이선스 | 저장소 코드 MIT, CodeQL CLI/engine은 별도 라이선스 |

한계:

- CodeQL 엔진 내부 구현은 공개 저장소의 대부분 범위 밖이다. 이 문서는 공식 문서, 공개 저장소 구조, CodeQL query/library pack 규약에 기반한다.
- 실제로 이 저장소에 CodeQL을 설치해 로컬 분석을 실행하지는 않았다. 보고서 검증은 공식 문서 확인, GitHub API 조회, Markdown 산출물 확인으로 제한된다.
- "창의적 활용" 절은 공식 기능 위에 올린 실무적 추론이다. 공식 지원 기능이라고 단정하지 않는다.

## 1. CodeQL은 어떤 라이브러리인가

정확히 말하면 CodeQL은 다음 네 가지가 결합된 분석 생태계다.

| 구성 요소 | 역할 |
|---|---|
| CodeQL CLI/engine | 데이터베이스 생성, 쿼리 컴파일/실행, 결과 해석, SARIF 출력 |
| extractor | 언어별 소스/빌드 정보를 CodeQL database로 추출 |
| QL language | CodeQL database를 질의하는 선언형, 객체지향적 논리 질의 언어 |
| standard libraries/queries | 언어별 AST/CFG/DFG 추상화, 보안/품질 쿼리, 테스트, query suite |

사용자가 링크한 `github/codeql` 저장소의 README는 이 저장소가 GitHub Advanced Security와 GitHub의 application security 제품에 쓰이는 표준 CodeQL 라이브러리와 쿼리를 담고 있다고 설명한다. 같은 README는 CLI와 엔진은 다른 저장소에 있고 별도 라이선스라고 명시한다.

따라서 "CodeQL 라이브러리"라고 부를 때는 보통 두 층을 구분해야 한다.

- **분석 플랫폼으로서 CodeQL**: CLI, engine, extractor, database, VS Code 확장, GitHub Actions integration까지 포함한다.
- **`github/codeql` 저장소로서 CodeQL**: 표준 query pack과 library pack의 소스다. 예를 들어 `codeql/javascript-queries`, `codeql/javascript-all`, `codeql/python-queries`, `codeql/java-all` 같은 팩이 여기에 있다.

이 구분은 라이선스와 운영에도 중요하다. 공개 저장소의 코드는 MIT지만, CodeQL CLI는 공개 저장소와 별도 조건을 가진다. 공식 문서 기준으로 CLI는 public repository에서 무료로 사용할 수 있고, private repository에서는 GitHub Code Security 라이선스 조건을 봐야 한다.

## 2. 어떻게 동작하는가

### 2.1 데이터베이스 생성

CodeQL 분석은 먼저 코드베이스를 언어별 database로 만든다. 공식 문서는 CodeQL database가 특정 시점의 단일 언어 코드베이스에서 추출된 질의 가능한 데이터이며, AST, data flow graph, control flow graph를 포함한다고 설명한다.

컴파일 언어의 경우 extractor는 보통 정상 빌드 과정을 감시한다. 컴파일러가 소스 파일을 처리할 때 구문 정보, 이름 바인딩, 타입 정보 등 분석에 필요한 의미 정보를 수집한다. 다만 최근 CodeQL code scanning은 일부 컴파일 언어에서 build 없이 database를 만드는 `none` build mode도 지원한다.

빌드 모드는 크게 세 가지다.

| build mode | 의미 | 대표 사용 |
|---|---|---|
| `none` | 빌드 없이 소스에서 database 생성 | 해석 언어 전체, 추가로 C/C++, C#, Java, Rust |
| `autobuild` | CodeQL이 가장 가능성 높은 빌드 방법을 감지해 실행 | C/C++, C#, Go, Java/Kotlin, Swift 등 |
| `manual` | 사용자가 명시한 빌드 명령을 실행 | 복잡한 mono-repo, custom build, 정확한 coverage 필요 |

실무적으로는 `manual`이 가장 통제 가능하다. 빌드되는 파일만 분석 대상으로 잡히는 언어에서는 빌드 명령이 곧 분석 범위가 된다.

### 2.2 쿼리 실행

database가 만들어지면 CodeQL query를 실행한다. 쿼리는 `.ql` 파일이며 `import`, class/predicate 정의, `from`, `where`, `select`로 구성된다. QL은 SQL처럼 보이는 부분이 있지만, 의미론은 Datalog 계열의 선언형 논리 질의 언어에 가깝다.

CodeQL 라이브러리는 database table을 직접 만지게 하지 않고 언어별 객체 모델을 제공한다. 예를 들어 JavaScript 분석에서는 함수 호출, 표현식, 모듈 import, data-flow node 같은 개념을 클래스와 predicate로 다룬다. 그래서 단순 문자열 검색보다 높은 수준의 질문을 표현할 수 있다.

분석 쿼리는 대략 네 부류로 나눌 수 있다.

| 쿼리 유형 | 예 |
|---|---|
| 구조 쿼리 | 특정 API 호출, 특정 import, 특정 annotation/decorator 사용 찾기 |
| 제어 흐름 쿼리 | check 없이 dangerous operation에 도달하는 경로 찾기 |
| 데이터 흐름 쿼리 | user input이 sanitizer를 거치지 않고 sink로 흐르는 경로 찾기 |
| 메트릭/진단 쿼리 | 복잡도, 사용 패턴, extractor 진단, custom inventory 생성 |

보안 연구에서 가장 중요한 것은 data flow와 taint tracking이다. source는 오염된 입력의 시작점, sink는 위험한 사용 지점, sanitizer/barrier는 흐름을 끊는 지점이다. CodeQL path query는 source에서 sink까지의 경로를 alert와 함께 보여줄 수 있다.

### 2.3 결과 해석

CodeQL CLI의 일반적인 파이프라인은 다음과 같다.

```bash
codeql database create codeql-dbs --source-root=src --db-cluster --language=java,python --command=./build
codeql database analyze codeql-dbs/java java-code-scanning.qls --format=sarif-latest --output=java.sarif
codeql github upload-results --sarif=java.sarif
```

GitHub Actions에서는 `github/codeql-action/init`, `autobuild`, `analyze` 단계가 이 작업을 감싼다. GitHub code scanning은 SARIF를 읽어 repository의 Security and quality 탭, PR check, alert UI에 표시한다.

쿼리 metadata가 결과 해석에 중요하다. code scanning alert로 보여주려면 보통 `@id`, `@kind`, severity, precision, tags 같은 metadata를 갖춰야 한다. `@kind`에는 단일 위치 문제인 `problem`, 경로를 보여주는 `path-problem`, extractor 진단용 `diagnostic`, 요약 metric용 `metric` 등이 있다.

## 3. `github/codeql` 저장소 구조

조사 기준 HEAD의 top-level tree는 언어별 디렉터리와 공통 모듈로 구성되어 있다.

주요 디렉터리:

| 경로 | 역할 |
|---|---|
| `cpp`, `csharp`, `go`, `java`, `javascript`, `python`, `ruby`, `rust`, `swift` | 언어별 extractor 관련 파일, library pack, query pack, suite, tests |
| `actions` | GitHub Actions workflow/action metadata 분석용 CodeQL 팩 |
| `shared`, `unified`, `config` | 공통 라이브러리, 설정, cross-pack 구성 |
| `ql` | QL 자체를 분석하는 "QL for QL" 실험적 분석 |
| `docs`, `change-notes` | 저장소 내부 문서와 변경 기록 |
| `codeql-workspace.yml` | 여러 CodeQL pack을 함께 개발하기 위한 workspace 설정 |

언어별 구조는 조금씩 다르지만 일반적으로 다음 패턴을 갖는다.

| 하위 경로 | 의미 |
|---|---|
| `ql/lib` | 언어별 CodeQL library pack. 예: `codeql/javascript-all` |
| `ql/src` | query pack. 예: `codeql/javascript-queries` |
| `ql/src/Security/CWE-*` | CWE별 보안 쿼리 묶음 |
| `ql/src/codeql-suites` | `*-code-scanning.qls`, `*-security-extended.qls`, `*-security-and-quality.qls` 등 suite |
| `extractor` | 언어별 extraction 관련 구성 또는 구현 |
| `config/suites` | suite 구성 |

예를 들어 조사 기준 HEAD에서 `javascript/ql/src/qlpack.yml`은 `codeql/javascript-queries` query pack이고, 기본 suite를 `codeql-suites/javascript-code-scanning.qls`로 지정한다. `javascript/ql/lib/qlpack.yml`은 `codeql/javascript-all` library pack이고, `codeql/dataflow`, `codeql/ssa`, `codeql/threat-models`, `codeql/yaml` 같은 공통 라이브러리에 의존한다. 또한 JavaScript library pack에는 framework/security model YAML을 주입하는 `dataExtensions`가 정의되어 있다.

이 구조가 의미하는 바는 명확하다. CodeQL의 "룰"은 단순 JSON 설정이 아니라, 언어별 semantic library 위에 작성된 재사용 가능한 프로그램이다.

## 4. 어디까지 분석 가능한가

### 4.1 지원 언어

공식 문서 기준 CodeQL은 다음 언어군을 지원한다.

| 언어군 | 비고 |
|---|---|
| C/C++ | C89-C23, C++98-C++23 일부. Objective-C, C++/CLI 등은 제외 |
| C# | C# 14, .NET Framework/Core/5-10 계열 |
| Go | Go 1.26까지 |
| Java/Kotlin | Java 7-26 빌드, Kotlin 1.8.0-2.3.2 |
| JavaScript/TypeScript | ECMAScript 2022 이하, TypeScript 2.6-5.9 |
| Python | Python 2.7, 3.5-3.13 |
| Ruby | Ruby 3.3까지 |
| Rust | 2021/2024 edition, nightly feature 제외 |
| Swift | Swift 5.4-6.3, host는 macOS 필요 |
| GitHub Actions | workflow YAML, action metadata YAML |

공식 문서는 PHP, Scala 등 목록에 없는 언어는 지원하지 않는다고 못 박고 있다. "파일은 읽을 수 있나"와 "정확한 언어 의미 분석을 지원하나"는 다르다.

### 4.2 지원 프레임워크와 라이브러리

CodeQL은 언어만 보는 것이 아니라 주요 프레임워크와 라이브러리 모델을 갖는다. 예를 들어 JavaScript/TypeScript 쪽에는 Express, Fastify, Koa, React, Vue, Nest.js, Electron, axios, node, SQL/DB client 등이 포함된다. Python 쪽에는 Django, FastAPI, Flask, Starlette, Tornado, requests/httpx, SQLAlchemy, Pydantic, PyYAML, 주요 DB driver 등이 있다. Java/Kotlin은 Spring MVC/JDBC, JPA, Hibernate, Jackson, MyBatis, JDBC 등을 모델링한다.

이 모델이 중요한 이유는 data flow 분석 때문이다. `req.body`가 source이고 `db.query`가 sink라는 사실은 언어 문법만으로 충분하지 않다. 프레임워크별 API 의미를 알아야 한다.

### 4.3 분석할 수 있는 질문의 범위

CodeQL이 잘하는 질문:

- 입력 검증 없이 user-controlled data가 SQL, shell, path, template, SSRF, deserialization sink로 흐르는가
- 암호화, random, TLS, cookie, header, CORS, redirect 같은 보안 API가 위험하게 사용되는가
- 특정 API가 deprecated 되었거나 조직 정책상 금지되었는가
- React/Vue/Angular template, server framework handler, DB driver 호출이 위험하게 조합되는가
- GitHub Actions workflow에서 shell injection, unsafe checkout, untrusted PR context, secrets exposure 위험이 있는가
- 특정 call graph, import graph, inheritance relation, decorator/annotation 사용 위치가 어디인가
- 같은 취약 패턴의 variant가 여러 저장소에 존재하는가

CodeQL이 애매하거나 약한 질문:

- 런타임 설정, DB 상태, 네트워크 응답, feature flag에 의존하는 동작
- reflection, dynamic import, monkey patching, metaprogramming이 많이 섞인 코드
- 소스가 없는 closed binary dependency 내부 동작
- extractor가 모르는 custom framework의 source/sink/sanitizer 의미
- build가 재현되지 않는 compiled language 프로젝트
- 타입 정보가 약하거나 generated code가 분석에 포함되지 않는 경우
- "좋은 설계인가" 같은 가치 판단 자체

정리하면 CodeQL은 "정확한 의미 그래프 위의 반복 가능한 질문"에 강하고, "실행해야만 알 수 있는 사실"에는 약하다.

## 5. 커스텀 룰 지정은 가능한가

가능하다. 수준별로 네 가지 선택지가 있다.

### 5.1 단일 `.ql` 쿼리

가장 작은 단위는 `.ql` 파일이다. 예를 들어 특정 함수 호출, 특정 import, 특정 데이터 흐름을 찾는 쿼리를 만든다. code scanning UI에 제대로 표시하려면 metadata를 붙인다.

개념 예시:

```ql
/**
 * @name Direct eval call
 * @description Finds direct calls to eval.
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

실무에서는 이 정도 쿼리도 `codeql test run` 또는 작은 test fixture로 검증해야 한다. CodeQL 쿼리는 프로그램이라서, 오탐/미탐과 성능 문제가 생긴다.

### 5.2 Query suite `.qls`

자주 같이 실행할 쿼리는 `.qls` suite로 묶는다. suite는 파일 위치, metadata, query id, tag, kind 등을 기준으로 쿼리를 선택하거나 제외할 수 있다.

GitHub의 built-in suite는 대표적으로 다음이 있다.

| suite | 의미 |
|---|---|
| `default` | 기본 code scanning 쿼리. 정밀도 우선 |
| `security-extended` | default + 더 넓은 보안 쿼리. 오탐 가능성 증가 |
| `security-and-quality` | security-extended + 유지보수성/신뢰성 쿼리 |

### 5.3 Query pack

조직이나 프로젝트에서 custom rule을 재사용하려면 query pack으로 만든다. `qlpack.yml`은 pack 이름, 버전, 의존 library pack, default suite를 정의한다.

예:

```yaml
name: my-org/ditto-js-queries
version: 0.0.1
dependencies:
  codeql/javascript-all: "*"
```

GitHub Actions advanced setup에서는 다음 식으로 pack을 추가할 수 있다.

```yaml
- uses: github/codeql-action/init@v4
  with:
    languages: javascript-typescript
    queries: security-extended
    packs: my-org/ditto-js-queries@0.0.1
```

또는 `.github/codeql/codeql-config.yml`에 query pack과 query file을 지정한다.

```yaml
packs:
  - my-org/ditto-js-queries@0.0.1

queries:
  - uses: ./codeql/custom

query-filters:
  - exclude:
      id: js/redundant-assignment
```

### 5.4 Model pack과 data extension

커스텀 룰보다 더 중요한 확장 방식이 model pack이다. 기존 쿼리의 source/sink/summary/barrier 모델을 확장해서 "우리 회사 프레임워크에서 어떤 함수가 request source인가", "이 sanitizer는 어떤 taint를 제거하는가", "이 wrapper 함수는 데이터 흐름을 어떻게 전달하는가"를 알려줄 수 있다.

공식 문서 기준 model pack은 public preview 성격이고, C/C++, C#, Java/Kotlin, Python, Ruby, Rust 분석에 지원된다. VS Code model editor는 C#, Java/Kotlin, Python, Ruby dependency modeling을 지원한다. Go 등 일부 언어는 data extension 문서가 따로 있고 source/sink/summary/barrier 모델을 YAML tuple로 확장한다.

실무 의미는 크다. custom framework가 많은 조직에서는 새 query를 무작정 쓰는 것보다, 먼저 내부 framework 모델을 잘 만드는 것이 standard query의 탐지력을 끌어올린다.

## 6. 알려진 활용 방법

### 6.1 GitHub code scanning

가장 일반적인 사용법이다. GitHub default setup은 언어와 기본 query suite를 자동 선택한다. advanced setup은 workflow 파일을 직접 관리하면서 build command, 언어, suite, query pack, model pack, paths, query filter를 조정한다.

### 6.2 외부 CI와 로컬 CLI

CodeQL CLI는 GitHub Actions 밖에서도 쓸 수 있다. 외부 CI에서 database를 만들고 `database analyze`로 SARIF를 만든 뒤 GitHub에 업로드할 수 있다. GitHub에 업로드하지 않고도 SARIF, CSV, BQRS 등을 내부 도구에 연결할 수 있다.

### 6.3 VS Code query development

CodeQL for VS Code 확장은 database 선택, query 실행, quick evaluation, result path 탐색, model editor, query test 개발에 쓰인다. 보안 연구자나 custom rule 작성자는 보통 이 경로로 시작한다.

### 6.4 Multi-repository variant analysis

MRVA는 VS Code에서 작성한 CodeQL query를 GitHub의 다수 저장소에 실행하는 방식이다. 공식 문서 기준 최대 1,000개 repository 목록에 대해 실행할 수 있고, GitHub Actions dynamic workflow를 통해 병렬 실행된다. 이미 하나의 취약 패턴을 발견한 뒤 "같은 variant가 다른 저장소에도 있는가"를 찾는 용도에 잘 맞는다.

## 7. 창의적 활용 아이디어

아래는 공식 기능을 바탕으로 한 활용 아이디어다. 바로 제품 기능으로 보장된다는 뜻은 아니며, custom query/model/test를 만들어 검증해야 한다.

### 7.1 아키텍처 정책 엔진

CodeQL을 보안 도구가 아니라 architecture lint로 쓸 수 있다.

예:

- `ui/**`가 `db/**`를 직접 import하면 실패
- CLI layer가 HTTP handler 내부 타입을 참조하면 실패
- domain model이 framework-specific decorator를 가지면 실패
- plugin runtime이 core state store를 직접 mutate하면 실패

ESLint로도 일부 가능하지만, CodeQL은 import path뿐 아니라 call graph, class hierarchy, annotation, data flow까지 엮어 볼 수 있다. "이 경계 밖으로 데이터가 실제로 흐르는가"를 확인할 수 있다는 점이 차이다.

### 7.2 Agentic coding guardrail

코딩 에이전트가 코드를 수정하는 저장소에서는 "리뷰어가 놓치기 쉬운 위험 패턴"을 CodeQL custom query로 고정할 수 있다.

예:

- shell command builder에 user prompt나 model output이 sanitizer 없이 들어가는 경로
- `danger-full-access`, `--yolo`, `bypass` 같은 권한 완화 옵션이 테스트/문서가 아닌 runtime path에서 활성화되는 위치
- hook, MCP, plugin 설정을 로드하면서 schema validation 없이 실행 경로로 넘기는 코드
- secret-like value를 로그/trace/telemetry sink로 보내는 경로
- `apply_patch`, `exec`, file write wrapper가 approval policy 확인 없이 호출되는 경로

이 저장소처럼 agent runtime/하네스 성격이 있는 프로젝트에서는 일반 SAST보다 이런 domain-specific query가 더 값질 수 있다.

### 7.3 LLM 코드리뷰의 근거 그래프

LLM 리뷰는 종종 파일을 많이 읽고도 정확한 call chain을 놓친다. CodeQL query 결과를 "근거 그래프"로 만들어 LLM에게 제공하면, 모델이 추측 대신 검증된 관계 위에서 리뷰할 수 있다.

활용 방식:

- 변경된 함수에서 도달 가능한 sink 목록 생성
- 변경된 타입을 사용하는 public API 목록 생성
- PR에서 새로 생긴 source-to-sink path만 추출
- alert가 아니라 "review context bundle"로 SARIF/BQRS를 변환

즉 CodeQL을 최종 보안 스캐너가 아니라 agent용 semantic retriever로 쓰는 방식이다.

### 7.4 Privacy/data lineage 검사

보안 sink를 DB나 shell에만 두지 않고, 개인정보/민감정보 흐름을 추적한다.

예:

- `email`, `phone`, `token`, `authorization`, `cookie` 계열 값이 analytics/log/metrics sink로 흐르는가
- user prompt가 external LLM provider call로 흐르기 전에 redaction을 거치는가
- 내부 trace 파일에 secret-like 값이 기록되는가
- local file content가 network call로 흐르는 경로가 있는가

이는 보통 DLP나 runtime logging 규칙으로 다루지만, CodeQL은 "코드상 가능한 흐름"을 사전에 잡는 데 유리하다.

### 7.5 Migration acceptance gate

대규모 API migration에서 "검색해서 바꾸기"의 마지막 10%를 CodeQL로 잡을 수 있다.

예:

- deprecated API가 wrapper를 통해 간접 호출되는 경로
- legacy config key가 runtime parser까지 살아 있는 경로
- old auth context가 new permission model을 우회하는 경로
- migration 후에도 old data model field가 serialization sink로 노출되는 경로

이런 query를 CI gate로 걸면 "마이그레이션 완료"를 정량화할 수 있다.

### 7.6 내부 framework model pack

조직 내부 프레임워크가 많으면, 매번 custom query를 늘리기보다 model pack을 먼저 만든다.

예:

- 내부 HTTP framework의 request source 모델
- 내부 ORM/query builder의 SQL sink 모델
- 내부 sanitizer/validator/barrier 모델
- 내부 job queue, RPC, event bus의 flow summary 모델

이렇게 하면 GitHub가 제공하는 표준 query도 내부 framework를 더 잘 이해하게 된다.

### 7.7 보안 사고 후 variant hunt

특정 취약점이 발견된 뒤, 같은 패턴이 다른 저장소/서비스에 있는지 찾는 데 CodeQL이 잘 맞는다. 하나의 incident-specific query를 만들고, MRVA나 조직 CI를 통해 여러 저장소에 실행한다. Semgrep보다 작성 난도는 높지만, data flow와 type-aware relation이 필요한 variant에는 더 강하다.

### 7.8 테스트 생성 타깃 찾기

CodeQL 자체는 coverage tool이 아니지만, coverage 결과와 결합하면 테스트 생성의 우선순위를 정할 수 있다.

예:

- public endpoint에서 DB write sink까지 가는 path 중 테스트가 없는 path
- error handling branch가 없는 external call wrapper
- sanitizer를 거치지 않는 입력 path 중 현재 alert는 아니지만 위험한 경계

LLM에게 "테스트를 써라"라고 하는 대신, CodeQL query로 테스트가 필요한 semantic path를 뽑아 줄 수 있다.

### 7.9 GitHub Actions 공급망 정책

CodeQL은 GitHub Actions workflow도 분석할 수 있다. 기본 쿼리 외에 조직 정책을 추가할 수 있다.

예:

- action version이 SHA로 pin되지 않은 경우
- `pull_request_target`에서 checkout 후 untrusted script를 실행하는 경우
- secrets가 노출될 수 있는 env forwarding
- self-hosted runner label과 untrusted trigger 조합
- release workflow에서 provenance/signing step이 빠진 경우

이는 일반 애플리케이션 코드보다 조직 보안 효과가 클 수 있다. workflow는 권한과 secret이 집중되는 경계이기 때문이다.

### 7.10 코드베이스 질의 API

CodeQL database를 "보안 스캔 산출물"이 아니라 "코드베이스 질의 API"로 보면 다른 응용이 열린다.

예:

- "이 config key를 읽는 모든 runtime path" 질의
- "이 command가 실제로 쓰는 file write sink" 질의
- "이 MCP tool schema가 도달하는 handler와 permission check" 질의
- "이 public API가 transitively 의존하는 package set" 질의

정적 분석 결과를 Markdown report, PR bot comment, architecture dashboard, agent memory로 변환할 수 있다.

### 7.11 BPMN/Camunda 프로세스 실행기 분석

BPMN 기반 프로세스 실행기는 일반 코드와 다른 "실행 그래프"를 갖는다. Camunda 7.24 기준으로 BPMN XML은 `org.camunda.bpm.model.bpmn`의 BPMN Model API로 파싱할 수 있고, `BpmnModelInstance`는 BPMN 2.0 모델을 나타낸다. 따라서 CodeQL식 접근을 그대로 빌리면 `BPMN XML -> process graph -> query/rule -> report` 구조를 만들 수 있다.

단, BPMN 해석기만 붙이는 것으로는 충분하지 않다. 실무 가치는 BPMN 그래프를 Java/Spring delegate, external task worker, DMN, form, process variable read/write 지점과 연결할 때 커진다.

분석할 수 있는 질문:

- 도달 불가능한 task/event, 종료 이벤트 없는 경로, gateway split/join 불균형이 있는가
- timer/error/escalation boundary event가 필요한 장기 user task나 service task에 누락되어 있는가
- `asyncBefore`, `asyncAfter`, retry, compensation, multi-instance 설정이 운영 실패를 키우는 방식으로 조합되어 있는가
- `camunda:class`, `delegateExpression`, `expression`, listener, script task, connector가 어떤 코드 또는 외부 호출로 이어지는가
- external task `topic`은 있는데 worker 구현이 없거나, worker는 있는데 BPMN에서 참조되지 않는가
- process variable이 validation 없이 결제, 승인, SQL, HTTP, file, log, LLM 호출 sink까지 흐르는가
- exclusive gateway condition이 중복, 누락, 순서 의존, 기본 경로 부재 같은 위험을 갖는가
- subprocess 내부 business error가 상위 프로세스에서 catch되지 않고 incident로만 떨어지는가

권장 구현은 CodeQL 자체에 BPMN 언어를 억지로 넣기보다, BPMN 전용 analyzer를 만들고 Java/TypeScript 쪽 CodeQL 결과와 조인하는 방식이다.

```text
BPMN XML
  -> Camunda BPMN Model API
  -> Process graph
       nodes: start, task, gateway, event, subprocess
       edges: sequenceFlow, message, error, escalation, compensation
       metadata: delegate, expression, topic, variable mapping
  -> CodeQL / Java parser / runtime inventory
  -> Cross-reference graph
       BPMN task -> Java delegate / Spring bean / external topic handler
       process variable -> read/write site
       process path -> security or reliability sink
  -> custom rules and reports
```

이 방식은 보안 SAST보다 넓다. 프로세스 운영 리스크, 누락된 worker, 쓸모없는 delegate, migration 영향 범위, 특정 업무 경로에서만 발생하는 권한/검증 누락까지 확인할 수 있다. BPMN을 "문서"가 아니라 "실행 가능한 정책 그래프"로 취급하는 활용이다.

## 8. 실무 도입 판단

CodeQL은 다음 조건에서 도입 가치가 높다.

- 저장소가 지원 언어군에 들어간다.
- 취약점/정책/아키텍처 규칙을 semantic relation으로 표현할 수 있다.
- false positive를 triage할 사람이 있거나, query precision을 조정할 시간이 있다.
- custom framework가 있다면 model pack을 만들 수 있다.
- CI에서 build 재현성이 확보된다.

반대로 다음 목적에는 맞지 않다.

- 임의 언어를 빠르게 grep하듯 검사
- runtime exploitability를 단독 판정
- dependency CVE 관리를 대체
- formatter/linter 수준의 단순 style rule만 대량 집행
- source가 거의 없고 generated/binary dependency가 대부분인 시스템 분석

이 저장소 `ditto` 관점에서 시작한다면 가장 현실적인 순서는 다음이다.

1. GitHub Actions workflow 분석과 JavaScript/TypeScript 분석을 켠다.
2. 기본 suite는 `security-extended`까지 사용하고, noise가 크면 query filter로 줄인다.
3. agent runtime 특화 custom query 후보를 3-5개만 만든다. 예: 권한 우회 옵션, shell/file write sink, hook/plugin schema validation 누락.
4. 커스텀 쿼리는 query pack으로 묶고 `qltest` fixture를 둔다.
5. 모델/데이터 흐름이 부족한 내부 abstraction이 발견되면 query를 늘리기 전에 model/data extension을 검토한다.

## 9. 결론

CodeQL의 본질은 "코드 검색기"가 아니라 **코드 의미 그래프에 대한 재사용 가능한 질의 시스템**이다. 알려진 보안 취약점 탐지뿐 아니라, 조직별 아키텍처 규칙, agent runtime trust boundary, 개인정보 흐름, workflow 공급망 정책, migration 완료 기준, LLM 리뷰 근거 생성에 활용할 수 있다.

도입의 핵심은 query 수를 많이 늘리는 것이 아니다. 먼저 다음 질문을 골라야 한다.

- 우리가 반복해서 놓치는 위험은 무엇인가
- 그 위험이 AST, call graph, data flow, type relation으로 표현 가능한가
- custom framework 의미를 CodeQL에 알려줄 source/sink/summary/barrier 모델이 필요한가
- 결과를 alert로 막을 것인가, report/context로 활용할 것인가

이 질문에 답할 수 있으면 CodeQL은 단순 SAST를 넘어 "코드베이스에 대한 검증 가능한 지식층"으로 쓸 수 있다.

## 참고 자료

- GitHub `github/codeql` repository: https://github.com/github/codeql
- GitHub CodeQL repository tree at 조사 기준 HEAD: https://github.com/github/codeql/tree/a16f1c555cea339ef5c8b4c7c9285b6e578c396c
- CodeQL overview, About CodeQL: https://codeql.github.com/docs/codeql-overview/about-codeql/
- Supported languages and frameworks: https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/
- System requirements: https://codeql.github.com/docs/codeql-overview/system-requirements/
- About code scanning with CodeQL: https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/codeql/about-code-scanning-with-codeql
- About the CodeQL CLI: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-the-codeql-cli
- CodeQL code scanning for compiled languages: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-codeql-code-scanning-for-compiled-languages
- Custom CodeQL queries: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/custom-codeql-queries
- Creating and working with CodeQL packs: https://docs.github.com/en/code-security/tutorials/customize-code-scanning/creating-and-working-with-codeql-packs
- Workflow configuration options for code scanning: https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/workflow-configuration-options
- Using the CodeQL model editor: https://docs.github.com/en/enterprise-server@3.21/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-vs-code/using-the-codeql-model-editor
- Customizing library models for Go: https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-go/
- Multi-repository variant analysis: https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/multi-repository-variant-analysis
- Camunda 7.24 BPMN Model API Javadoc: https://docs.camunda.org/javadoc/camunda-bpm-platform/7.24/org/camunda/bpm/model/bpmn/package-summary.html
- Camunda 7.24 REST API, process definition XML: https://docs.camunda.org/manual/develop/reference/rest/specification/
