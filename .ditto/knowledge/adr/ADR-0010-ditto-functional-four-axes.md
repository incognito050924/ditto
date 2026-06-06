# ADR-0010: DITTO 기능 4축 정식화 — 목적 기둥 canonical 정의 + 경계 + 기층과의 관계

- 상태: accepted (결정 = 기능 4축을 canonical로 정식화. 두 층위 모델 명문화)
- 결정 일자: 2026-06-06
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: `reports/design/ditto-four-axis-reassessment.md`(재평가·재설계 정정판), `reports/design/ditto-claude-code-harness-design.md` §4.1(기층 4축 OMC 차용 출처), `reports/design/ditto-install-distribution-record.md` §2.6(축2 boxwood autopilot 실증), wi_260606e43

## 컨텍스트

DITTO에는 그동안 "4축"이라는 어휘가 두 가지 다른 뜻으로 쓰여 혼선이 있었다.

- 하나는 **Hooks/Skills/Agents/State** — Claude Code 하네스(OMC) 분석에서 차용한 구현 substrate(`ditto-claude-code-harness-design.md §4.1`).
- 다른 하나는 사용자가 의도하는 **DITTO가 사용자를 위해 무엇을 하는가** — 목적 기둥.

기존 재평가 문서(`ditto-four-axis-reassessment.md`)는 전자(substrate)를 "4축"으로 잡았는데, 이는 **DITTO의 목적 기둥이 아니라 그것을 떠받치는 아래 레이어**다. 이 ADR은 사용자가 정의한 **기능 4축(목적 기둥)을 canonical로 박고**, substrate를 그 아래 **기층 4축**으로 위치시킨다.

## 결정

### D1 — 기능 4축(canonical) 정의

DITTO의 목적 기둥은 다음 4축이며, 완전 순차 파이프라인 **1 → 2 → 3 → 4**로 동작한다.

1. **사용자 의도 파악 및 동기화** — 사용자 요청을 모든 방향·관점의 변증론적·경계 질문을 반복해 사용자 스스로도 인지 못한/놓친 부분까지 드러내고, 사용자 이해 수준과 완전히 일치할 때까지 인터뷰해 산출물을 작성한다.
2. **자율 실행 오케스트레이션** — 사용자 의도를 스스로 구체화해 실제 코드베이스를 만들어 나간다(의도 왜곡 없이, 대규모·장시간이라도 본래 목적을 잃지 않고 끝까지).
3. **E2E 테스트** — 사용자 의도대로, 최초 계획대로 구현됐는지 확인한다.
4. **지식 베이스** — 매 변경마다 추가·변경된 코드베이스·컨텍스트를 문서화해 단편적 사고에서 프로젝트 메모리를 획득, 진짜 지능으로 재탄생한다.

### D2 — 확정된 경계 4개

- **(a) 축3 범위** — 축3은 진짜 브라우저 E2E only다. 웹 UI 없는 프로젝트(라이브러리·CLI·도메인 모델)는 축3 N/A이며, 다른 축이 커버한다.
- **(b) 축4 발동 정책** — 축4는 가치 있는 durable 변경만 기록한다(에이전트 판단: ADR감 결정·용어·반복 패턴). 매 변경 자동 강제가 아니다.
- **(c) 축1 종료 조건** — 시스템 readiness 게이트(1차)와 사용자 확인(2차)이 둘 다 필요하다. 한쪽만으로 종료하지 않는다.
- **(d) 파이프라인 형태** — 4축은 완전 순차 파이프라인 1 → 2 → 3 → 4다.

### D3 — 기층 4축과의 관계 (두 층위 모델)

- **기능 4축**(D1) = DITTO가 사용자를 위해 무엇을 하는가(목적 기둥). canonical.
- **기층 4축**(Hooks/Skills/Agents/State) = 그 기능 4축을 타겟에서 살아있게 배달하는 구현 substrate. OMC 하네스 차용(`ditto-claude-code-harness-design.md §4.1`). 기능 4축이 **아니라** 그 아래 레이어다.
- **매핑**: 각 기능 축은 (Skill+Agent)로 노출되고, (CLI+State)로 동작하고, (Hook)으로 트리거된다.
  - 축1 = deep-interview skill
  - 축2 = autopilot skill
  - 축3 = e2e skill
  - 축4 = knowledge-update skill

## 대안 (기각)

- **substrate(Hooks/Skills/Agents/State)를 그대로 "4축"으로 유지**: 목적과 구현을 한 층위로 뭉개 사용자 의도(무엇을 하는가)를 가린다. 기능/기층 분리가 두 어휘 충돌을 해소한다. 기각.
- **경계를 열어둔 채 정식화**: 축3의 브라우저 한정·축4의 자동강제 여부·축1 종료 조건이 모호하면 구현이 갈린다. deep-interview에서 확정한 (a)~(d)를 같이 박는다. 기각.

## 변경 조건 (이 ADR을 다시 열 때)

- 기능 축의 정의 자체가 사용자 합의로 바뀌면(예: 축3 범위를 브라우저 외로 확장, 또는 파이프라인을 비순차로 허용) 해당 축·경계만 재개정한다.
- 기층 4축이 새 substrate(예: 다른 하네스)로 교체되면 D3 매핑만 갱신한다 — 기능 4축은 substrate-agnostic이므로 영향받지 않는다.
