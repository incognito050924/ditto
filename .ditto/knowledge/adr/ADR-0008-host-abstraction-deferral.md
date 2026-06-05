# ADR-0008: 호스트-추상 기계 보류 — provider 슬롯이 이미 stack-agnostic

- 상태: accepted (결정 = 보류. 빌드 아님 — 열린 아키텍처 질문을 닫음)
- 결정 일자: 2026-06-05
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0006 (분석 엔진 CodeQL 통일·analyzer 바인딩 패턴), `src/core/hosts/types.ts`(HostAdapter), `src/acg/impact/impact-graph.ts`·`src/acg/boundary/boundary.ts`(Analyzer 인터페이스), `src/core/codeql/relations.ts`·`signature-codeql.ts`(언어별 쿼리 바인딩), wi_260605dh1, 선행 실증 wi_260605ml1(A — 다언어 signature 바인딩)

## 컨텍스트

여러 세션의 핸드오프가 "provider-슬롯(analyzer 주입) 위에 추가 호스트-추상 계층을 둘지"를 열린 질문(D/C)으로 이월해 왔다. 이 ADR은 그 질문을 **결정으로 닫는다**(빌드 아님).

현재 두 추상 축이 **이미** 분리돼 있다:

- **에이전트 호스트 축** — `HostAdapter`(`src/core/hosts/types.ts:126`)가 spawn/capabilities를 추상해 claude-code / codex를 교체 가능하게 한다.
- **분석 제공자 축** — 거버넌스 코어(`buildImpactGraph`, `checkBoundary`, fitness delta)는 `ImpactAnalyzer`/`EdgeAnalyzer` 인터페이스 뒤에서 분석기를 모른다(ADR-0006). 구체 분석은 언어별 CodeQL 쿼리 바인딩(`RELATION_QUERIES`, `SIGNATURE_QUERIES`)이 deps 주입(`makeRelationDeps`)으로 꽂힌다.

질문은 이 둘 위에 **또 하나의** 호스트-추상 계층(예: 분석 제공자와 에이전트 호스트를 통합 추상하는 상위 기계)을 둘지다.

## 결정

### D1 — 추가 호스트-추상 계층을 보류한다

추가 계층을 두지 않는다. 근거:

- **provider 슬롯이 이미 stack-agnostic이고 load-bearing이다.** wi_260605ml1(A)이 java/kotlin/python signature 바인딩을 추가할 때 `signature-codeql.ts`에 쿼리 상수 추가 + `SIGNATURE_QUERIES` 등록만으로 끝났다 — **거버넌스 코어 변경 0**(커밋 cd26c30). 새 스택이 순수 가산으로 들어온다는 것이 기존 추상이 비용을 견딘다는 실증이다.
- **추가 계층은 단일사용·얕은 추상화다.** 그것을 요구하는 두 번째 소비처가 아직 없다. 인터페이스만 넓고 구현이 얕은 추상은 헌장 4-3이 경고하는 바로 그 비용(한 줄 규칙 변경으로 될 일을 프레임워크로 만들기).
- **두 축은 이미 올바르게 분리됐다.** 에이전트 호스트(HostAdapter)와 분석 제공자(Analyzer 슬롯)는 서로 다른 변경 이유를 가지므로 별도 경계가 맞다. 이 둘을 한 기계로 묶으면 결합도만 올린다.

### D2 — 새 스택/제공자는 기존 슬롯에 바인딩으로 추가한다

다언어 확장은 상위 추상이 아니라 기존 패턴(쿼리 상수 + 언어 등록, 미바인딩 fail-loud)으로 흡수한다. ADR-0006의 "바인딩이 분석기를 꽂는다"가 유효한 메커니즘이다.

## 대안 (기각)

- **provider 슬롯 위 통합 호스트-추상 기계를 지금 빌드**: 두 번째 소비처 부재 + A의 가산성 실증이 필요 없음을 보여줌. 조기 추상화. 기각(forbidden scope — 핸드오프가 명시 경고).
- **HostAdapter와 Analyzer 슬롯을 하나로 병합**: 서로 다른 변경 이유를 가진 두 축을 결합. 기각.

## 변경 조건 (이 ADR을 다시 열 때)

- **비-CodeQL 분석 제공자**가 필요해지면(예: 결정론 추출을 못 하는 스택, 또는 CodeQL 외 엔진) — 현 Analyzer 슬롯이 CodeQL deps 형태에 결합돼 있는지 재검토.
- **spawn 형태가 아닌 에이전트 호스트**가 등장해 HostAdapter가 표현 못 하면 — 호스트 축 추상 재설계.
- **≥2개 바인딩 구현에서 실제 중복**이 생겨 상위 추상이 그 중복을 제거(추측이 아니라 실측)하면 — 그때 최소 추상 도입. 그 전까지는 가산 바인딩 유지.
