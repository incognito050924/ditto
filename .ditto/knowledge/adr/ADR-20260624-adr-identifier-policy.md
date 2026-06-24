# ADR-20260624-adr-identifier-policy: ADR 식별자 = 불변 파일명 (ADR-YYYYMMDD-slug) — 순차번호·uid 폐기

- 상태: accepted
- 결정 일자: 2026-06-24
- 결정자: hskim, claude (claude-opus-4-8)

## 컨텍스트

ADR 번호(`ADR-NNNN`)는 동시 개발에서 충돌한다 — 다른 브랜치가 같은 번호를 찍어도 slug가 다르면 파일명이 달라져 git 머지가 충돌을 안 낸다(두 ADR이 같은 `ADR-0026`을 들고 조용히 공존). 기존엔 자동 번호 할당·식별자 유니크성·index↔file 정합 검사가 전무했다 — 번호는 사람이 마지막 번호를 눈으로 보고 손으로 +1 했고, 어긋나도 잡아낼 게이트가 없었다.

## 결정

새 ADR의 식별자는 파일명 `ADR-YYYYMMDD-<slug>.md` **전체**다(불변, bare 순차번호·별도 uid 없음). `superseded_by`·관련 ADR 링크 등 모든 참조는 이 파일명 ID를 가리킨다.

- 생성: `ditto knowledge adr-new --slug=<slug>` 가 오늘 날짜로 스켈레톤을 만든다.
- 정합: `ditto knowledge adr-check` 가 형식 + 식별자 유니크성 + index↔file 일관성을 검사(fail-closed). CI/pre-merge 게이트로 권장.
- 기존 `ADR-NNNN-<slug>.md` 는 grandfather — rename 금지, 스키마가 legacy ∪ new 식별자를 동시 수용한다.

## 근거 (rationale)

충돌 시 renumber는 그 ADR을 가리키는 *모든 참조를 전수 고쳐쓰기* 를 요구한다. 그런데 참조는 코드 주석·문서·git 커밋 메시지(불변)·외부 산출물에 무한정 퍼져 있어 빠짐없이 고치는 게 불가능하다. 그래서 뒤처리(renumber)를 관리하는 대신, 식별자를 **생성 시점에 불변·충돌내성으로 파일명에 박아 renumber 자체를 없앤다.**

이 설계에서 진짜 충돌(같은 날짜 + 같은 slug)은 *동일 파일명* 이 되어 git add/add 충돌로 감지된다 — 원래 새던 '같은 번호·다른 slug' 구멍이 닫힌다. 감지 백스톱은 `adr-check`(CI).

기각된 대안:
- **opaque-uid-only** — 파일명만으로 무엇에 대한 결정인지 못 읽어 가독성 상실.
- **uid + seq 분리** — uid가 파일을 열어야 보여 비직관적이고, 여전히 seq renumber가 필요해 충돌 문제를 못 푼다.
- **기존 파일 rename** — 바로 그 전수-수정 재앙(코드·문서·커밋 메시지의 모든 참조)을 유발하므로 grandfather로 보존.

## 변경 조건 (change_condition)

- 중앙 조정점(ADR 번호 레지스트리/서비스)이 생겨 번호 충돌을 생성 시점에 막을 수 있으면 순차번호 재고 가능.
- 파일명 가독성이 실사용에서 문제되면(slug 길이·중복) slug 규약 재검토.
- cross-branch 사전 감지가 요구되면 pre-merge CI에서 `adr-check` 강제를 표준화.
