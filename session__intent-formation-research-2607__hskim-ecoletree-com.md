---
{"schema_version":"0.1.0","scope":{"kind":"session","session_id":"intent-formation-research-2607"},"from_context":"Claude Code 세션(Fable 5, dogfood, rebuild/foundation). b8b51e9 리뷰(결함 2건 발견) → 3+2갈래 연구(mattpocock 전수·현행 감사·이론 30건·독해 고리 2갈래) → 종합 보고서 작성·커밋 b36f7ec·push 완료.","original_intent":"deep-interview 의도 형성 품질 연구를 구현으로 전환. 북극성: 손실 없는 의도 전달 — 에이전트가 사용자의 말에서 목표 상태를 옳게 읽는 것(0번째 판단)부터 모든 것이 시작한다. 최우선 착수 대상: 보고서 반영안 묶음 1 '목표 상태 계약'(Tier G) — 라운드0 목적지 확립(충족 상태 스키마)·전원 종속 게이트·완료=목표 상태 도달·목표-고정 자율성+갈림길 선제 표면화·목표 대비 간극 가시성·질문 위생 게이트(수반 질문=오독 지문).","current_state":"reports/research/deep-interview-intent-formation-research.md가 origin/rebuild/foundation에 landed(b36f7ec, 사전-push 733 pass). 보고서 구성: §1 진단(0번째 목표 상태 독해 + 세 판단 전부 무게이트 자기보고, file:line 증거) · §2 mattpocock 메커니즘 · §3.0 독해(이론 16건 계약 표 + 통합 독해 절차 10단계) · §3.1-3.5 파악~보정 · §5 반영안 Tier G(최우선)/U/A/B/C + 역방향 렌더링(오역·뜬금없는 단어 2클래스) · 후보 묶음 7개. 구현 착수는 아직 안 함 — 사용자 착수 승인 대기.","decisions_made":[],"critical_decisions":[{"decision":"보고서는 삭제 예정 — 구현·문서 어디서도 경로·문서명·섹션 링크 금지, 내용은 소비처에 인라인하고 출처는 원 출처(SEP·논문·코드 file:line)로","rationale":"깨질 링크 방지, 헌장의 코드-권위 원칙"},{"decision":"묶음 우선순위: 1 목표 상태 계약(뿌리) → 2 보편 의사소통 계층+언어 축 심화 → 3 형성 게이트 이식(prism 패턴) → 4 굳히기 → 5 질문 경제 → 6 구체화 몰드","rationale":"실사용 실패(그럴듯한 질문→엉뚱한/부분 구현→후속 나선)가 가리키는 뿌리부터"},{"decision":"질문 위생 규칙: 원 요청이 수반하는 것을 묻는 질문은 기각+오독 신호(독해 재실행), 전제는 세계 확인으로 라우팅, 함축·재량·동률 갈림길만 질문 자격","rationale":"수반/전제/함축 타이핑(취소·투영 검사) — 그럴듯한 질문이 오독의 지문일 수 있다는 기제"},{"decision":"조용한 축소 금지: 복수 독해가 끝까지 남으면 드러내기만 허용, 에이전트에게 유리한(일 적은) 쪽으로 침묵 해소는 위반. 축소 금지 전용 — 확장 면허 아님","rationale":"contra proferentem 뒤집기"}],"irreversible_risks":[],"user_decision_block":[],"changed_files":["reports/research/deep-interview-intent-formation-research.md","bin/ditto"],"evidence_refs":[{"kind":"note","summary":"연구 보고서 commit b36f7ec origin/rebuild/foundation landed, 사전-push 훅 733 pass/0 fail. 출처 검증 상태 V/P/U 보고서 §7에 표기. 리뷰 fresh 재검증: tsc 0·bun test src 286 pass·biome 0"}],"failed_or_unverified":[],"open_threads":["wi_260723lny는 의도적으로 in_progress — ac-9 사용자 검증 3건(질문마다 배경·효과로 결정 가능/답변마다 의도 되비침/질문 전부 사용자 도달)은 다음 실제 deep-interview 실사용에서만 close","b8b51e9 리뷰 결함 2건 미수정: ①intent_summary가 dimension notes/id를 정규화·누출스캔 없이 사용자에게 출력(interview-driver.ts:319-325 + CLI) — 묶음 4 되말하기 표면 재설계에 흡수 예정 ②자기충족 게이트가 needsBriefing(초과 판정)을 요건으로 뒤집어 써 간결하고 완전한 선택지를 오탈락(question-context.ts:285-300)","pre-mortem이 위험(비가역·파급)만 잡고 결정-갈림길을 안 잡는 공백 — Tier G4가 갈림길 클래스 추가를 요구"],"next_first_check":"사용자가 이 프롬프트로 착수를 지시하면: 보고서의 묶음 1(목표 상태 계약, Tier G 전체)을 /ditto:deep-interview로 시작한다. 인터뷰 시드에는 보고서 내용을 인라인으로 옮겨 담을 것 — 보고서 링크·앵커 금지.","forbidden_scope_creep":["보고서 전체를 한 번에 구현하려는 시도 — 묶음 1만, 나머지는 각자 별도 인터뷰","언어 축·렌더링 문제를 묶음 1에 끼워넣기 — 묶음 2 소관","prism 동작 변경 — 이식은 인터뷰 쪽으로만"],"artifact_available":true,"created_at":"2026-07-24T13:36:37.513Z"}
---

# Handoff: intent-formation-research-2607

from: Claude Code 세션(Fable 5, dogfood, rebuild/foundation). b8b51e9 리뷰(결함 2건 발견) → 3+2갈래 연구(mattpocock 전수·현행 감사·이론 30건·독해 고리 2갈래) → 종합 보고서 작성·커밋 b36f7ec·push 완료.

## 원래 의도
deep-interview 의도 형성 품질 연구를 구현으로 전환. 북극성: 손실 없는 의도 전달 — 에이전트가 사용자의 말에서 목표 상태를 옳게 읽는 것(0번째 판단)부터 모든 것이 시작한다. 최우선 착수 대상: 보고서 반영안 묶음 1 '목표 상태 계약'(Tier G) — 라운드0 목적지 확립(충족 상태 스키마)·전원 종속 게이트·완료=목표 상태 도달·목표-고정 자율성+갈림길 선제 표면화·목표 대비 간극 가시성·질문 위생 게이트(수반 질문=오독 지문).

## 현재 상태
reports/research/deep-interview-intent-formation-research.md가 origin/rebuild/foundation에 landed(b36f7ec, 사전-push 733 pass). 보고서 구성: §1 진단(0번째 목표 상태 독해 + 세 판단 전부 무게이트 자기보고, file:line 증거) · §2 mattpocock 메커니즘 · §3.0 독해(이론 16건 계약 표 + 통합 독해 절차 10단계) · §3.1-3.5 파악~보정 · §5 반영안 Tier G(최우선)/U/A/B/C + 역방향 렌더링(오역·뜬금없는 단어 2클래스) · 후보 묶음 7개. 구현 착수는 아직 안 함 — 사용자 착수 승인 대기.

## 핵심 결정 (재호출 불가)
- 보고서는 삭제 예정 — 구현·문서 어디서도 경로·문서명·섹션 링크 금지, 내용은 소비처에 인라인하고 출처는 원 출처(SEP·논문·코드 file:line)로 — 깨질 링크 방지, 헌장의 코드-권위 원칙
- 묶음 우선순위: 1 목표 상태 계약(뿌리) → 2 보편 의사소통 계층+언어 축 심화 → 3 형성 게이트 이식(prism 패턴) → 4 굳히기 → 5 질문 경제 → 6 구체화 몰드 — 실사용 실패(그럴듯한 질문→엉뚱한/부분 구현→후속 나선)가 가리키는 뿌리부터
- 질문 위생 규칙: 원 요청이 수반하는 것을 묻는 질문은 기각+오독 신호(독해 재실행), 전제는 세계 확인으로 라우팅, 함축·재량·동률 갈림길만 질문 자격 — 수반/전제/함축 타이핑(취소·투영 검사) — 그럴듯한 질문이 오독의 지문일 수 있다는 기제
- 조용한 축소 금지: 복수 독해가 끝까지 남으면 드러내기만 허용, 에이전트에게 유리한(일 적은) 쪽으로 침묵 해소는 위반. 축소 금지 전용 — 확장 면허 아님 — contra proferentem 뒤집기

## 변경 파일
- reports/research/deep-interview-intent-formation-research.md
- bin/ditto

## 증거 (inline)
- {"kind":"note","summary":"연구 보고서 commit b36f7ec origin/rebuild/foundation landed, 사전-push 훅 733 pass/0 fail. 출처 검증 상태 V/P/U 보고서 §7에 표기. 리뷰 fresh 재검증: tsc 0·bun test src 286 pass·biome 0"}

## 열린 스레드
- wi_260723lny는 의도적으로 in_progress — ac-9 사용자 검증 3건(질문마다 배경·효과로 결정 가능/답변마다 의도 되비침/질문 전부 사용자 도달)은 다음 실제 deep-interview 실사용에서만 close
- b8b51e9 리뷰 결함 2건 미수정: ①intent_summary가 dimension notes/id를 정규화·누출스캔 없이 사용자에게 출력(interview-driver.ts:319-325 + CLI) — 묶음 4 되말하기 표면 재설계에 흡수 예정 ②자기충족 게이트가 needsBriefing(초과 판정)을 요건으로 뒤집어 써 간결하고 완전한 선택지를 오탈락(question-context.ts:285-300)
- pre-mortem이 위험(비가역·파급)만 잡고 결정-갈림길을 안 잡는 공백 — Tier G4가 갈림길 클래스 추가를 요구

## 다음 agent 가 가장 먼저 볼 것
사용자가 이 프롬프트로 착수를 지시하면: 보고서의 묶음 1(목표 상태 계약, Tier G 전체)을 /ditto:deep-interview로 시작한다. 인터뷰 시드에는 보고서 내용을 인라인으로 옮겨 담을 것 — 보고서 링크·앵커 금지.

## 금지: scope creep
- 보고서 전체를 한 번에 구현하려는 시도 — 묶음 1만, 나머지는 각자 별도 인터뷰
- 언어 축·렌더링 문제를 묶음 1에 끼워넣기 — 묶음 2 소관
- prism 동작 변경 — 이식은 인터뷰 쪽으로만
