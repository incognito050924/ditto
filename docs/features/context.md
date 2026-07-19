# context — 워크아이템의 위임 계약(context packet)을 마크다운으로 조립하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: 커밋 `c2d2e16`, 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto context`는 하나의 work item을 서브에이전트·후속 세션에 넘길 때 필요한 **context packet(위임에 넘기는 프롬프트/계약 산출물)** 을 마크다운 한 파일로 조립한다.

- 개념 정의(glossary, `.ditto/knowledge/glossary.json:116-121`): context packet = "run에 넘기는 prompt. goal, acceptance, git state, relevant files, last failure, what-not-to-touch, evidence pointer, expected output contract로 구성된다."
- 푸는 문제: charter §4-9(위임으로 컨텍스트를 지킨다)는 탐색·조사·구현을 서브에이전트에 위임하되, 의도를 "대화 릴레이가 아니라 계약 산출물로 운반"하라고 요구한다(`CLAUDE.md` §4-9). 대화로 넘기면 단계가 늘수록 의도가 샌다(context rot·자기 서사 편향). 이 커맨드는 그 계약을 파일로 물질화해 의도(goal), 완료 기준(acceptance criteria), 현재 상태(git·runs)를 한 곳에 고정한다.
- 4축 소속: DITTO 기능 4축 중 **오케스트레이션 축의 보조 도구**로 보는 것이 타당하다(추론). work item의 상태를 위임용 프롬프트로 투영(projection)하는 read-mostly 유틸이며, 의도/E2E/지식 축의 저작 도구는 아니다.

주의: 스코프 힌트로 지목된 `src/core/question-context.ts`는 **이 커맨드와 무관하다**(§2 참고). 이름만 "context"를 공유할 뿐, deep-interview 질문의 제시 계약(presentation contract) 모듈이며 `context` CLI 어디에서도 import되지 않는다(검증: `grep`으로 `context.ts`→`context-packet.ts`만 import 확인, `src/cli/commands/context.ts:2`).

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|---|---|
| `src/cli/commands/context.ts` | CLI 진입. `context` 커맨드 + `build` 서브커맨드 정의(citty) |
| `src/core/context-packet.ts` | `buildContextPacket` — 실제 조립 로직. `ContextBuildUsageError` |
| `src/core/work-item-store.ts` | work item(Record) 로드(`WorkItemStore.get`) |
| `src/core/run-store.ts` | run manifest 로드(`RunStore.get`) |
| `src/core/git.ts` | `captureGitState` — head/branch/dirty 캡처 |
| `src/core/fs.ts` | `atomicWriteText`, `resolveRepoRootForCreate` |
| `src/schemas/common.ts` | `relativePath` — 출력 경로 검증(zod) |

서브커맨드·인자(`src/cli/commands/context.ts:6-51`):

| 경로 | 인자 | 필수 | 의미 |
|---|---|---|---|
| `ditto context build` | `--work-item <id>` | 예 | 대상 work item id (`:12-16`) |
| | `--output <path>` | 아니오 | repo-상대 출력 경로. 미지정 시 기본값(`:17-21`) |

메타 설명은 "Build and inspect context packets"(`:45`)지만 **실제 서브커맨드는 `build` 하나뿐이다**(`:48-50`). `inspect`는 존재하지 않는다(미확인이 아니라, subCommands에 없음 — 확인됨).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
--work-item <id>
   │
   ├─ WorkItemStore.get(id)   → item(title, goal, acceptance_criteria[], runs[])
   ├─ captureGitState(repoRoot) → {head, branch, dirty}
   ├─ item.runs.map(RunStore.get) → run manifest[] (실패 시 null로 흡수)
   │
   ▼ 마크다운 라인 배열로 조립(lines.join('\n'))
   ▼ atomicWriteText(repoRoot/outputPath)
   │
   └─ 출력 파일: .ditto/local/work-items/<id>/context-packet.md (기본)
              stdout: 출력 경로 문자열
```

- 입력 상태 파일: work item Record와 run manifest. work item은 Record/Run 2-tier로 분리되어 있고(ADR-20260706), Record는 `.ditto/work-items/`(공유·커밋), Run은 `.ditto/local`(개인). 정확한 경로는 각 store가 소유하므로 여기서는 store 호출로만 접근한다.
- 출력 파일: 기본 `.ditto/local/work-items/<workItemId>/context-packet.md`(`src/core/context-packet.ts:26-28`). 즉 기본 산출물은 **개인 tier(`.ditto/local`)** 에 떨어진다 — 커밋 대상이 아니라 로컬 위임 보조물.
- 출력 마크다운 섹션(`:57-85`): `# <title>` / `## Goal` / `## Acceptance Criteria`(`- <id> [<verdict>] <statement>`) / `## Git State`(head·branch·dirty) / `## Runs`(`- <run.id>: exit_code=<n>` 또는 `missing`/`none`).
- 반환값(`ContextBuildResult`): `{ work_item_id, output_path, content }`. 단, CLI는 `output_path`만 stdout에 쓴다(`src/cli/commands/context.ts:30`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

- **위임 계약을 파일로 물질화**: charter §4-9의 "의도는 계약 산출물로 운반"을 구현하는 최소 형태. 대화 릴레이 대신 goal+acceptance를 디스크에 고정해 서브에이전트/후속 세션이 같은 의도에서 출발하게 한다.
- **읽기 위주 투영(projection)**: 이 커맨드는 새 상태를 만들지 않고 work item·run·git을 읽어 마크다운으로 투영만 한다. 원본은 store가 소유하므로 packet은 언제든 재생성 가능한 파생물이다(SoT는 store, packet은 캐시성 산출물 — 추론이지만 코드 구조가 이를 뒷받침).
- **출력 경로 fail-closed 검증**: `relativePath` zod refine이 절대경로·`..` 상위 탐색을 거부(`src/schemas/common.ts:71-73`). `validateOutputPath`가 실패 시 `ContextBuildUsageError`를 던져 usage exit(`src/core/context-packet.ts:30-36`, CLI `:32-35`, exit `USAGE_ERROR_EXIT`). 임의 경로 쓰기 방지.
- **관련 ADR**: context packet 개념을 직접 규정한 ADR은 확인 범위에서 없음(검증: `.ditto/knowledge/adr/`에서 context-packet 매치는 ADR-0018 한 건이며 이는 "선택적 외부도구 우아한 강등"으로 이 커맨드와 직접 관계 없음). 근거는 charter §4-9와 glossary 정의에 있다. Record/Run tier 분리는 ADR-20260706에 근거.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

`buildContextPacket(repoRoot, input)` (`src/core/context-packet.ts:38-93`):

1. `workStore.get(input.work_item_id)` — work item 로드. id가 없으면 store가 throw → CLI에서 runtime error exit로 흡수(`:31-38`, CLI). 즉 존재하지 않는 work item은 usage가 아닌 runtime 오류로 떨어진다(경로 오류만 usage).
2. `captureGitState(repoRoot)` — head/branch/dirty를 execFileSync로 캡처. git 명령 실패 시 head는 40자리 0, branch는 빈 문자열로 degrade(`src/core/git.ts:5-6`) → packet 조립은 절대 git 때문에 깨지지 않는다(fail-open).
3. `validateOutputPath(...)` — `--output` 또는 기본 경로를 `relativePath`로 검증. **효과**: 위임 산출물이 repo 밖으로 새지 않도록 경계를 강제.
4. run 로드가 개별 try/catch로 null 흡수(`:47-55`):
   ```ts
   try { return await runStore.get(id); } catch { return null; }
   ```
   **효과**: 일부 run manifest가 사라졌어도 packet은 생성된다. 사라진 run은 마크다운에서 `- <id>: missing`으로 명시(`:82`) — 조용히 빠지지 않고 결손을 드러낸다(정합성 신호 보존).
5. acceptance criteria 렌더(`:66-68`): `- <criterion.id> [<verdict>] <statement>`. verdict는 work item 스키마의 기본 `unverified`부터 pass/fail 등(`src/schemas/work-item.ts:97-98`). **효과**: 완료 기준을 verdict와 함께 넘겨, 위임받은 쪽이 "무엇을 아직 검증 안 했는지"를 안다.
6. `atomicWriteText(join(repoRoot, outputPath), content)` — 원자적 쓰기(`:87`). 부분 기록으로 깨진 packet이 남지 않게.

숨은 결정:
- **git degrade는 fail-open, 경로 검증은 fail-closed** — 서로 반대 방향. git은 정보성이라 없어도 진행, 출력 경로는 안전 경계라 어기면 중단. 의도적 비대칭.
- run 결손은 흡수하되 **표시**한다(missing) — 결손을 숨기지 않는 charter §4-5(증거) 정신.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인된 **불일치/갭**:

1. **packet 필드가 glossary 정의보다 얕다**. glossary(`:118`)는 context packet 구성으로 `goal, acceptance, git state, relevant files, last failure, what-not-to-touch, evidence pointer, expected output contract`를 든다. 실제 조립은 title/goal/acceptance/git/runs만 낸다(`src/core/context-packet.ts:57-85`). **누락**: relevant files, last failure(runs의 exit_code로 부분 갈음될 뿐 실패 로그·원인 아님), what-not-to-touch, evidence pointer, **expected output contract(반환 형식)**. charter §4-9가 위임 계약의 핵심으로 꼽는 "반환 형식"이 packet에 없다 → 현재 산출물은 위임 계약이라기보다 work item 요약에 가깝다.
2. **메타 설명 대비 기능 부족**: 커맨드 설명은 "Build and **inspect** context packets"(`src/cli/commands/context.ts:45`)지만 `inspect` 서브커맨드는 없다(`:48-50`).
3. **소비자 부재**: `buildContextPacket`/`contextCommand`를 사용하는 코드는 CLI 등록(`src/cli/index.ts:13,66`) 외에 없다(검증: repo 전역 grep). autopilot·핸드오프·서브에이전트 위임 경로 어디도 이 packet 파일을 자동으로 읽지 않는다. 즉 **수동 도구**이며, "위임으로 컨텍스트를 지킨다"는 자동 파이프라인에 배선돼 있지 않다.

확인 범위: `context` 커맨드 진입 → `buildContextPacket` → 그것이 부르는 store/git/fs, 그리고 전역 소비자 grep. deep-interview 계열(`question-context.ts`)은 별개 subsystem이라 검증 대상에서 제외.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **개념-구현 drift**: glossary 정의(8필드)와 구현(5섹션)이 어긋나 있다. 재설계 시 둘 중 하나로 수렴시켜야 한다 — packet을 완전한 위임 계약(relevant files·what-not-to-touch·return contract 포함)으로 키우거나, glossary 정의를 현 구현에 맞게 축소하거나. 권위는 코드이므로(charter §4-11) 방치 시 정의 쪽을 신뢰할 수 없게 된다.
- **핸드오프와의 중복/경계**: DITTO에는 이미 `handoff`(session/work item 인수인계) subsystem이 있다(glossary "handoff"). context packet(위임용 프롬프트)과 handoff(세션 인수인계)의 역할 경계가 코드에 명시돼 있지 않다. 재설계 시 두 산출물이 같은 의도(의도의 무손실 운반)를 이중화하는지 확인 필요 — 이중화는 곧 drift(charter §4-11).
- **기본 출력이 개인 tier**: `.ditto/local/...`(gitignore 대상 추정)에 떨어져 커밋되지 않는다. 팀 공유 위임 계약으로 쓰려면 tier 선택이 필요할 수 있다(추론 — gitignore 실체는 미확인).
- **재생성 안전성은 보존해야 할 불변식**: packet은 store에서 언제든 재생성되는 파생물이라는 성질(SoT=store). 재설계에서 packet에 store에 없는 상태를 직접 담기 시작하면 이 무손실 재생성성이 깨진다.
- **git fail-open 유지**: git 캡처 실패가 packet 생성을 막지 않는 성질(`git.ts:5-6`)은 유지 가치가 있다 — 위임 산출물이 환경 노이즈로 깨지면 안 된다.
