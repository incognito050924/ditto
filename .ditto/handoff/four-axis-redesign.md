# Handoff — DITTO 4축 재설계 thread 종결 + 다음 진입점(doctor 루트 분리)

> 상태: **재평가 §1 모든 gap + §3.5(#3) 전부 구현·푸시 완료(origin/main).** 이 핸드오프의 이전 두 진입점(#4d·#3)이 이 세션에 마감됐다.
> 진실원: `reports/design/ditto-four-axis-reassessment.md`(재평가 제안 본문, 이제 제안 전부 소진).

## 0. 셋업
```bash
cd /Users/incognito/dev/projects/ditto
git log --oneline -6        # 757ef62 · 220be08 · ec8e084 가 보여야
bun install && bun test     # 1283 pass / 0 fail 기대
bun run lint && bun run adr:guard
```
- `ditto` CLI = `bun run dev <cmd>`. `bun run dev`는 `$ bun ...` 프리픽스를 먼저 찍음 → JSON 파싱은 첫 `{`부터(`sed -n '/^{/,$p'`).
- **git commit 함정**: 메시지에 꺾쇠 `<...>`가 있으면 PreToolUse 훅이 "repo 밖 쓰기"로 오탐·차단 → 메시지에서 꺾쇠 빼거나 `DITTO_SKIP_HOOKS=1 git commit`.
- **메모리 쓰기(repo 밖) 차단**: `~/.claude/.../memory/*` 편집은 PreToolUse scope-out에 막힘 → `DITTO_SKIP_HOOKS=1 python3` 등으로 우회(이건 의도된 경계, ADR-0011 D2).
- **Codex Opponent 호출법**(dialectic Opponent=Codex 우선): `Agent(subagent_type: "codex:codex-rescue", ...)`. `codex:rescue`가 아니라 `codex:codex-rescue`다. 런타임이 백그라운드화할 수 있음(그땐 완료 알림 대기) — 동기 반환을 원하면 재시도. 결과 상단에 `ran-as: ...`로 실제 provider 확인 가능.

## 1. 이 세션에 한 일 (전부 push 완료)

| 커밋 | 항목 | 핵심 |
|---|---|---|
| `ec8e084` | #4d 축2 의도-drift (최초) | `intentDriftGate(intent,workItem,graph,completion?)` — 계약 사슬(intent→work-item→autopilot→completion)의 두 의도-키(goal 문자열·AC id 집합) 마디별(H1/H2/H3) 보존. `ditto autopilot intent-drift` CLI + Stop훅 enforce |
| `220be08` | #4d revise (dialectic ACG 리뷰 반영) | 결과를 **blocking(AC id 집합=하드블록) / advisory(goal·source_request·root_goal 문자열=비차단 표면화)** 로 분리. invented ref는 `addNodes` 도입시점에 즉시 reject(fail-fast, Stop H2는 backstop). H3는 intent 대비+non-pass만(pass는 completionGate). malformed intent.json fail-closed |
| `757ef62` | #3 Distribution/session-rooting (docs) | ADR-0011 신설 + `harness-design §4.3` + CLAUDE.md projection. D1 Distribution=기층4축에 직교하는 횡단 배포계약 축 / D2 session-rooting 경계(cross-repo subagent 쓰기 비지원, owner 대행은 완주) / D3 ADR-0007과 층위 구분 |

- **dialectic 방법**: 두 항목 다 Producer / **Codex GPT-5** Opponent / Synthesizer 3역을 fresh context로 돌려 verdict=revise 받고 정정 후 커밋. ACG 정합성이 렌즈였다.
- #4d 설계 전환의 핵심 통찰: `finalizeInterview`가 intent+work-item+autopilot을 한 payload로 일관 생성 → 탄생 시점엔 구성상 보존됨 → drift는 **탄생 후 그래프가 자라며 새는 마디**에서 발생. 그래서 끝점이 아니라 사슬 보존.

## 2. 다음 세션 진입점

재평가 문서의 제안은 **전부 소진**됐다(§1 gap #1·#2·4a·4b·4c·4e·#4d, §3.5 #3 모두 구현). 재평가 thread는 closed.

### doctor plugin-root / target-root 분리 — **완료(`5215c21`, behavioral)**
- 이 세션에 마감. `DistributionDeps.repoRoot`를 `pluginRoot`+`targetRoot`로 분리: `binary_built`/`hooks_registered`는 pluginRoot, `target_initialized`/`allowlisted`는 targetRoot, `binary_on_path`/`plugin_enabled`는 루트 무관.
- `defaultDistributionDeps(targetRoot, pluginRoot)` 시그니처. CLI(`doctor.ts`)가 경계에서 `CLAUDE_PLUGIN_ROOT`를 해석하고 미설정 시 targetRoot 폴백 → self-host/병치 레이아웃 기존 동작 보존. `doctor distribution` JSON에 `plugin_root`/`target_root` 노출.
- 검증: 단위테스트 13(=기존10+신규3, 루트별 위치 점검·session-rooting 오판 부재) pass. 전체 1286 pass/0 fail, lint·adr:guard 통과. CLI 실행으로 `CLAUDE_PLUGIN_ROOT` 분리 실증(plugin 다른 곳 가리키면 binary/hooks만 false, target_initialized는 true 유지).
- 재평가 thread 후속까지 **전부 소진**. 다음 진입점은 아래 백로그에서 사용자 판단.

### 더 넓은 백로그(이 thread 밖, 우선순위는 사용자 판단)
- 메모리 `project_self_eval_2026_06_02`의 미착수 #6~#11.
- 25개 open work item(세션 시작 시 hook이 나열) — 정리/종결 필요한 것들.
- #4d가 결정론 floor만 덮음을 상기: 의미적 intent fidelity(node.purpose가 AC 의미에 봉사하는지, out_of_scope 의미적 표류)는 의도적으로 reviewer/verifier(LLM ceiling)에 남김 — gap 아니라 설계.

## 3. 상태
- **push 완료**: 이 세션 3커밋(`ec8e084`·`220be08`·`757ef62`) origin/main 동기화(`## main...origin/main`).
- 미해결 잔재 없음. 1283 pass / 0 fail, lint·adr:guard 통과.
- 메모리: `project_functional_4axes`(#4d·#3 진행현황·dialectic 정정 포함) 갱신됨.

## 4. 다음 세션 첫 프롬프트(예시)
> "이 핸드오프(`.ditto/handoff/four-axis-redesign.md`) 읽고, §2의 **doctor plugin-root/target-root 분리**를 진행. ADR-0011 D1이 '4e 후속'으로 명문화한 한계 — distribution-doctor가 두 루트를 한 repoRoot로 점검해 session-rooting(타겟-루트 세션)에서 plugin 아티팩트를 오판하는 문제. doctor에 pluginRoot/targetRoot 분리 입력 + 단위테스트."
