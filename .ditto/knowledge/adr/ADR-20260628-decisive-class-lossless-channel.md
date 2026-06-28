# ADR-20260628-decisive-class-lossless-channel: owner-return 결정 4클래스는 무손실 free-text 채널 — per-class 구조 필드 거부

- 상태: accepted
- 결정 일자: 2026-06-28
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: wi_260627jhh(컨텍스트 관리 강화) ac-2/ac-3에서 발의. 헌장 §4-9(위임으로 컨텍스트를 지킨다 — 의도는 축자 offload만, compaction 금지). 코드(권위): `src/schemas/owner-return-envelope.ts` (ownerReturnEnvelope·verbatim_detail·superRefine reachability·`owner_kind`), `tests/core/owner-return-envelope.test.ts`. 보강 가드: ADR 없음(코드) — owner_kind 위조 우회 차단은 wi_2606274be(c9be530). **supersede 없음.**

## 컨텍스트

owner-return 봉투(wi_260627jhh ac-1)는 결정적 4클래스 — intent·결정·비가역 위험·불확실성 — 을 무손실로 보존해야 한다. 메인/오케스트레이터는 `summary` 슬롯만 컨텍스트에 적재하므로(ac-2), 4클래스가 summary-only로 유실되지 않아야 한다(ac-3).

후속 위험 리뷰에서 "결정 4클래스가 *실제로* 봉투에 담겼는지를 코드로 강제하지 않고, owner 문서 지침 + 1회성 fresh-review 판정에 의존한다"는 점을 갭으로 검토했다. 코드로 결정적 검사를 추가해야 하는가?

## 결정

**결정 4클래스는 무손실 free-text 채널(`verbatim_detail`, 또는 `artifact_location` 포인터) + owner 문서 지침으로 운반한다. per-class 구조 필드는 의도적으로 거부한다.** "4클래스가 담겼는지"의 결정적(코드) 검사는 추가하지 않고, verifier/review 노드의 의미 검사에 맡긴다. 이는 by-design이며 닫힌 결정이다.

스키마가 결정적으로 강제하는 것은 *상세의 도달가능성*뿐이다: superRefine은 `verbatim_detail`(비어있지 않음) 또는 `artifact_location` 중 하나를 요구한다(bare summary 거부). 면제는 `retrospective`(별도 두 지표 제시) 한 종뿐이고, 이 면제의 위조는 owner_kind↔node.owner 대조로 차단된다(wi_2606274be).

## 근거 (rationale)

코드로 검증한 근거(§4-11, 본문에 직접):

- **per-class 필드는 이미 의도적으로 거부됐다.** `owner-return-envelope.ts` `verbatim_detail` 주석: 이 슬롯이 "intent / decisions / irreversible-risks ... 전용 슬롯 없는 결정 클래스의 carrier"이며 "summary-only loses none of the four classes (ac-3); the lossless channel stays the design, **no per-class field is added**." 즉 구조 필드화는 검토 후 기각된 설계지 미구현 갭이 아니다.
- **free-text의 "4클래스 존재"는 결정적으로 검사 불가.** 산문 안에 intent/결정/위험이 실제로 들어있는지는 의미 판단이라 정규식·스키마로 못 잡는다. LLM judge로 검사하면 환각으로 SLOP을 만들 위험(pre-mortem 재설계 교훈과 동형: anti-SLOP은 코드 결박이지 LLM 규율이 아니다).
- **의미 검사는 verifier/review 노드의 책임이다.** ac-3은 본래 "fresh 리뷰어가 summary↔축자 대조로 누락 0 판정"(doc evidence)으로 설계됐다 — 코드 가드가 아니라 fresh-context 검증 이벤트다. 자기 작업 검증을 자기 맥락에서 끝내지 않는다는 §4-9와 정합.
- **도달가능성 가드는 실재한다.** superRefine이 bare summary(detail 없음·포인터 없음)를 거부하므로, "무손실 채널이 비어있는" 명백한 유실은 코드가 막는다. 못 막는 건 "채널은 찼는데 4클래스 중 하나가 빠진" 의미적 유실뿐이고, 그건 위 이유로 코드 영역 밖이다.

기각된 대안:

- **per-class 구조 필드(intent/decisions/risks를 각각 별도 필드로)** — 스키마 주석이 명시 거부. free-text 무손실 채널이 4클래스를 묶어 운반하는 것이 설계이고, 필드 분리는 owner에게 구조 강제 부담을 지우면서 "산문에 더 있는데 필드엔 누락"의 새 유실 표면을 만든다.
- **LLM judge로 4클래스 존재 검사** — SLOP 위험. 환각으로 없는 누락을 지어내거나 있는 누락을 놓친다.
- **"열린 위험"으로 보류** — 미루기(§4-8). 더 할 코드 작업이 설계상 없으므로 by-design으로 닫는다.

## 변경 조건 (change_condition)

free-text에서 4클래스 존재를 *결정적으로*(LLM 판단 없이) 검증하는 신뢰 가능한 수단이 생기거나, summary-only 적재에서 결정 클래스 유실이 실제 관측되면 재검토한다 — 그때는 도달가능성 너머의 가드 또는 구조 필드를 다시 저울질한다.
