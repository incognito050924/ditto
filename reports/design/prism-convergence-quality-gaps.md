# prism 수렴-품질 갭 & 개선 설계

**성격**: 설계/조사 보고서 (drift 주의 — 권위는 코드: `src/core/prism/*`, `skills/prism/SKILL.md`).
**출처**: wi_260707oi1 prism 재설계의 ac-9 라이브 실증 세션 (2026-07-08). 데모 vehicle = "playwright agent E2E 작성 표면" 요청(WI `wi_260708ort`)을 prism으로 정련하며 사용자가 실사용 중 갭을 포착.
**소비자**: prism 개선 작업(후속 WI) + 철학적 접근 연구 보고서의 문제 정의.

---

## 근본 진단 — 수렴-품질 가드의 비대칭

prism은 **과잉-사고(divergence)를 막는 가드는 강한데, 과소-사고(premature convergence)를 막는 가드가 없다.**

- 있는 것(발산 방지): `detectDivergence`(engine.ts:281)가 3 shape(쳇바퀴 repeat_question · trivial_streak · decided_conflict_no_evidence)를 **결정적**(무모델)으로 감지 + `capStatus`(coverage-manager.ts:770) 노드/이벤트/라운드 cap이 스핀을 정지. 종결술어 `criticalTermination`(engine.ts:142)는 critical 전수 해소 시에만 착수 판정(0-critical 공허참 가드).
- 없는 것(과소수렴 방지): 어려운 노드를 얕게 닫음 / 프레임 드리프트 / 원-의도 미달 커버리지 — **전부 무방비.**

아래 3갭이 모두 이 한쪽 날개다. **개선 방향 = divergence 가드에 대칭되는 "수렴 품질" 가드.**

---

## 갭① 조기-종결(premature-closure) 가드 부재

**증상**: critical/net-new/고불확실 노드를 얕은 `close_reason`으로 조기 종결해도 아무것도 막지 않는다.
**라이브 증거**: 오퍼레이터가 "화면-기반 관측 저작"(net-new 코어, critical)을 **"관측 단계만 net-new"** 한 줄로 종결 → 코어가 빈 설계 문서 산출. 사용자가 "왜 바로 끝났냐, 하위 질문이 이어져야 하지 않냐"로 포착.
**비대칭의 핵심**: `detectDivergence`는 over-ask를 잡지만, 그 반대(under-ask, hand-wave close)는 안 잡는다.
**코드 훅**: `closePrismNode`(engine.ts:90)는 이미 *모름-닫기(critical)에 residual_risk 필수* 게이트를 가짐 — 대칭 규칙을 여기 붙이면 된다.
**개선 설계(결정적)**: critical 노드를 **leaf 상태로 `resolved` 종결**하려면 → 하위 질문 ≥1개 분해(children 존재) 또는 `--atomic "<사유>"` 명시 증명("하위 결정 없는 원자적 사실") 필수; 둘 다 없으면 거부.
- severity + 트리 leaf 여부만 봄(모델 호출 0). 기존 residual_risk 게이트와 동형.
- 트레이드오프: 진짜 원자 critical("playwright agent가 뭐냐")엔 과발동 → `--atomic` 탈출구가 받되 **로그에 남아** 가시화(조용한 종결 → 명시적·감사가능 선택).
**추적**: wi_260707oi1 follow-up idea (조기-종결 가드).

## 갭② 원-의도 앵커 드리프트

**증상**: root `original intent` 노드가 있어도 하위 노드가 그것을 *달성*하는지 강제하는 게 없어, 이해-먼저의 중복/차별점 검사가 프레임을 하이재킹해 "무엇이 다른가"가 "어떻게 만드나(원 의도의 HOW)"를 밀어낸다.
**라이브 증거**: 최초 의도 = "playwright agent E2E 작성 표면 추가"였으나, 첫 seed critical이 "e2e-author와 뭐가 다른가"(차별점 프레임)라 인터뷰가 포지셔닝으로 흘렀고, 설계 문서가 차별점만 담고 **저작 HOW가 빔**. 사용자가 "최초 의도 달성 어떻게가 빠졌다"로 포착.
**개선 설계**:
- (a) **종결-시점 재앵커(결정적·싸다)**: 착수 알림이 뜨는 순간 원 의도 원문을 다시 띄우고 "이 맵이 이걸 *달성*하나, *특징짓기*만 했나?"를 결정 지점에서 강제 대면. 자동 검출은 아니나 드리프트를 가시화.
- (b) **intent-completeness critic(모델-보조·강함)**: prism 이슈맵은 coverage-manager를 재사용하며 트리 CRUD·종료술어만 가져오고 **coverage가 이미 가진 completeness critic(loop-until-dry, "뭘 빠뜨렸나")은 안 물려받았다**. 이식하면 종결 전 "맵이 원 의도의 HOW를 덮나"를 되묻는다. divergence(순수·무모델)와 구분되는 새 클래스.
**추적**: wi_260707oi1 follow-up idea (앵커 드리프트).

## 갭③ 질문-트리 관측성 부재

**증상**: prism이 트리·타이밍·해소사유를 다 기록(`issue-map.json` 트리 + `question-rounds.jsonl` 타임스탬프 + 노드별 close_reason/residual)하지만, **이걸 보여주는 사용자용 CLI가 없다** — `summary`/`status`는 label-only(ac-3) 최소뷰.
**라이브 증거**: 사용자가 "질문 트리 전체(무엇을·언제·어떻게 해소)"를 요구 → 오퍼레이터가 Record-tier 파일을 직접 파서 재구성.
**개선 설계(가장 싼 승리)**: `ditto prism tree --wi <wi>` 신설(오퍼레이터 read 명령) — 트리 구조 + 추가-라운드/시각 + 해소 사유를 렌더. 사용자-표면은 label-only 유지, 트리 뷰는 오퍼레이터/`--verbose`용. 순수 조회, 신규 로직 0.
**추적**: wi_260707oi1 follow-up idea (관측성).

---

## 권고 시퀀스 (최소증분 순)

1. **갭③ `prism tree`** — 조회만, 위험 0, 즉효.
2. **갭① close 게이트** — 기존 residual 게이트 확장, 결정적, 대칭. (핵심 가치)
3. **갭② (a) 종결 재앵커** — 결정적, 싸다.
4. **갭② (b) intent-completeness critic** — 모델-보조, 후속.

## 열린 연구 질문 (→ 별도 연구 보고서)

위 (a)/(b)와 close 게이트의 "얕음" 판정은 결정적 휴리스틱을 넘어 **더 원리적인 토대**가 필요할 수 있다. 문제를 어떻게 정의·구조화·확장하고, 언제 "충분히 이해했다"고 판정하는가 — 이는 탐구(inquiry)의 인식론적 문제다. 후속 연구에서 검토: 변증법적 방법, 베이즈주의 인식론, 사회 인식론, 그 외 문제-구조화 방법론(IBIS·dialectical inquiring systems 등)이 prism의 수렴-품질 가드에 어떤 개념을 주는가.
