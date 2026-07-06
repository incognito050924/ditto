# HANDOFF (remote / cross-PC) — WS3 관제탑 context-rot 레인 (병렬 착수)

> **다른 PC 병렬 착수용 원격 핸드오프.** `.ditto/local/`(WI 레코드·런타임)은 gitignored → git으로 안 옴. 권위=코드+커밋된 설계문서(charter §4-11). 아래 본문은 pickup용, 모든 file:line은 fresh 재확인(grep/test).
> **작성**: 2026-07-06 · 코드 변경 0 · 이전 HANDOFF.md(=wi_260705lc8 prism autopilot 재개)를 **교체**함.
> ⚠ **prism(wi_260705lc8)은 parked — 재개하지 말 것.** 별도 브랜치 `wi_260705lc8-prism`(미푸시, pull에 안 옴), 방향 미확정(issue #11). 이전 HANDOFF의 "prism 재개" 지시는 폐기됨. `reports/handoff-bundles/wi_260705lc8-state.tar.gz`도 무시(prism 전용).

## 0. 먼저 (착수 전제)
```bash
git checkout main && git pull origin main      # 8b02c61(§4 재시퀀싱 계획) + 이 HANDOFF.md 수신
bun install && bun run build:bin               # ./bin/ditto (working-tree, dogfood 모드)
```
- 이 PC엔 `.ditto/local` WI 레코드가 없다 → 이 레인용 **새 WI를 직접 생성**(로컬 wi_260615* 등은 안 옴).

## 1. 이 PC가 맡는 레인 = WS3 관제탑 context-rot (LOOP)
SoT = `reports/design/ditto-quality-remediation-backlog.md` §3 WS3 · §4.2 LOOP 행 · §4.3.

**왜 이 레인**: 사용자 최상위 불만(관제탑=메인 오케스트레이터 자신의 context가 무관리 — 토큰/버짓 회계 0, 경계 자동 reset 0; 유일 완화가 프롬프트 규율 "매 라운드 autopilot.json 재읽기"뿐, 코드 강제 아님). 의존 없이 즉효. 파일셋이 로컬 척추(WS0-T0)·prism·나머지 레인과 **disjoint** → 머지 무충돌.

**이 레인 파일셋**: `src/core/autopilot-loop.ts` (+ WS3-T2에서 `skills/handoff/`).
**건드리지 말 것(로컬 척추 WS0-T0 소유)**: `src/core/work-item-store.ts` · `src/schemas/work-item.ts` · `src/schemas/autopilot.ts` · `src/**/completion-contract.ts` · `.gitignore`. (척추가 work-item/autopilot **스키마 shape**을 바꾸므로, 통합 시 autopilot-loop의 status/graph 읽기 정합만 확인 — 파일은 안 겹침.)

### 태스크 (순서)
- **WS3-T1 (중, 먼저)** — 메인 루프에 경량 컨텍스트 회계(라운드 수 · spawn/collect 서사 크기 proxy) + 임계치. 앵커: `autopilot-loop.ts`의 post_cost 인접(현재 metrics-grounding 구역 ~L173–276; 계획이 인용한 `:307-333`은 fresh 재확인). 검증: 합성 긴 run이 임계치 초과 시 신호 발화.
- **WS3-T2 (무거움) [의존 T1]** — 프롬프트 규율을 코드로 대체: 컨텍스트 압력 경계에서 자동 checkpoint→handoff로 관제탑을 fresh context로 리셋(그래프는 이미 디스크). 파일: `autopilot-loop.ts` + `skills/handoff`. 검증: 긴 run이 경계에서 실제 리셋되며 그래프 무손실로 이어감.
- (WS4-T1 health-delta는 원래 LOOP 후속이나 **지금은 보류** — boxwood 비-ditto 스택 미확인 게이트(Q10) + 계획의 `fitness.ts`/`drift.ts` 경로 오류. 실제 경로는 `src/acg/fitness/*`·`src/cli/commands/fitness.ts`. 이 레인에서 안 함.)

## 2. 프로세스 (표준 경로 — WI 밖 편집 금지)
1. `ditto work start` 로 이 레인 WI 생성(prism WI 아님).
2. Route by weight: **WS3-T1**은 국소(autopilot-loop 회계 추가) → 경량 경로 가능(`ditto work set-criteria` → 구현 → `ditto verify` → `ditto work done`). **WS3-T2**는 다표면·오케스트레이터 리셋 → heavy(`/ditto:deep-interview` → pre-mortem → `ditto autopilot`).
3. 완료는 AC별 fresh 증거로만. 미검증을 pass로 쓰지 말 것.

## 3. Gotchas (이 repo)
- dogfood CLI = `./bin/ditto`(working-tree). src 변경 후 `bun run build:bin` 재빌드.
- 커밋 훅 = `core.hooksPath=.githooks`(pre-commit이 bin/ditto 재빌드+자동 스테이징). 무관 변경 새면 `git add <내것>` 후 `--no-verify` 또는 `DITTO_SKIP_HOOKS=1`.
- implementer 반환 게이트 = `bunx tsc --noEmit`(touched files) — bun test는 타입체크 안 함(`noUncheckedIndexedAccess`의 `arr[i]` 재발).
- 모든 autopilot 노드 record에 evidence_refs 필수(AC 채점=addressing 노드 worst-wins, 없으면 unverified로 끌림).
- **push는 사용자 명시 허가 후만**(charter §4-8). 레인 커밋은 별도 브랜치 → push → main 머지(파일 disjoint라 무충돌).

## 4. 착수 후 첫 확인
`grep -n post_cost src/core/autopilot-loop.ts` 로 회계 삽입 지점 확정 → WS3-T1 set-criteria.
