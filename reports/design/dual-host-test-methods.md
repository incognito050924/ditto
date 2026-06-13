# Dual-host 테스트 방법 기록 — Claude Code 세션에서 실행한 절차 (Codex 재현 기준)

> **목적**: 2026-06-13 Claude Code 세션에서 DITTO를 라이브로 검증한 방법을 그대로 기록한다. Codex 세션에서 같은 절차를 돌려 host 통합(층위③)·LLM 행위(층위④)를 실증하기 위한 기준 문서다.
> **소비자**: Codex 세션을 띄울 사람(또는 에이전트).
> **표기**: 각 절차에 `[agnostic]`(host 무관) · `[claude]`(Claude 전용, Codex 대응 필요) · `[codex-target]`(Codex에서 반드시 재현할 것)을 단다.
> **출처**: 모두 이 세션에서 실제 실행한 명령. 추정 아님.

---

## 0. 환경 전제 / 함정 (먼저 읽을 것)

- **`DITTO_SKIP_HOOKS=1` 누출 주의** `[agnostic]`
  - DITTO의 PreToolUse 훅이 활성이면, 정상 read-only 명령도 secret/scope-out false-positive로 막힐 수 있다. CLI를 직접 돌릴 때 `DITTO_SKIP_HOOKS=1` prefix로 우회한다.
  - **함정**: 이 변수는 자식 프로세스로 상속된다. hook 자체를 테스트할 때 `DITTO_SKIP_HOOKS=1`이 환경에 있으면 검사 대상 hook이 bypass되어 거짓 통과/실패가 난다. hook 동작을 검증하는 명령은 이 변수를 **반드시 제거**하고 실행한다 (`env -u DITTO_SKIP_HOOKS ...`).
- **repo 밖 쓰기 차단** `[agnostic]` PreToolUse 훅이 `/tmp` 등 repo 밖 쓰기를 막는다. 임시 파일은 repo 안(`.ditto/local/...`)에 만든다.
- **샌드박스 정리** `[agnostic]` 메커니즘 검증용 샌드박스 work item(`.ditto/local/work-items/wi_*`)·memory 이벤트는 검증 후 제거해 추적 상태를 원복한다. `.ditto/memory/`는 추적 tier라 오염 주의(`.ditto/local/`은 gitignore).
- **설치 확인** `[agnostic]` `which ditto` → 심링크가 `dist/<...>/bin/ditto`를 가리키는지. 이 세션 기준: `~/.local/bin/ditto` → `dist/plugin/bin/ditto`.

---

## 1. ditto CLI 기능 스모크 `[agnostic]` (Codex에서도 동일하게 돌 것)

```bash
# doctor 7종 — host instruction/permission/mcp/surface/capability/distribution/intent-quality
for c in instructions permissions mcp surface capability distribution; do
  echo "== $c =="; ditto doctor $c 2>&1; done
ditto doctor intent-quality
ditto doctor codeql               # 타깃 적합성 (fail-closed)

# work item / context / knowledge / fitness
ditto work status                          # 전체 work item
ditto context build --workItem <wi>        # context-packet.md 생성
ditto knowledge gate --json '{"triggers":{"adr_worthy_decision":true,"new_agreed_term":false,"repeated_pattern":false},"delta":{"decisions":1,"glossary_terms":0,"patterns":0,"learnings":0}}'
# fitness: --from에 deterministic 함수(JSON) 주면 stdout 한 줄=위반 1건 계약
#   spec="true"(출력없음)→pass, spec="echo X"(1줄)+on_violation:block→fail
ditto fitness run --work-item <wi> --from <ff.json> --risk low --risk-known --execute --output json
```
**판정 기준**: permissions는 `.claude/settings.json`·`.codex/config.toml` 존재 시 ok, 부재 시 `missing`(실패 아님, exit 0 — `doctor.ts:113-114`가 missing을 dangerous에서 제외). fitness 게이트가 위반 줄 유무로 pass/fail을 정확히 가르는지.

---

## 2. Host hook 동작 — apply_patch 안전게이트 (Codex 핵심) `[codex-target]`

DITTO의 가장 중요한 host 통합 안전장치. Codex는 편집을 `tool_name="apply_patch"` + `tool_input.command`(패치 본문)로 보낸다. 게이트는 패치가 건드리는 **모든 경로**에 secret/scope-out/forbidden_scope/lease를 적용한다.

### 2-A. handler 직접 구동 (단위 계약)
```bash
# secret 경로 편집 → 차단(exit 2)
echo '{"cwd":"<projectDir>","session_id":"s","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: config/.env\n@@\n-old\n+new\n*** End Patch"}}' \
  | env -u CLAUDE_PROJECT_DIR -u DITTO_SKIP_HOOKS <bin>/ditto hook pre-tool-use --host codex
# 기대: exit 2, stderr에 "secret"
```
참조 픽스처: `tests/host/codex/applypatch-safety.surface.test.ts` (Case 1~6c: forbidden_scope/secret/rename/multi-file 차단 + PostToolUse edit evidence 기록).

### 2-B. **배포 seam 검증 (OBJ-1, 가장 중요)** `[codex-target]`
> 2-A는 `--host codex`를 **직접 줘서** handler 로직만 본다. 실제 Codex 런타임은 `dist/codex-plugin/hooks/hooks.json`의 명령으로 hook을 부른다 — 이 명령이 `--host codex`를 실제로 선택하는지가 핵심. (OBJ-1: 과거엔 `--host` 누락으로 claude-code default → 게이트 미발화 false-green.)

```bash
# 빌드
bun run scripts/build-codex-plugin.mjs
# 배포 매니페스트 명령이 --host codex를 갖는지 (artifact 단언)
grep 'pre-tool-use' dist/codex-plugin/hooks/hooks.json   # 기대: "...hook pre-tool-use --host codex"
grep 'pre-tool-use' hooks/hooks.json                     # 기대: --host 없음 (Claude 소스 불변, byte-identical)

# 매니페스트 명령을 추출해 그대로 구동 (--host 하드코딩 금지) → secret apply_patch 차단
CMD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/codex-plugin/hooks/hooks.json")).hooks.PreToolUse[0].hooks[0].command)')
echo '{"cwd":"<projectDir>","session_id":"s","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: config/.env\n@@\n-old\n+new\n*** End Patch"}}' \
  | env -u CLAUDE_PROJECT_DIR -u DITTO_SKIP_HOOKS CLAUDE_PLUGIN_ROOT="$PWD/dist/codex-plugin" sh -c "$CMD"
# 기대: exit 2, stderr "secret". (수정 전이면 exit 0 = false-green)
```
자동화 픽스처: `tests/host/codex/applypatch-deploy-seam.surface.test.ts`.
**Codex 실증 추가 과제**: 위는 빌드 산출물을 sh로 흉내낸 것. Codex 세션에서는 **실제 `codex` 바이너리가 이 플러그인을 로드하고 PreToolUse를 실제 발화**하는지(파일 존재·JSON 파싱이 아니라 런타임 load)를 확인해야 함 — 이게 아직 미검증인 층위③.

---

## 3. Skill 오케스트레이션 dogfooding (층위④) `[codex-target]`

각 skill을 알려진 시나리오에 발화하고 산출물을 사람이 판정한 방법. Codex 세션에서 동일 시나리오로 돌려 surface가 실제 로드·동작하는지 본다.

| skill | 발화 방법 | 판정 기준(무엇을 보면 "동작"인가) |
|-------|----------|-------------------------------|
| **dialectic-review / dialectic** | 실제 초안 문서에 `/ditto:dialectic-review <file>`. driver(main agent)가 Producer/Opponent/Synthesizer를 **각각 별도 Task로 spawn**. Opponent는 Codex 우선(`codex:rescue`). | 3역할이 별도 spawn됐나 · Opponent가 oracle 달린 이의를 냈나 · Synthesizer verdict(accept/revise/reject/blocked) · `reviews/dialectic-<n>.json` ledger 생성 |
| **autopilot** | 최소 intent.json 만들고 `ditto autopilot bootstrap --workItem <wi>` → `next-node`(ready 선택+dispatch packet) → owner 실제 spawn → `record-result --json {...}`(G7 guard·classify·persist) → `next-node`(진행) | bootstrap이 그래프 생성 · next-node가 ready 노드+packet 반환 · record-result가 guard_contentful/persist · 그래프가 다음 노드로 진행. **gotcha**: planner generated_nodes id가 seed 노드와 충돌(duplicate node id) |
| **deep-interview** | `ditto deep-interview start --workItem <wi>` → `record-turn --json {dimension,question,answer,readiness_score}` 반복 → `check-readiness` → `finalize --json {goal,acceptance_criteria,user_confirmation}` | readiness gate가 turn 0/critical 미해결에서 fail, critical resolved+self-reported≥threshold에서 pass · finalize 2차게이트(user_confirmation은 비어있지 않은 statement 필수) · intent.json+autopilot 생성 |
| **tech-spec** | TEMPLATE.md 형식(한국어 섹션 헤더 + 완료조건/위험 **표**) 문서 작성 → `ditto tech-spec start --doc <md>` → `record-section`(배경·영향도 factual은 evidence 필수, ac-9) → `finalize --json {risk,user_confirmation}` | 누락 섹션·factual evidence 부재 시 fail-closed · doc→intent.json compile(요약→goal, 완료조건표→AC) + source_digest(sha256) |
| **verify** | `/ditto:verify` 또는 verifier 에이전트에 검증 대상 claim+AC 위임 (fresh evidence, 작성자 자기평가 불신) | per-AC verdict(pass/fail/partial/unverified) + 재현 명령+exit code+file:line + completion-contract 요약 |
| **knowledge-update** | `ditto knowledge gate --json {triggers,delta}` — under(트리거O·기록0)·over(트리거0·기록N)·balanced 3시나리오 | under→FAIL(under-recording) · over→FAIL(noise) · balanced→PASS |
| **memory-graph** | read: `ditto memory query <node> --depth 2` / `explain <node>` / `query <txt> --text`. write: `ditto memory propose --type observation --text ...` → `ditto memory approve <id> --by <user> --actor user` | query/explain이 freshness+drift provenance(projection_id·code_drift·drifted_sources) 운반 · propose가 pending 생성(agent 자가승인 불가) · approve가 immutable 새 이벤트+re-projection. **정리**: 추가 이벤트 제거 후 `ditto memory project`로 원복(projection은 event-set hash로 content-addressed) |
| **handoff** | `ditto work handoff <wi>` | 최소맥락 문서+completion 계약(original_intent·current_state·changed_files[git diff]·next_first_check·forbidden_scope_creep) |
| **e2e / e2e-author** | `ditto e2e applicable` — web UI 유무 자기판정. DSL 있으면 `ditto e2e digest --journey <md>`(canonical sha256, 멱등) | CLI 저장소엔 web surface 없음 → `N/A — no web UI detected`. digest는 결정론적 |

**dogfooding 매트릭스 산출물**: `.ditto/local/work-items/wi_260613afv/dogfooding-matrix.md` (Claude 세션 결과: 8 PASS·1 PARTIAL·2 N/A). Codex 세션에서 같은 표를 채워 Claude와 대조한다.

---

## 4. 전체 테스트 스위트 실행법 `[agnostic]`

```bash
# 함정: DITTO_SKIP_HOOKS=1을 prefix하면 host hook 테스트가 bypass되어 일부 거짓 실패.
#   suite는 가능하면 변수 없이, 또는 테스트가 자체적으로 strip하도록(아래) 돌린다.
env -u DITTO_SKIP_HOOKS bun test            # 권장: 격리 실행
bun run lint                                 # biome — pre-commit 게이트
```
- 호스트 surface 테스트(`tests/host/*`)의 `runHook`/`runCodexHook`은 spawn env에서 `DITTO_SKIP_HOOKS`를 제거해 격리해야 한다(2026-06-13 Claude `hooks-envelope` 격리 수정의 교훈). Codex 쪽 신규 테스트도 동일 패턴.
- 이 세션 최종: **1909 pass / 0 fail** (DITTO_SKIP_HOOKS 유무 양쪽).

---

## 5. Codex 세션에서 추가로 해야 할 것 (Claude에서 못 한 것)

1. **실 Codex 바이너리 plugin load** — `dist/codex-plugin`을 실제 Codex에 install(M5 setup host 분기) 후, codex가 skill·hook·agent surface를 실제로 발견·로드하는지. (파일 존재 ≠ 로드)
2. **실 Codex hook 발화** — codex 세션에서 apply_patch 편집 시 PreToolUse가 실제로 발화해 §2-B 게이트가 도는지. (지금까지는 `ditto hook --host codex`를 sh로 흉내낸 것뿐)
3. **skill을 codex가 실제 실행** — §3 dogfooding을 codex 호스트에서 발화해 Claude 결과와 대조.
4. **agent TOML 로드** — `dist/codex-plugin/.codex/agents/*.toml`(15개)을 codex custom-agent로 실제 로드하는지(plugin-bundled agent 경로는 공식 미문서, plan M4 obj 2).

> 요컨대 Claude 세션은 **fixture-green + handler 단위 + skill 행위(층위④)**까지 실증했다. Codex 세션이 메울 것은 **실 바이너리 런타임 load·발화(층위③)** 다.
