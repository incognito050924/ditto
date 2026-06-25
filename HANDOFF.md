# HANDOFF (원격·cross-PC) — 다른 PC에서 git으로 이어받기 (2026-06-26)

이 문서는 **원격/cross-PC** 핸드오프다(commit → push → 다른 PC pull). 같은 머신의 로컬 새 세션은 이 문서가 아니라 `.ditto/local/`(work-items·memory) + `.ditto/local/handoff/`를 쓴다.

호스트 메모리(`~/.claude` auto-memory)·work-items(`.ditto/local/`, gitignored)는 **이 문서를 읽는 다른 PC엔 없다** — 본문이 가리키는 로컬 참조는 fresh clone에서 코드·테스트·ADR로 재유도해야 한다. 코드·테스트·git·커밋된 ADR이 권위(§4-11). **다음 작업 = ditto work-lifecycle 개선(§3) — 설계부터.**

## 0. 전파 상태 (먼저 읽기)

- 이 세션이 **far-field 브랜치(`wi-relevance-gate`)를 main에 FF 병합 + origin/main push**. origin/main: `32c6d61` → **이 HEAD**(FF, force 아님). `32c6d61` 이하 동기 clone은 단순 `git pull`로 이어받음.
- 이 push로 **처음 전파되는 이전 세션분**: `c43ea4d`(knowledge.json decisions[] 폐기, 아래 §1-prior) + far-field 전부 + 이 핸드오프/문서 커밋.
- 과거 main force-rewrite(codex 분리 → `codex/dogfood-surface`) 이력 있음 — 그보다 오래된 clone은 `git fetch && git reset --hard origin/main` 후 재적용 필요할 수 있음. 이번 push 자체는 FF.
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`**. 정상 CLI는 `DITTO_SKIP_HOOKS=1` prefix. 커밋 훅=`core.hooksPath=.githooks`(pre-commit: bin 재빌드+스테이징·biome·adr-guard·adr-check·check-test-isolation; post-commit: dist/plugin 재조립). 깨끗 clone 첫 `bun test` 전 `bun run surfaces:gen`.

## 1. 이번 세션 landed (far-field 관련성 게이트 — main에 병합)

far-field pre-mortem coverage를 "카테고리=이진 관련성 게이트(관련=끝까지 전수·무관=감사가능 skip)"로 재설계·구현 **완료**(설계 wi_2606258zu·구현 wi_260625l0v). 권위 설계 SoT=`reports/design/premortem-relevance-gate-redesign.md`, 결정=`ADR-20260625-premortem-relevance-gate.md`(ADR-0023 폭 계약 부분 supersede).

- **결정적 코어**: 게이트 `coverage-taxonomy.farFieldCoverageNodes`(verdict로 무관 카테고리 사전close) · §5 안전 assembler `coverage-relevance.assembleRelevanceVerdicts`(skip=justified ∧ refute-생존) · seed 배선 `coverage-loop` · CLI seam `autopilot coverage-next --relevance`.
- **producer**: 새 에이전트 `agents/relevance-judge.md`(§5-2 근거결박, read-only) + refute=`dialectic-opponent` **일괄(batch) 재사용**(skip 후보 전체 한 패스) + `skills/autopilot/SKILL.md` §2b.0 배선.
- **입도**: 번들 정적 원자화(security-privacy→4·resource-abuse→2 facet), floor **19→23**.
- **비용 실측(§8-5)**: 실 subagent_tokens — judge~48.5k·일괄refute 50k(per-candidate 1.07M 대비 ~21×)·per-category sweep~114k. 한계비용 net-positive(저관련 ~92% 절감) → 게이트 기본 ON. **라이브 검증**: 실 CLI `coverage-next --relevance`가 실 coverage.json에 사전close 확인.
- **버그2(wi_260625txs)**: 측정 sweep이 깐 coverage store 결함 — writeDryCounter 비원자→atomicWriteText, recordCoverageRound addNode 재시도 비멱등→dedup. behavioral TDD.
- full suite **2950 pass/0 fail**, fresh 리뷰 다회 SOUND, 훅 통과.

### 1-prior. 이번 push로 함께 전파 (이전 세션, 이미 main)
- `c43ea4d` knowledge.json decisions[] 인덱스 폐기(wi_2606247cx DONE) — 런타임 orphan(소비자 0, adr-check check 3 자기참조)이라 §4-11 위반으로 폐기. adr/*.md가 결정 SoT. ADR-20260624 amendment로 check 3 철회.

## 2. 다음 작업 — ditto work-lifecycle 개선 (설계부터)

**사용자가 새 세션에서 설계부터 진행할 과제. 코드 변경 아님 — deep-interview/tech-spec 먼저.** 권위 문서=**`reports/design/ditto-work-lifecycle-gaps.md`**(이 세션 작성, 커밋됨). far-field 줄기 회고에서 사용자가 짚은 ditto 자체 결함 6개를 실제 표면에 결박해 정리.

- **핵심**: ditto가 "풀 세리머니(deep-interview→autopilot) 아니면 무절차" 둘만 줘서 에이전트가 즉흥 TDD로 빠지고, 그 작업이 추적·종결·묶음·정결한 배포가 안 됨. 정정: 다수 결함이 "없음"이 아니라 "있지만 미연결·placeholder friction으로 막힘"(예: `work start→ditto verify→work done` 경량 경로 *존재*하나, placeholder AC를 진짜 기준으로 바꾸는 경량 세터 부재로 진입 불가).
- **권장 착수 순서**: ① 경량 진짜-기준 세터 + 경량경로 기본값화(결함1·2·3, 뿌리) → ② 후속 물질화+backlog(결함5) → ③ WI 묶음/배치(결함4, parent_id/child_ids 위) → ④ push↔완료 결합(결함6).
- **동반 행동 기준**(문서 §1 + memory `completion-not-residual-handoff`): 시킨 작업은 검증된 자기완결까지 민다 / 검증 가능하면 지금 한다 / 후속을 산문목록으로 사용자에게 떠넘기지 않는다.

## 3. 폐기된 후보 — 다시 살리지 말 것

- **surface-inventory `length===40/41` 동적화 = 폐기**: 매직넘버는 brittleness가 아니라 **의도된 tripwire**(플러그인 표면=capability/보안 표면 수 변경을 강제 acknowledge). `surfaces.json` gitignored·재생성이라 scan-match 테스트는 인벤토리 증가를 절대 안 알림 → 동적화=vacuous, 제거=net-negative.
- **check-test-isolation read-의존 정적 검출 = 폐기**: 실 repo 읽기는 ditto에서 보통 정당(self-host, 15+곳). read는 정당 다수=저신호 → 가드는 마찰만. semantic 판단은 reviewer/verifier 렌즈(`agents/reviewer.md`)가 담당. 환경의존 false-fail은 per-test skipIf(1929e1a)가 해법.
- **far-field tier 깊이-throttle = 비용레버로 부적합**(사용자 명시 기각): far-field 축은 깊이 아니라 관련성. "전량 전수"도 되살리지 말 것(이제 "관련 카테고리 전수").

## 4. GOTCHA

- **close-path**: `ditto work done`은 completion final_verdict=pass 요구. placeholder AC면 거부 → 실 AC 잠그고 `ditto verify <wi> --criterion <ac> -- <cmd>`(0종료=pass) 후 done. (이 마찰 자체가 §2 개선 과제의 결함3.) `.ditto/local`은 PC 간 전파 안 됨.
- **커밋 훅 `.githooks`**: pre-commit이 bin 재빌드+스테이징 → 무관 src 변경 있으면 bin 번들로 새어듦. 분리 커밋은 `git add <내것>` 후 `--no-verify`. amend 전 `./node_modules/.bin/biome check --write <내 .ts만>`.
- **push 후 amend 금지**: push했으면 이후는 새 커밋으로(amend는 force-push 유발, 이 repo는 force가 권한 게이트). 일반 push는 허용·force만 게이트 — divergence 시 origin 위 FF로 재구성해 plain push.
- **`schemas:export`는 전체 json 재생성** — 내 것만 남기고 나머지 `git checkout HEAD --` 외과 복원.
- **dogfood CLI는 `./bin/ditto`**(working-tree). 설치본은 stale 가능 — src 변경 후 `bun run build:bin`. 새 에이전트 추가 시 surface 핀 4곳 + `surfaces:gen`.
