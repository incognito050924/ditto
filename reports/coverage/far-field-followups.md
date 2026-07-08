# wi_260706n4w far-field 재설계 — 남은 후속 3건 정리

> **성격**: 백로그 정리 문서(코드 변경 없음). 세 후속은 전부 `wi_260706n4w`(far-field 신뢰성 재설계, done)에서 파생돼 추적 draft WI로 물질화됨. **권위는 각 WI 레코드 + 코드**; 이 문서는 착수 판단용 요약이다.
> **작성**: 2026-07-08 · 대화 중 진화한 범위(phi는 skill로 확장, k2g는 비용 최적화로 재구성)를 레코드 원문보다 우선 반영.

## 상태 스냅샷

| WI | 한 줄 | 상태 | 착수 경로(제안) | 근거 문서 |
|---|---|---|---|---|
| **wi_260707phi** | far-field 카테고리 발견·관리·제안 skill (+ tier-② override UX) | draft·미착수 | heavy (deep-interview) | 이 문서 §1 |
| **wi_260707dxg** | ac-5 AFTER 날조율 측정 (재설계 전/후 실증) | draft·미착수 | 라이브 실행 산물 | `wi_260706n4w-fabrication-baseline.md` §2, `labeler-contract.md` |
| **wi_260707k2g** | far-field sweep 비용 최적화 | draft·미착수 | heavy (deep-interview) | `far-field-cost-optimization-analysis.md` v3 |

공통: 셋 다 `discovered_by: wi_260706n4w`, criteria는 `TBD`(착수 시 deep-interview/planning에서 관측 가능 기준으로 확정). 셋 다 **지금 강제로 할 필요 없음** — 아래 각 "왜 지금 안 함" 참조.

---

## 1. wi_260707phi — far-field 카테고리 발견·관리·제안 skill

**무엇** (대화 중 확장된 범위 — 레코드 title은 원래 좁은 "tier-② UX"만 담음, 착수 시 아래로 재범위 필요):
- 사용자 요청 원문: "코드베이스를 기준으로 카테고리를 **발견**하고, **관리**(추가/삭제)하고, ditto가 코드베이스를 보고 **뭘 추가하면 좋을지·등록된 것 중 업데이트할 게 있는지 제안**하는 skill. 목표는 인지 비용 감소."
- 세 기능: ① 코드베이스 → 카테고리 발견(신호 미정), ② add/delete 관리 표면, ③ 능동 제안(추가 후보 + 기존 갱신 후보).

**왜 지금 안 함**:
- net-new 기능이고 모호(다표면). "코드베이스에서 발견"이 어떤 신호로인지, 제안이 자동추가 vs 항상 확인인지 등 의도 확정 필요 → freestyle 금지, deep-interview 선행.
- 기반 메커니즘은 이미 있음: 프로젝트별 카테고리 add/disable/재라우팅 config는 `resolveTaxonomy`(coverage-taxonomy.ts) + `.ditto/coverage-taxonomy.json`으로 **wi_260622vjo(ac-10) 때 landed**. 다만 **그 config 파일은 이 repo에 존재한 적 없고 관리 UX/skill이 없어 죽은 기능** — phi가 그 위에 사람이 쓸 표면을 씌우는 것.

**착수 경로/핵심 미결**:
- heavy(deep-interview). 1차 과제: (a) 발견 신호 정의(import 그래프? 디렉터리 구조? 의존성?), (b) 제안 공격성(자동 vs 확인), (c) 제안 근거의 검증 가능성.
- 백로그 연결: `reports/design/ditto-quality-remediation-backlog.md` line 224("floor는 tier-② config로 프로젝트가 enable/disable/add, `resolveTaxonomy` 패턴 동일") — 이 확립된 패턴의 관리 UX 확장.

## 2. wi_260707dxg — ac-5 AFTER 날조율 측정

**무엇**: 재설계가 실제로 날조 위험율을 낮췄는지 **재설계 전 vs 후**를 oracle과 분리된 독립 라벨러로 측정. BEFORE는 이미 측정됨(baseline: "재설계 전엔 검출 장치 자체가 없어 측정 불가"가 소견). AFTER 수치만 남음.

**왜 지금 안 함**: **코드로 지금 못 닫는 라이브 실행 산물.** 진짜 heavy WI를 재설계 후 파이프라인으로 한 번 돌리고 fresh 라벨러가 채점해야 나옴. 유닛테스트로 생성 불가 — 지어내면 안 됨.

**착수 경로 (5단계, `wi_260706n4w-fabrication-baseline.md` §2 원문)**:
1. AFTER sweep: 실 heavy WI의 far-field sweep을 재설계 후 taxonomy로 실행 (`coverage-round --json oracle_claims` → `oracle-provenance.json` 영속, n5 배선).
2. 라벨링: `labeler-contract.md`대로 fresh verdict-blind 세션이 raw claim 사영을 받아 `labeler_labels[]` 채움.
3. 상관: `correlateFabrication(oracle_verdicts, labeler_labels)` 실행, AFTER 절 append.
4. 대조: BEFORE(측정 불가·장치 부재) vs AFTER(oracle/labeler/agreement rate).
5. 동시 실증: 라이브에서 main agent가 실제로 `oracle_claims`를 제출하는지(SKILL 계약 준수) + cov-dim seed 질문 승격.

**성격**: 별도 heavy WI라기보다, **다음 실 heavy 작업에 올라타는 측정**. 잔여로 정직하게 남겨둔 것(ac-5는 부모 WI에서 evidence=log로 이미 pass).

## 3. wi_260707k2g — far-field sweep 비용 최적화

**무엇** (대화 중 재구성됨): 레코드 title은 원래 "heavy-path cov-cat ungated 게이트 신설 여부"였으나, 사용자가 **"far-field 점검은 하되 최적화, 또는 같은 효과를 더 싸게 내는 다른 접근"**으로 재정의. → 실질은 **far-field sweep 비용 최적화**.

**분석 결론** (`far-field-cost-optimization-analysis.md` v3 — 이미 조사 완료):
- **오분석 2건 정정됨**(사용자 교정): disposition은 비용 레버가 아님(code-verify를 grep으로 대체 불가 — 검증기≠생성기), runtime을 사후 검증으로 연기 불가(pre-mortem은 정의상 사전).
- **실제 남는 레버**(두 전제=상상적 LLM 생성 + 사전 시점 보존): **L1 역할별 모델 티어**(생성=싼 모델·적대 Opponent=강 모델, rigor 바닥 보존 → 가장 안전, ~2-3× 토큰 절감), L2 단계적 escalation(더 크나 coverage 위험).
- **스코핑 반전**: 사용자가 느끼던 "느림"의 실체는 far-field compute 비용이 **아니라 autopilot이 루틴 게이트마다 멈추던 것**이었고, 그건 원격 커밋 `264da67`(wi_260707loq 무중단 자율성)이 **이미 해결**. → far-field 비용 최적화는 **유효하지만 우선순위 낮은 별개 사안.**

**왜 지금 안 함**: 실제 통증(멈춤)은 해결됨. L1은 유효한 개선이나 급하지 않고, L2는 신뢰성(부모 WI가 방금 투자)과 맞바꿔 recall 측정 없이 도입 불가. 착수 시 heavy(deep-interview), 1차 과제 = code-verify 카테고리의 결정적 probe 표현 가능성 + L1 모델티어의 recall 영향 실측.

---

## 종합 판단

- **급한 것 없음.** 셋 다 부모 WI(done)의 가장자리이고, 실제 급했던 마찰(autopilot 멈춤)은 이미 닫힘.
- **우선순위 감**(권고): 착수한다면 **phi > k2g(L1) > dxg** 순 — phi는 사용자가 명시 요청한 인지비용 감소 가치, k2g(L1)는 안전한 상수배 절감, dxg는 다음 heavy 작업에 자연히 올라타는 측정.
- 셋 다 tracked라 고아로 묻히지 않음. 착수 지시가 오면 각각 deep-interview(phi·k2g) 또는 다음 heavy 작업 편승(dxg)으로 연다.
