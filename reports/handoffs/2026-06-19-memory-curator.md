---
title: "Handoff — Memory 큐레이터 (wi_260617aaf) — §8 구현 완료, finalize만 남음"
kind: handoff
created: 2026-06-19 KST
author: hskim, claude
status: implementation-done-finalize-pending
branch: docs/memory-librarian-spec
work_items: [wi_260617aaf]
---

# Handoff — Memory 큐레이터 (다른 PC 재개용)

> 커밋되는 핸드오프(`.ditto/local/`은 gitignore라 다른 PC엔 work-item/state가 없다, ADR-0012).
> **권위본 = `.ditto/specs/memory-librarian.md`**(커밋·푸시됨). 이 문서는 그 진입 안내일 뿐.
> 구현은 끝났다 — **§8 다섯 증분(1~5) 전부 main 아닌 이 브랜치에 커밋·푸시 완료.** 남은 건 finalize뿐.

## 1. 원래 의도 (범위 보존)

ditto memory를 '도서관과 사서 → **큐레이터**'로 만든다. 목적은 호스트 에이전트의 환각(자기확신·근거없는
가정)을 구조화된 장기기억으로 차단. 코드를 지배하는 결정 계보 + 개발 중 신선한 컨텍스트(여정·발견)를
포착·재주입. **ditto 내부 생성형은 INFERRED 채널 한정**(advisory 유지, 1급화는 외부 프로젝트=ADR-0021 D5).

## 2. 진실의 원천 (먼저 읽을 것)

- **스펙(SoT)**: `.ditto/specs/memory-librarian.md` — §6 AC(ac-1~6), §8 증분 1~5, §11 마일스톤. **권위**.
- 측정 baseline: `reports/measurements/memory-curator-baseline.md`.
- 전략 결정: `.ditto/knowledge/adr/ADR-0021-...md` D5.

## 3. 완료 (전부 커밋·푸시, 브랜치 `docs/memory-librarian-spec`)

`git log --oneline aa5fde5~1..HEAD` 로 확인:

- `aa5fde5` inc.1 코드↔결정 다리 — ADR `관련:` → Artifact→Decision `RATIONALE_FOR` 엣지. (ac-1)
- `1b9f4e5` inc.2 결정계보 push — warm-start `decision_briefs` + dispatch cite-or-abstain. (ac-2)
- `bd067c5` inc.4 세탁 방지 — `proposeEvent`가 agent EXTRACTED→INFERRED 강등. (ac-4)
- `2bdff4d` inc.3 `ditto memory propose-finding` — evidence record→INFERRED observation. (ac-3)
- `8cbec64` inc.5 `ditto memory measure` + `memory-measure.ts` — 재제안율 baseline. (ac-5)
- `c4e8175` 스펙 SoT 정정 (ac-3 selector·inc.5 발견).

**검증**: 매 증분 TDD red→green. 전체 **2394 pass / 0 fail**, lint(biome)·adr-guard 통과. 실 CLI baseline 산출 확인.

## 4. 빌드 중 확정된 설계 결정 (재논의 불필요)

- **inc.3 selector**: EvidenceRecord에 안정 id 없음 → `--evidence-id` 불가. `ditto memory propose-finding
  --work-item <id> --index <n>` 채택. 증거 출처(path:lines·command·sha256)는 `sources`(=`src_` 전용)가
  아니라 event `text`에 결박. agent observation은 항상 INFERRED. (`src/cli/commands/memory.ts` `memoryProposeFinding`)
- **inc.5 측정 실현성**: 재제안율은 결정적 측정 **가능**(ADR `## 대안` 전용 섹션, 20개 중 18=90%, 기각대안
  67건). **불변식 위반율은 산문에 흩어져 전용 섹션 없음 → 결정적 분자 미산출, measure-before-expand로
  재보류**(ADR에 불변식 구조화 기재가 선행돼야). (`src/core/memory-measure.ts`)
- **ac-6**(생성형 INFERRED 한정): 별도 생성형 producer 없이 INFERRED 채널 강제로 충족. 추가 빌드 불필요.

## 5. 남은 작업 (다음 세션)

1. **tech-spec finalize** — `ditto tech-spec finalize`(intent.json 컴파일). **사용자 증분 리뷰 전제 모드라
   임의 finalize 금지** — review가 현재 pending. 사용자가 §6 AC·§8을 검토한 뒤 진행.
2. **§13 빌드 후 처리** — §3 배경·§5 비목표·§6 AC·§7 위험·§10 기각대안을 ADR로 승격(ADR-0013 보강 또는
   신규 ADR "코드↔결정 다리 + 발견 포착, 생성형 INFERRED 한정"). 큐레이터 자세(조합형 advisory / 생성형
   INFERRED 한정)를 못 박는다.
3. **measure-before-expand 게이트 판정** — baseline(reports/measurements/...) 기준으로 M3 추가 확장 여부 판정.

## 6. 다른 PC 재개 절차

`.ditto/local`(work-item/tech-spec-state/handoff)은 이 PC에만 있다. 다른 PC에서는:

1. `git pull` 후 브랜치 `docs/memory-librarian-spec` 체크아웃.
2. `ditto work start`로 동일 의도 재등록(원래 wi_260617aaf는 로컬 전용이라 새 id가 부여됨).
3. `ditto tech-spec start --doc .ditto/specs/memory-librarian.md`로 이 문서를 가리켜 재개.
4. `bun test` 그린 확인 후 §5의 finalize/승격 작업 진행.

## 7. 주의

- `ditto work resume`은 **없는 명령**. 재개는 스펙 + 이 핸드오프를 읽고 이어서.
- 명칭: `agents/knowledge-curator.md`(ADR/glossary)와 "memory 큐레이터"는 범위가 다름 — skill/agent 이름은
  기존 `memory-graph` 유지(스펙 미해결 질문).
