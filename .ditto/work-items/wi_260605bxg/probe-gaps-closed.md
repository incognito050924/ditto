# boxwood probe — 검증 못한 것·위험 해소 (wi_260605bxw 후속)

> wi_260605bxw(probe)의 completion에 남긴 unverified·risk를 evidence로 닫음. boxwood read-only, ditto src 무변경.

## gap#3 (risk: N=1 → 다수 심볼) — 해소
단일모듈 DB에서 **이름이 소스 내 유일한 메서드 348개**에 resolved-callee impact 쿼리(`probe/nmany.ql`)를 실행, distinctive 다단어 이름들의 DB caller 수를 grep 호출부와 대조.
- distinctive 이름은 DB==grep 일치(extractRequesterName 6/6, filterVariableInstanceByState 7/7, sendNotificationInternal 6/6, executeWithTimeout 6/6, formatTimestamp 5/5, … 50+건).
- **모든 불일치는 grep 오라클 한계이고 DB가 더 정밀**(직접 추적 확인):
  - `convertDeploymentToMap` DB2/grep0 → 2 caller가 **메서드 레퍼런스** `Helper::convertDeploymentToMap`(grep `(`패턴이 못 봄). DB가 더 완전.
  - `startProcess` DB2/grep4 → grep4는 전부 Camunda 라이브러리 `startProcessInstanceByKey`/클래스명. DB가 라이브러리 동명 정확 제외.
  - `removeFollowingSlashes` DB2/grep6 → grep6 중 5는 **javadoc 예시 주석**. DB는 실사용 2.
  - `emptyMap` DB6/grep18 → grep18은 `Collections.emptyMap()` 등 라이브러리 호출 포함. DB는 소스 메서드 호출 6만.
  - `$default$*` 25건 → Lombok/synthetic 생성 메서드(소스 텍스트 없음) → grep 불가, DB는 생성 호출 포착.
- **결론**: resolved-callee 정밀도가 스케일(348 심볼)에서 유지. N=1보다 강함 — 메서드 레퍼런스(`::`)까지 잡고 라이브러리 동명을 배제. 불일치 0건이 DB 오류, 전부 grep 오라클 noise.

## unverified#2 (멀티모듈 cross-module 의존) — 해소
형제모듈 소스(`boxwood-packages/boxwood-domain-model`)를 포함해 source-root=workspace 전체로 **멀티모듈 reactor DB**(buildless) 빌드.
- 단일모듈 DB에서 JAR로 빠졌던 2개 타입이 멀티모듈에서 **source로 해소**:
  - `Requester` → `boxwood-packages/boxwood-domain-model/.../domain/automation/dto/Requester.java`
  - `StructuredErrorInfo` → `.../domain/runtime/processing/StructuredErrorInfo.java`
- BoxwoodHistoryEventHandler 엣지: 단일모듈 **10** → 멀티모듈 **12**(cross-module 2개 추가).
- **결론**: 바인딩은 (a) 멀티모듈 reactor DB로 cross-module 의존을 source 엣지로 잡거나 (b) 단일모듈이면 `ImpactGraph.unresolved: cross_repo`로 기록. 양쪽 다 실증됨 → 스펙의 cross_repo 설계가 실제로 동작.

## unverified#1 (taint/dataflow buildless 충분성) — 판정으로 해소
buildless DB에서 taint 역량·실제 쿼리 측정(`probe/taintcap.ql` + SqlTainted 실행).
- **taint 인프라 동작**: RemoteFlowSource **182개** 인식(javax/spring 등 번들 라이브러리 모델이 DB와 무관하게 부착), 미해소 호출 202/~1만(소수). SqlTainted(CWE-089) 쿼리 **완료**.
- **단, 의존 경계에서 불완전**: codeql 진단 "Fetching a dependency jar failed", "classpath inferred from used external package names" → 미해소 로컬 JAR(boxwood-domain-model 등)·미패치 의존을 지나는 taint flow는 누락 가능. SqlTainted 0건은 "취약점 없음"과 "불완전 누락"을 단독으로 구분 못 함.
- **판정**: impact/boundary(call/type 관계)는 buildless로 **충분**(라이브러리 dataflow 모델 불필요, 광범위 검증됨). **security taint fitness는 usable-but-bounded → 정밀도 필요 시 autobuild(실 classpath) 권장.** 이는 ditto codeql doctor가 컴파일언어에 대해 이미 강제하는 build 재현성 게이트와 **정합** — 설계가 이 한계를 이미 처리.

## risk: /tmp 휘발성 — 재현성으로 완화
이 세션에서 단일모듈·멀티모듈 DB를 **모두 처음부터 재빌드**(buildless ~50s/~수분)해 재현성 자체를 실증. DB는 69M/1.1G로 커밋 부적합 → `probe/*.ql` + 절차만 보존, DB는 on-demand 재생성. 완화됨(미해결 결함 아님).

## 범위 밖 — leak#1(쿼리 본문 JS 하드코딩) 수정
이는 진단이 아니라 **정식 바인딩 구현**(relations.ts 쿼리를 언어별 템플릿화 + Java용 CodeqlImpact/EdgeAnalyzer 배선 + 테스트)으로, 직전에 사용자가 "probe"로 선택하며 deferred한 더 큰 범위다. 본 gap-closure는 probe의 evidence 공백만 닫으며, leak#1 수정은 사용자 확인 후 별도 work item.

## 재현 (CodeQL 설치 후)
```bash
# 단일모듈
codeql database create /tmp/db --language=java --build-mode=none \
  --source-root=<workspace>/automation-engine --overwrite
codeql query run --database=/tmp/db probe/nmany.ql      # N=many
codeql query run --database=/tmp/db probe/taintcap.ql   # taint 역량
# 멀티모듈
codeql database create /tmp/mdb --language=java --build-mode=none \
  --source-root=<workspace> --overwrite
codeql query run --database=/tmp/mdb ../wi_260605bxw/probe/edge-java.ql  # cross-module 해소
```
