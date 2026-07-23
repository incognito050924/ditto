# ADR-20260723-handoff-publication-object-gate: 핸드오프 push의 "공개" 판정 = 신규-객체 전송 기준 — 삭제-전용 push 무동의 예외(신원 마스킹 재발행) + 프로젝트당 1회 write-push 동의

- 상태: accepted
- 결정 일자: 2026-07-23
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-20260722-handoff-hidden-ref-baton (**REFINE — supersede 아님.** 그 ADR의 저장 모델(숨은 ref `refs/ditto/handoffs`·first-consumer-wins CAS·`refs/ditto/*` 한정 push 상시허가)은 전부 불변이다. 이 ADR은 public/unknown-visibility 원격에 대한 push 가시성 게이트에서 "무엇이 공개인가"의 판정 기준과 동의 표면만 정밀화한다), 헌장 §4-8 (push = user-gated 비가역 — 아래 삭제-전용 예외와 standing consent는 그 게이트 위의 정밀화다). 촉발 WI: wi_2607239vu (2026-07-23).

## 컨텍스트

ADR-20260722-handoff-hidden-ref-baton은 핸드오프를 숨은 ref에 저장하고 `refs/ditto/*` 한정 push 상시허가를 기록했다. 그 위에 세워진 가시성 게이트는 public/unknown-visibility 원격으로의 핸드오프 push를 기본 거부하고 `--push-public` one-shot opt-in만 열어두었는데, 실사용(wi_2607239vu)에서 이 게이트의 판정 단위가 거친 것이 드러났다:

- **소비(consume)는 내용상 삭제인데도 push가 막힌다.** 소비는 읽은 뒤 삭제 기록을 쌓는 행위라 원격에 새 내용을 올리지 않지만, 게이트가 이를 구분하지 못해 1회 소비로 삭제되어야 할 인수인계 기록이 public 원격에 잔류한다.
- **명령 종류로 판정하면 틀린다.** `op === 'consume'`이라는 사실은 삭제-전용의 증거가 아니다 — tree reconciliation이 아직 push되지 않은 로컬 write 엔트리를 consume tip 위에 다시 얹을 수 있어, consume 명령의 전송 집합에 신규 본문이 실릴 수 있다.
- **매 write마다 물으면 standing 허가의 의미가 없다.** public/unknown 원격에 계속 쓰기로 한 사용자에게 매번 one-shot 확인을 강제하는 것은 §4-8 명시 허가의 durable 기록이라는 취지와 어긋난다.

## 결정

1. **"공개(publication)"를 신규-객체 전송으로 정밀 정의한다.** public/unknown-visibility 원격으로의 push가 공개로 간주되는 것은 전송 집합이 **새로 읽을 수 있는 객체**를 실어 나를 때뿐이다 — 신규 blob, 또는 신규 tree 엔트리 이름(스템 이름에는 사용자 이메일 유래 슬러그·자유형식 세션 id가 박힌다). 판정은 push 시도마다, **관측된(observed) 원격 sha를 기준으로 실제 전송 객체 집합(rev-list)** 위에서 한다. 명령 종류로는 절대 판정하지 않는다 — `op === 'consume'`은 삭제-전용의 증거가 아니다(위 컨텍스트의 tree reconciliation 경로).
2. **삭제-전용 push는 무동의 예외다.** 엄격히 삭제-전용인 전송 집합 — 로컬 tip tree가 공개된 원격 tip의 **정확한 부분집합**(같은 이름, 같은 blob sha)이고 객체 델타에 신규 blob이 0개 — 은 public/unknown 원격에도 **동의 없이 auto-push**하되, **단일 신원-마스킹 커밋**(author/committer 마스킹)으로 재발행한다. **Fail-closed** 조건: unborn/미관측 원격(null base), 객체 열거 오류, 신규 객체 1개라도 존재 — 이 중 하나라도 걸리면 예외는 닫힌다. **보존한도 truncation은 비인가 원격에서 SKIP한다** — truncation의 히스토리 재구축이 실제 신원을 보존하기 때문이다.
3. **write-push 동의는 프로젝트당 1회 standing grant로 승격한다.** 신규 핸드오프 본문을 public/unknown 원격으로 보내는 것은 기본 거부를 유지한다. `ditto handoff write --consent-push-remote`가 프로젝트 단위 standing consent를 기록한다: `.ditto/local/config.json`의 `handoff_push_consent` 블록(개인 구획, gitignored), **정규화된 origin URL 정확 일치에 결박**, **부여 시점의 visibility를 스탬프**. 이후 write는 이 grant 아래 auto-push한다. private/internal로 스탬프된 grant는 라이브 visibility가 public/unknown으로 바뀐 순간 **정지(suspend)**된다 — 재확인이 필요하다. **Consume에는 동의 표면이 없다.** `--push-public`은 one-shot full-push opt-in으로 존치하며, purge는 항상 이를 요구한다.

## 근거 (rationale)

- **노출의 단위는 명령이 아니라 객체다.** 원격이 새로 읽게 되는 것은 전송된 객체(blob 내용·tree 엔트리 이름)이지 CLI 서브커맨드가 아니다. 명령-종류 판정은 tree reconciliation 경로에서 신규 본문을 consume에 실어 보내는 오탐-없는-누출(false-negative)을 만든다. 객체-집합 판정만이 이 경로를 막는다.
- **순수 삭제는 비밀을 늘리지 않는다.** 원격이 이미 아는 것의 부분집합만 남기는 push는 노출을 오직 줄인다 — 동의를 요구할 근거가 없고, 오히려 동의 마찰이 삭제(=노출 축소)를 지연시키는 역효과를 낸다. 단, 커밋 메타데이터의 실제 신원은 새 정보이므로 마스킹 재발행이 조건이고, 판정 불능이면 닫는다(fail-closed).
- **standing consent는 §4-8 durable 기록의 연장이다.** 매 write마다 one-shot 확인을 강제하는 대신, 정확한 origin URL과 부여 시점 visibility에 결박된 grant를 개인 구획에 남긴다. visibility 변화 시 suspend는 "부여 당시의 조건이 깨지면 허가도 깨진다"는 확대-해석 차단 장치다 — ADR-20260722가 상시허가의 범위·조건을 고정해 확대 해석을 막은 것과 같은 원리.

## 기각된 대안 (rejected alternative)

- **consume에 동의 표면 배선.** 기각 — **불필요**하고(순수 삭제는 동의가 필요 없다 — 위 근거), **불안전**하다(consume의 동의 프롬프트는 동반된 미-push write 본문을 그 김에 승격 push하도록 유혹하는 표면이 된다 — 신규-객체 판정이 막으려는 바로 그 경로를 동의 UI가 다시 연다).

## 변경 조건 (change_condition)

- **핸드오프 전송이 숨은 git ref를 벗어나면**(다른 매체로 교체) → 객체-집합 판정·삭제-전용 예외·standing consent 전부를 새 매체 기준으로 재검토한다. 이 결정은 git 객체 모델(blob·tree·rev-list)에 결박되어 있다.
- **repo visibility 해석이 fail-closed 기본값을 바꿀 만큼 신뢰할 수 있어지면**(unknown-visibility가 실질적으로 사라지면) → 기본 거부·suspend 조건을 재평가한다.
