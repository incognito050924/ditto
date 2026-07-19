# doctor — 호스트/배포/품질 drift를 진단하고 일부를 자동 교정하는 진단 커맨드 모음

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto doctor`는 "지금 이 설치·이 프로젝트가 정상 상태인가?"를 여러 각도에서 **읽어서 진단**하고, 그중 되돌릴 수 있는 몇 가지만 `--fix`로 **교정**하는 진단 표면이다. 핵심 개념은 두 가지다.

1. **drift 검출**: DITTO는 호스트(Claude Code·Codex) 위에 지침·권한·MCP·표면(skill/agent/command)·hooks·배포 아티팩트를 얹는다. 이것들이 원본(source of truth)과 어긋나면 기능이 조용히 죽는다 — 예컨대 hooks 바이너리가 stale하면 옛 정책이 통과된다. doctor는 이 어긋남을 명시적으로 표면화한다.
2. **측정(measurement) 판독**: 이미 디스크에 쌓인 산출물(`completion.json`, `interview-state.json`, retro ledger 등)을 **새 계측 없이** 집계해 프로세스 품질을 읽는다.

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 어느 하나에만 속하지 않는다. `distribution`은 ADR-0011이 정한 **횡단 배포계약 축**을 점검하고, `capability`/`instructions`/`permissions`/`mcp`/`surface`는 **기층(Hooks/Skills/Agents/State) + dual-host 패리티**(ADR-0016)를 점검하며, `intent-quality`/`completion-coverage`/`backlog`/`retro-trend`는 **의도·지식 축의 품질 계측**이다. 즉 doctor는 "축을 실행하는 기능"이 아니라 "축들이 살아있는지 감시하는 계기판"이다.

## 2. 코드 위치와 진입점

핵심 파일:

| 경로 | 역할 |
|---|---|
| `src/cli/commands/doctor.ts` | 진입점. 13개 서브커맨드 정의 + IO/exit-code 배선 (top-level `run` 없음) |
| `src/core/doctor-fix.ts` | `--fix` 교정 코어. 검출은 하지 않고, 넘겨받은 finding을 교정·가역성 분류·적용 |
| `src/core/distribution-doctor.ts` | 기층 4축 배포계약 점검 (binary/hooks/surface/state/allowlist) |
| `src/core/capability-inventory.ts` | 호스트 필수 capability 패리티 + hook 선언↔등록 drift |
| `src/core/permission-inventory.ts` | 위험한 권한 설정(와일드카드 allow, danger-full-access 등) 분류 |
| `src/core/mcp-inventory.ts` | 호스트 MCP 서버 목록 (정보성) |
| `src/core/github-config-doctor.ts` | 로컬 github config의 `claim_status_map.in_progress` 누락 점검 (local-only, no-fix) |
| `src/core/completion-coverage-doctor.ts` | 증거로 닫힌 acceptance 비율 집계 |
| `src/core/intent-quality-doctor.ts` | deep-interview 의도 신호 vs 하류 rework 집계 |
| `src/core/surface-inventory.ts` | 카탈로그↔실제 표면 drift (surface 서브커맨드) |
| `src/core/instruction-bridge.ts` | AGENTS.md↔호스트 투영 drift (instructions 서브커맨드) |
| `src/core/codeql/doctor.ts` | CodeQL 분석 적합성 fail-closed 점검 (codeql 서브커맨드) |
| `src/core/retro-metric-ledger.ts` | ADR-0024 floor 철회조건용 retro 추이 (retro-trend) |

주의 (미확인/정정): 조사 스코프 힌트에 `src/core/mode-doctor.ts`가 포함됐으나, 이 모듈은 `ditto doctor`에 **배선돼 있지 않다**. `doctor.ts`는 mode-doctor를 import하지 않으며, mode-doctor는 `ditto mode`(`src/cli/commands/mode.ts:3`), `ditto release`(`release.ts:5`), SessionStart 훅(`src/hooks/session-start.ts:2`)이 쓴다. 따라서 아래 본문에서 mode-doctor는 다루지 않는다(다른 커맨드 소관).

### 서브커맨드 표

top-level `doctorCommand`는 `run`이 없고 `subCommands`만 가진다(`doctor.ts:870-891`) — 즉 `ditto doctor` 단독 실행은 아무 점검도 돌리지 않고 도움말만 낸다. **모든 검사를 한 번에 도는 집계 실행은 존재하지 않는다.** 각 검사는 개별 서브커맨드다.

| 서브커맨드 | 성격 | `--fix` | `--advisory` | drift 시 exit |
|---|---|---|---|---|
| `instructions` | drift 검출 | O (managed block 재투영) | O | 1 |
| `permissions` | drift 검출 | X | O | 1 (위험 finding>0) |
| `mcp` | 정보성 | X | **거부**(usage error) | 항상 0 |
| `surface` | drift 검출 | X | O | 1 |
| `capability` | drift 검출 | X | O | 1 (unverified는 0) |
| `codeql` | 적합성(fail-closed) | X (`--install`은 별개) | O | 1 |
| `distribution` | drift 검출 | O (allowlist만) | O | 1 (unverified는 0) |
| `intent-quality` | 측정 | X | X | 항상 0 |
| `completion-coverage` | 측정 | X | X | 항상 0 |
| `backlog` | 위생 판독(read-only) | X | X | 항상 0 |
| `retro-trend` | 측정 | X | X | 항상 0 |
| `variants` | drift 검출 | O (orphan 등록) | O | 1 |
| `github` | drift 검출(local-only) | X (계약상 no-fix) | O | 1 |

공통 인자: 대부분 `--host codex|claude-code`(생략 시 전 호스트), `--output human|json`. 몇몇 측정 커맨드는 `--work-item <id>`로 단일 work item 스코프.

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

doctor는 **읽기 위주**다. `--fix` 3종을 빼면 어떤 서브커맨드도 상태를 쓰지 않는다. 전형적 흐름:

```
CLI args (host/output/advisory)
  → resolveRepoRootForCreate()            # 세션 타겟 repo 루트
  → [distribution·capability만] resolvePluginRoot()   # 플러그인 자기 설치 위치(env→self→registry)
  → collect*(...) : 파일/설정/카탈로그 읽기 → 순수 평가 → report
  → format=json ? writeJson(report) : writeHuman(줄 단위)
  → exitForFindings(count, advisory)      # count>0 ∧ !advisory → exit 1
```

`--fix` 흐름(instructions/distribution/variants):

```
동일 검출 함수로 finding 산출
  → plan*Fixes(finding) : FixItem[] 로 변환 (가역성 분류 포함)
  → runFix(repoRoot, items) → applyDoctorFixes(deps, items)
      · reversible  → 자동 적용
      · !reversible → confirmNonReversible() (TTY 확인; 비-TTY면 false→skip)
  → "fixed / skipped / nothing to fix" 보고, drift exit 절대 안 냄
```

읽고/쓰는 주요 상태 경로(스키마가 SoT — ADR-0002):

- 읽기: 호스트 설정(`.claude/settings.json`, codex TOML), 카탈로그(`.ditto/local/surfaces.json`·`surfaces.codex.json`, `surface-catalog` 스키마), `.ditto/local/config.json`(github block, `ditto-config` 스키마), work item별 `completion.json`(`completion-contract`), `interview-state.json`(`interview-state`), `autopilot.json`/`autopilot-decisions.jsonl`, `metrics.jsonl`(`intent-metric`), `question-rounds.jsonl`(`question-round`), retro ledger, 아카이브(`.ditto/local/archive/<label>/<wi>/`).
- 쓰기(오직 `--fix`): `CLAUDE.md` managed block 재투영(+`.bak` 백업), 프로젝트 `.claude/settings.json`의 `Bash(ditto:*)` allow 추가, `.claude/agents/<name>.md`(= `.ditto/agents/<name>.md` 복사).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 검출과 교정의 분리 (detection ≠ repair)

`doctor-fix.ts` 헤더가 못박는다: 검출은 여기서 재구현하지 않고, "이미 검출된 drift를 먹여주면(feed) 무엇을 고칠지·가역성·적용만 결정한다"(`doctor-fix.ts:14-17`). 그래서 `--fix`는 판독 표면이 쓰던 **같은 검출**을 재사용한다 — instructions는 `report.findings`(`doctor.ts:174`), distribution은 `collectDistributionChecks(...).allowlisted`(`doctor.ts:469-470`), variants는 같은 `findOrphanVariants` 결과(`doctor.ts:800`). 효과: "진단이 본 것과 교정이 고치는 것"이 절대 어긋나지 않는다.

### 4-2. 가역성으로 게이트하는 자동 교정 (reversible auto, 비가역은 확인)

교정 대상이 프로젝트 안에 있으면 가역(auto-apply), 사용자 전역 `~/.claude`를 건드리면 비가역(TTY 확인 후에만)이다(`doctor-fix.ts:42-45`, `classifyReversible`). 근거: ADR-0011 D2 session-rooting — 세션은 타겟에 루트돼 있으므로 전역 쓰기는 세션 경계 밖으로 새는 비가역 host impact다. 비-TTY에서 `confirm`은 기본값 false를 반환해 조용히 skip한다(`doctor.ts:96-99`). 그래서 CI 같은 무인 환경에서 `--fix`는 전역을 함부로 바꾸지 않는다.

### 4-3. 정직한 unverified — 못 본 것을 drift로 날조하지 않는다

`distribution`·`capability`는 플러그인 자기 설치 위치를 `resolvePluginRoot`로 찾는다. 못 찾으면(fallback 루트엔 플러그인 표면이 없음) "missing" finding을 **confirmed drift가 아니라 `unverified`로 강등**하고 exit 0으로 끝낸다(`doctor.ts:337-344` capability, `doctor.ts:462-499` distribution). 근거: ADR-0018 D2 — 도구/맥락 부재는 정직한 unverified로 표면화하되 가짜 fail을 날조하지 않는다. ADR-0011의 알려진 한계 #7("doctor가 plugin-root와 target-root를 한 repoRoot로 점검")이 여기서 최소한 부분적으로 해소됐다 — 두 루트를 분리 resolve하고 못 찾으면 unverified로 떨어뜨린다(설계-의도↔코드 수렴, §6 참조).

### 4-4. dual-host 패리티는 fail-closed, hooks만 예외

`capability`는 `REQUIRED_CAPABILITIES = ['instructions','permissions','mcp','surface']`를 모든 선택 호스트가 지원하는지 fail-closed로 본다(`capability-inventory.ts:11`, `75-84`). `hooks`는 여기 없다 — codex가 정당히 플러그인 훅을 안 돌리므로, cross-host 동등이 아니라 **호스트별 선언↔등록 drift**로 양방향 점검한다(`capability-inventory.ts:97-116`). ADR-0016(dual-host)의 결과.

### 4-5. 측정은 새 계측 없이 기존 산출물만 집계

`completion-coverage`·`intent-quality`는 이미 persist된 파일을 읽어 집계할 뿐 새 계측을 심지 않는다(각 모듈 헤더). `isClosed`는 "verdict=pass **이고** evidence ref ≥1"일 때만 닫힌 것으로 센다(`completion-coverage-doctor.ts:30-33`) — bare pass는 주장(claim)이지 증거가 아니라는 ADR-0024 결정4(anti-SLOP)의 단일 closure 규칙을, autopilot 루프와 **공유**한다(두 곳이 drift하지 않게).

### 4-6. backlog 위생은 구조적 정의만 (벽시계 나이 금지)

`backlog`는 stale draft를 `status=draft ∧ completion 없음`, completed-unclosed를 `final_verdict=pass ∧ 비종료 상태`로 **구조적으로** 정의한다(`doctor.ts:639-663`). 벽시계 나이를 안 쓰는 이유: 여러 PC 간 시계 편차가 경계를 flap시키기 때문(`doctor.ts:621-623` 주석). 그리고 read-only — suggested_action 문자열은 조언 텍스트일 뿐 아무것도 실행하지 않는다(`doctor.ts:669-703`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### exit 코드 배선 (`doctor.ts:58-80`)

- `DRIFT_EXIT=1`, `DOCTOR_RUNTIME_ERROR_EXIT=70`, usage error는 `USAGE_ERROR_EXIT`(util). `exitCodeForError`가 잘못된 host/output 인자는 usage error로, 그 외 예외는 70으로 분류한다.
- `exitForFindings(count, advisory)`: `count>0 && advisory!==true`일 때만 `process.exit(1)`(`doctor.ts:78-80`). 이 한 함수가 "drift면 실패로 끝내되 `--advisory`면 보고만 하고 0"이라는 규약을 모든 검출 서브커맨드에 균일하게 준다.

### `runFix` / `applyDoctorFixes` (`doctor.ts:88-112`, `doctor-fix.ts:95-121`)

items를 돌며 비가역이면 `confirmNonReversible`로 확인, 가역이면 바로 적용. kind별로 `syncProjection`/`registerVariant`/`ensureAllowlist`를 부른다. `nothingToFix`(빈 items)면 "fix: nothing to fix". **drift exit을 절대 안 낸다** — 가역 작업을 마친 `--fix`는 성공이라는 판단(`doctor.ts:82-87` 주석).

### distribution 축 매핑 (`distribution-doctor.ts`)

`collectDistributionChecks`가 7개 atomic 체크를 계산(`distribution-doctor.ts:197-214`): `binary_built`/`binary_fresh`/`binary_on_path`/`plugin_surface_present`/`hooks_registered`/`target_initialized`/`allowlisted`. `evaluateDistribution`이 이를 4 기층축 계약(`AXIS_CONTRACTS`, `61-82`)으로 접어 각 축 satisfied/missing을 낸다. 미묘한 결정:
- `binary_fresh`(`183-194`): 번들에 박힌 source stamp와 현재 `src/` stamp를 비교. dev 체크아웃 밖(=`src/` 없음)에선 비교할 게 없어 **공허하게 true**. 이 공허-true가 바로 mode-doctor가 born된 함정(설치본은 `src/`가 없어 `agents/`/`skills/`가 drift해도 fresh로 읽힘) — distribution의 알려진 사각이다.
- `allowlisted`는 수집·보고하지만 **어느 축 게이트(`requires`)에도 안 들어간다**(ADR-0011 명시) — 보고용. 그래서 `--fix`가 고치는 유일 항목이면서도 finding_count엔 안 잡힌다.

### permission 위험 분류 (`permission-inventory.ts`)

`classifyAllowEntry`(`19-23`): `*`/`Bash`/`Bash(*)`/`WebFetch(*)` 같은 와일드카드 → `dangerous_mode`+`approval_bypass`; `Write(`/`Bash(rm`/`Bash(sudo` 패턴 → `write_outside_workspace`. codex 쪽은 `sandbox_mode=danger-full-access`·`network_access=true`·`approval_policy=never`를 각각 라벨링(`48-87`). CLI는 `label!=='missing' && label!=='unverified'`인 것만 세어 위험 카운트로 exit 판정(`doctor.ts:214-216`) — 즉 "설정이 없음/못 읽음"은 위험이 아니라 정보다.

### github 로컬 점검 (`github-config-doctor.ts`)

`evaluateGithubConfig`(`45-64`): github block이 있는데 `claim_status_map.in_progress`가 없을 때만 finding. block 자체가 없으면(통합 미사용) finding 없음. remediation은 `ditto github setup` 문자열(조언 텍스트, 실행 안 함). local-only — `.ditto/local/config.json`만 읽고 gh/네트워크 probe 없음(오프라인에서도 안 멈춤).

### capability codex 특례 (`capability-inventory.ts:118-128`)

codex 어댑터일 때 `.ditto/local/codex-plugin-status.json`이 `status:needs_user_action`이면 "플러그인 파일은 준비됐지만 CODEX_HOME에서 enabled 아님"을 finding으로 올리고 실행할 명령을 안내한다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `doctor.ts` 전문과 위 core 모듈 소스 정적 읽기. 런타임 실행/테스트는 이 조사에서 돌리지 않음(정적 확인).

- **일치**: 검출↔교정 재사용(§4-1), 가역성 게이트(§4-2), unverified 강등(§4-3), advisory/exit 규약(§5)은 코드에서 의도대로 배선돼 있다. 특히 ADR-0011 알려진 한계 #7(단일 repoRoot 점검)은 `distribution`/`capability`가 `resolvePluginRoot`로 plugin-root/target-root를 분리 resolve하고 못 찾으면 unverified로 떨어뜨림으로써(`doctor.ts:328-344`, `462-499`) 적어도 오탐(false DRIFT)은 막는 방향으로 수렴했다 — ADR 본문의 "4e 후속 과제"가 실제로 진전됐음.
- **정정(스코프 오류)**: `mode-doctor.ts`는 doctor 커맨드에 미배선(§2). 힌트 목록과 실제 배선이 어긋난다.
- **설계 사각(코드대로 동작하나 취약)**: distribution의 `binary_fresh`가 설치본에서 공허-true(§5). 이건 버그가 아니라 의도된 vacuous-true지만, 배포 표면(`agents/`/`skills/`) drift를 놓친다 — 그 공백을 메우려 별도로 mode-doctor(`src/core/mode-doctor.ts` 헤더가 명시)가 존재한다. 즉 "설치본 신선도" 관심사가 doctor와 mode 두 커맨드에 쪼개져 있다.
- **비대칭(의도적이나 재설계 시 눈에 띌 지점)**: `--fix`가 8개 검출 커맨드 중 3개(instructions/distribution/variants)만 지원한다. permissions·surface·capability·codeql·github는 detect-only이고, github는 계약상 no-fix(`github-config-doctor.ts:16-18`). 나머지의 미교정은 명시적 결정이 아니라 단순 미구현일 수 있음 — **미확인**(교정 부재의 근거를 소스에서 확인 못 함).

## 7. 잠재 위험·부작용·재설계 시 고려점

**재설계 시 보존해야 할 불변식**
- 검출↔교정 단일 소스(§4-1): `--fix`가 판독과 다른 검출을 쓰면 "본 것과 다른 걸 고치는" 위험이 생긴다.
- 가역성 게이트(§4-2)와 비-TTY skip: 전역 `~/.claude`를 무인 환경에서 함부로 바꾸지 않는 안전판. ADR-0011 D2에 묶여 있음.
- 정직한 unverified≠drift(§4-3, ADR-0018): 못 본 것을 fail로 날조하지 않기.
- 측정의 closure 규칙 공유(§4-5, ADR-0024): `isClosed`가 autopilot 루프와 한 소스. 여기서 갈라지면 coverage 지표가 실제 완료 게이트와 어긋난다.
- backlog의 구조적 정의(§4-6): 벽시계 나이 도입은 cross-PC 시계 편차로 경계 flapping을 부른다.

**약점·확장 시 깨질 지점**
- **집계 실행 부재**: `ditto doctor` 단독은 아무것도 점검 안 한다(§2). "설치가 건강한가?"를 한 번에 답하는 표면이 없어, 사용자가 13개 서브커맨드를 개별로 알아야 한다. 재설계 후보.
- **신선도 관심사 이원화**: 설치본 stale 판정이 distribution(`binary_fresh`, 설치본에선 공허-true)과 mode-doctor(설치본 vs 워킹트리 비교)로 쪼개짐. 통합하지 않으면 "어느 커맨드가 진짜 stale을 잡나"가 모호.
- **교정 커버리지 비대칭**(§6): detect-only 검출들이 많아 "진단은 되는데 고칠 방법은 손이 필요"한 상태. 확장 시 각 교정의 가역성 분류를 doctor-fix의 `FixKind`에 추가해야 한다.
- **동시성**: doctor는 읽기 위주라 경합 위험은 낮지만, `--fix`가 프로젝트 `.claude/settings.json`·`CLAUDE.md`를 쓰므로 다른 세션의 동시 편집과 겹치면 backup(`.bak`)이 한 번만 찍히는 점(`doctor-fix.ts:136-143`, `writeBackupOnce`)에 유의. 동시 `--fix`는 비의도적 마지막-쓰기-승리가 될 수 있음(미확인 — 락 없음).
