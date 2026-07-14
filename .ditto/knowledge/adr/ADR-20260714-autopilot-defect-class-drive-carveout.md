# ADR-20260714-autopilot-defect-class-drive-carveout: 발견된 실동작 버그(분류기-키드)만 no-auto-pick 예외로 same-run chain-drive — 비-결함은 materialize≠drive 불변 (ADR-20260627·ADR-20260710 클래스-한정 부분 supersede)

- 상태: accepted
- 결정 일자: 2026-07-14
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: **ADR-20260627-autopilot-followup-autonomy-boundary (클래스-한정 부분 supersede** — 그 change_condition "진짜 cross-WI same-session auto-drive는 명시 신호 뒤에서만 허용"을 발동한다. 명시 신호 = 사용자 승인된 원 intent(wi_2607148yg source_request, "발견된 결함은 물질화+구동해서 고침")에 기록된 상시 체인 승인 + 보수적 분류기 판정. 비-결함 후속의 `no-auto-pick`/`single-active-pointer`/materialize≠drive는 **불변**), **ADR-20260710-intent-single-unit-and-termination-completeness (클래스-한정 부분 supersede** — D4 "capture≠drive는 통과 조건 / out-of-scope 후속은 물질화만"과 same-run 단일 승인단위 경계를, *재현 실동작 버그* 한 클래스에 대해서만 "물질화→구동(각자 자기 커밋)"으로 확장. D1 종료 완전성 게이트·비-결함 슬라이스 금지·priority advisory-only는 **불변**), ADR-0020 (결정-모순 가드레일 — 이 ADR이 그 투명 공개다: 사용자 승인된 intent-level 결정이 두 기존 ADR과 충돌하므로 근거·기각안·철회조건과 함께 드러낸다), ADR-0010 (기능 4축 — 축2 autopilot 무거운 경로의 per-WI 의도잠금은 예외 대상 결함 WI에도 유지: 자동 생성 결함 WI도 자기 intent/커밋으로 land), ADR-20260626-work-lifecycle-lightweight-path (경량 경로 close — 발견 결함이 물질화 안 되면 close 차단, 단 구동은 안 함). 코드(권위): `src/core/charter.ts` PRIME_DIRECTIVE의 "딱 하나의 예외 — 실행 중 발견한 버그" 큐(매 턴 재주입되는 정책 표면 — 이 ADR과 동기), 런타임 집행은 같은 work item(wi_2607148yg) 형제 노드가 구현: `src/core/autopilot-loop.ts`(발견-분류-체인구동 라운드), `src/core/gates.ts`(보수적 결함 분류 게이트 — 불확실=구동 안 함), `src/cli/commands/work.ts`·`src/cli/commands/autopilot.ts`(경량 경로 close 표면화·종료 예산). 회귀 락: `tests/core/charter.test.ts`("defect-class carve-out is a separate cue; base prohibition undiminished"). 발의/구현 WI: wi_2607148yg (ac-11 = 이 ADR).

## 컨텍스트

autopilot(및 간략 경로)이 실행 중 잔여·후속을 조용히 양산하고 "의도적으로 남긴 후속"이라 포장해 사용자에게 처분 책임을 떠넘기는 패턴, 그리고 진짜 후속이라도 언급만 하고 아무 행동을 하지 않아(백로그/Work Item으로 영속화하지 않으면 무가치) 지나가다 발견한 버그를 방치하는 패턴이 반복 관찰됐다. 사용자 지시(wi_2607148yg source_request): "발견된 결함(버그)은 못 본 척 금지 — 물질화+구동해서 고친다(발견분까지 구동). 미요청 기능은 YAGNI로 안 짓는다."

이 지시는 기존 두 결정과 정면으로 만난다:

- **ADR-20260627** — autopilot은 run이 만든 out-of-scope 후속을 **물질화만 하고 자동 구동하지 않는다(materialize≠drive)**, `no-auto-pick`/`single-active-pointer` 불변식 무완화. 그 dialectic이 기각한 레버가 정확히 "same-session 자동 체인 구동"이었다.
- **ADR-20260710** — pass-close에서 **capture≠drive가 통과 조건**이고, out-of-scope 후속은 물질화만 한다(Direction B "종료 전 자동 구동"을 명시 기각). 하나의 의도=하나의 단위, 임의 슬라이싱 금지.

두 ADR은 **비-결함**(아이디어·기능·기술부채·잠복버그) 후속의 무분별 자동 구동을 막기 위한 것이다. 사용자의 새 지시는 그 금지를 뒤집자는 게 아니라, **"재현되는 실동작 버그"라는 한 좁은 클래스**에 대해서만 "물질화만"을 "물질화+구동"으로 여는 것이다 — 지나가다 발견한, 지금 실제로 깨지는 동작을 못 본 척 남기는 것은 사용자가 원하는 바가 아니기 때문이다. ADR-0020에 따라 이 intent-level 충돌을 투명하게 기록한다.

## 결정

**재현되는 실동작 버그 한 클래스에 한해, autopilot은 그 버그를 자기 work item으로 물질화한 뒤 같은 run 안에서 done까지 체인 구동한다(각자 자기 커밋). 그 밖 모든 후속에는 ADR-20260627/ADR-20260710의 materialize≠drive·no-auto-pick가 불변으로 유지된다.**

### D1 — 예외는 ac-2 분류기 판정에 키드된다(자기-라벨 아님, relabel 저항)

구동 자격은 에이전트가 산문으로 "버그"라고 이름 붙였다고 열리지 않는다. **보수적 분류기**(wi_2607148yg ac-2: `src/core/gates.ts`)가 "재현되는 실동작 버그"로 **판정한 것만** 자격을 갖는다. 잠복버그(현재 무피해)·기술부채·이번 변경과 무관한 기존 테스트 실패는 자격이 없고, **불확실하면 구동하지 않고 백로그로 물질화만** 한다(fail-safe = 구동 안 함). 이 키잉이 예외가 "아무거나 버그라 부르면 자동 구동"으로 번지는 것을 막는다.

### D2 — 비-결함은 materialize≠drive / no-auto-pick 불변(ac-5)

예외는 비-결함 후속(아이디어·기능·기술부채·잠복버그)에는 **열리지 않는다**. 그런 후속은 종전대로 물질화만 하고 구동하지 않으며, `single-active-pointer`도 유지된다. 결함 클래스 예외를 근거로 비-결함까지 자동 구동하는 것은 이 ADR이 금지한다. 미요청 기능은 YAGNI로 짓지 않는다.

### D3 — 파생 결함은 자기 커밋/work item으로 land(ac-3), per-WI 의도잠금 유지

자동 생성된 결함 WI도 자기 intent와 자기 커밋으로 land한다 — 원 work item의 커밋·diff에 섞이지 않는다(두 의도가 한 커밋에 뭉치지 않음). ADR-0010 축2의 per-WI 의도잠금은 결함 WI에도 적용된다(자동 생성이 게이트 우회를 뜻하지 않는다).

### D4 — 두 fail-stop 조건은 예외 중에도 불변(ac-4/ac-7)

자율 구동 중에도 두 경우 — ① 정초 계획·방향이 뒤집히거나 진행이 막힐 때, ② 보안·시스템·프로젝트·기능설계 의도를 위협하는 결정이 필요할 때 — 에는 여전히 멈추고 fail-closed로 사용자에게 blocked handoff한다. 우연히 발견한 보안 취약점의 자동 수정은 조건②로 인계한다(자동 구동 금지).

### D5 — ADR-20260627 change_condition의 발동(상시 명시 신호)

ADR-20260627은 "진짜 cross-WI same-session auto-drive는 **명시 신호 뒤에서만** 허용 — 원본 intent에 체인 승인을 명시 기록하거나 사용자 행동 명령"이라고 철회 조건을 남겼다. 이 ADR이 그 조건을 발동한다: **명시 신호 = 사용자 승인된 정책(이 결정)에 기록된, 재현-실동작-버그 클래스에 한정된 상시 체인 승인 + 분류기 판정.** 그 신호 밖(비-결함)에서는 change_condition이 발동되지 않으므로 no-auto-pick이 그대로다.

## 근거 (rationale)

- **못 본 척 방치가 진짜 손해다.** ADR-20260627/ADR-20260710의 금지는 *비-결함 후속의 무분별 확장*을 겨눈 것이지, *지금 깨지는 동작을 지나치는 것*을 보호하려던 게 아니다. 클래스-한정 예외는 그 두 ADR이 막으려던 해악(스코프 크리프·게이트 우회·조용한 확장)을 재도입하지 않으면서 사용자 지시를 실현한다.
- **분류기 키잉이 relabel 우회를 차단한다.** 예외를 자유 텍스트 "버그" 라벨이 아니라 보수적 분류기 판정에 묶으면, 에이전트가 원하는 후속을 "버그"라 개명해 자동 구동하는 회피가 봉쇄된다. 불확실=구동 안 함이라 예외의 기본 방향이 최소 자율이다.
- **materialize≠drive는 비-결함에서 온전하다.** 예외가 결함 클래스로 봉인되므로 ADR-20260627 dialectic이 코드로 검증한 근거(placeholder AC·intent.json 부재·per-WI 의도잠금)는 비-결함 후속에 그대로 성립한다 — 그쪽은 여전히 구동 대상이 실질 공집합이다.
- **종료 완전성(ADR-20260710 D1)은 완화가 아니라 강화된다.** 결함을 자기 WI로 물질화+구동하면, "in-scope 잔여를 out-of-scope 후속으로 개명해 도망치는" 경로가 좁아진다. D1의 pass-close 잔여 게이트는 결함 WI에도 per-WI로 적용된다.
- **ADR-0020 투명 공개.** 이 결정은 두 accepted ADR과 충돌하는 intent-level 결정이고, 사용자만 풀 수 있는 충돌이었다(사용자가 이미 승인). 조용히 어기지 않고 근거·기각안·철회조건과 함께 ADR로 드러낸다.

## 기각된 대안 (rejected alternative)

- **자유-텍스트 "버그" 라벨로 예외 개방.** 기각 — relabel로 no-auto-pick 전체가 무력화된다. 분류기 판정 키잉이 유일하게 예외를 좁게 유지한다(D1).
- **모든 run-materialized 후속을 same-run 자동 구동(ADR-20260627/ADR-20260710을 통째로 완화).** 기각 — 두 ADR이 dialectic으로 이미 기각한 레버다. 비-결함 자동 구동은 per-WI 의도잠금·승인 게이트를 우회하고 스코프 크리프를 낳는다. 예외는 결함 클래스로 봉인해야 한다(D2).
- **수정 크기/노력 기반 별도 정지축 신설.** 기각(out_of_scope) — 정지는 두 fail-stop 조건과 종료 예산(진전없는 반복/라운드 한계 → fail-handoff 승격)으로 충분하다. 새 축은 얕은 추상화다(헌장 §4-3).
- **간략 경로에도 자율 발견·구동 루프 추가.** 기각(out_of_scope) — 간략 경로는 발견 결함의 물질화·표면화만 요구하고 구동은 하지 않는다(하드블록도 아님). 자율 구동은 무거운 경로(autopilot) 전용.

## 변경 조건 (change_condition)

- **분류기가 실사용에서 너무 공격적(비-결함을 결함으로 오판해 과잉 구동)이거나 너무 보수적(실동작 버그를 반복 놓침)으로 판명되면** → ac-2 분류 게이트의 경계 라벨을 재조정. 예외의 분류기-키잉 원칙(자유-라벨 금지)은 유지한다.
- **비-결함까지 same-session 자동 구동이 진짜 필요해지면** → 이 예외를 넓히는 게 아니라 ADR-20260627의 원래 change_condition대로 별도 명시 신호(`ditto work chain drive` 미구현 명령 등) 뒤에서만, 각 WI가 per-WI 의도잠금을 통과하는 조건으로 재검토.
- **결함 WI의 자기-커밋 경계(ac-3)가 실사용에서 원 WI diff와 섞이는 회귀가 나오면** → 커밋 분리 집행을 강화(이 ADR의 D3는 분리를 요구하지 섞임을 허용하지 않는다).
