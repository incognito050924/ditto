# mattpocock-skills 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/mattpocock/skills`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/mattpocock-skills`
- 기준 커밋: `b8be62ffacb0118fa3eaa29a0923c87c8c11985c` (`b8be62f`, `main`, `origin/main`)
- 기준 커밋 메시지: `Merge branch 'main' of https://github.com/mattpocock/skills`
- 이 보고서의 모든 `repo-relative/path:line` 근거는 위 기준 커밋을 기준으로 한다.

## 조사 방법

- `gh repo clone mattpocock/skills /private/tmp/ditto-harness-analysis/mattpocock-skills`로 지정 경로에 저장소를 클론했다.
- `git rev-parse HEAD`와 `git branch -vv`로 기준 커밋과 `origin/main` 추적 상태를 확인했다.
- `git ls-files`, `find . -maxdepth 4 -type f`, `find skills -maxdepth 4 -type f`로 추적 파일과 스킬 하위 구조를 확인했다. 추적 파일은 `README.md`, `CLAUDE.md`, `CONTEXT.md`, `.claude-plugin/plugin.json`, `docs/adr/*`, `scripts/*`, `skills/**` 중심으로 구성되어 있다.
- `find . -maxdepth 3 -name package.json -o -name pyproject.toml -o -name Cargo.toml -o -name go.mod -o -name pnpm-lock.yaml -o -name package-lock.json -o -name yarn.lock` 결과가 비어 있었다. 따라서 이 저장소는 실행 앱/라이브러리 패키지가 아니라 에이전트 스킬과 설치 보조 스크립트 저장소로 분석한다. 이는 추적 파일 목록에 패키지 매니저 메타데이터가 없고, 공개 진입점이 `.claude-plugin/plugin.json`의 `skills` 배열인 점에서 나온 엄밀한 추론이다(`.claude-plugin/plugin.json:1-18`).
- `nl -ba`로 README, 루트 지침, 컨텍스트 문서, 플러그인 매니페스트, ADR, 스크립트, 모든 `SKILL.md`, 주요 참조 문서를 라인 번호와 함께 읽었다.
- 스크립트는 구조와 안전성을 정적으로 분석했다. 이 분석 목적상 `scripts/link-skills.sh`, git guardrail hook, pre-commit 설치 skill 등은 실제 사용자 홈/저장소를 변경할 수 있어 실행하지 않았다.

## 핵심 특징

- 저장소의 목표는 “real engineering”용 에이전트 스킬 모음이다. README는 이 스킬들이 “small, easy to adapt, and composable”이고 어떤 모델과도 작동하도록 설계됐다고 설명한다(`README.md:15-19`). 이는 코드 실행 하네스라기보다 에이전트 행동을 절차화하는 프롬프트 하네스라는 판단의 핵심 근거다.
- 설치 흐름은 `npx skills@latest add mattpocock/skills`로 시작하고, 사용자가 원하는 스킬과 코딩 에이전트를 고르며, `/setup-matt-pocock-skills`를 반드시 선택하라고 안내한다(`README.md:25-35`). setup skill이 issue tracker, triage label, 생성 문서 위치를 묻는다고 README가 명시한다(`README.md:35-39`).
- README의 문제 정의는 네 가지 실패 모드로 정리된다. 에이전트와 사용자 간 misalignment는 grilling session으로 줄이고(`README.md:46-61`), 프로젝트 jargon 부족으로 인한 장황함은 shared language/`CONTEXT.md`로 줄이며(`README.md:63-99`), 실행 피드백 부재는 types/browser/tests와 `/tdd`, `/diagnose`로 다루고(`README.md:100-116`), 에이전트가 가속하는 복잡도 증가는 설계/아키텍처 스킬로 다룬다(`README.md:118-137`).
- 저장소는 스킬을 bucket으로 관리한다. `CLAUDE.md`는 `engineering`, `productivity`, `misc`, `personal`, `in-progress`, `deprecated`의 의미를 정의하고(`CLAUDE.md:1-8`), `engineering/productivity/misc`는 README와 플러그인에 노출되어야 하며 `personal/in-progress/deprecated`는 둘 다에 나오면 안 된다고 규정한다(`CLAUDE.md:10-14`).
- 공개 플러그인 매니페스트는 `.claude-plugin/plugin.json` 하나이며, 이름은 `mattpocock-skills`이고 `skills` 배열에 14개 경로를 담는다(`.claude-plugin/plugin.json:1-18`). 이 배열은 engineering 10개와 productivity 4개를 포함하지만 misc 4개는 포함하지 않는다(`.claude-plugin/plugin.json:4-17`, `skills/misc/README.md:1-8`).
- 핵심 설계는 “per-repo setup + skill consumers”다. setup skill은 `AGENTS.md`/`CLAUDE.md`의 `## Agent skills` 블록과 `docs/agents/` 아래 설정 파일을 만들어 issue tracker, triage labels, domain docs를 후속 engineering skill들이 읽게 한다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:1-15`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:91-117`).
- hard dependency와 soft dependency가 ADR로 명시되어 있다. `to-issues`, `to-prd`, `triage`는 setup mapping 없이는 잘못된 출력이 되므로 명시적 setup 안내를 넣고, `diagnose`, `tdd`, `improve-codebase-architecture`, `zoom-out`은 glossary/ADR이 없으면 덜 날카로울 뿐 동작은 하므로 토큰을 아끼기 위해 느슨한 문구만 쓴다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`).
- 스킬들은 frontmatter의 `name`과 `description`을 첫 번째 라우팅 표면으로 사용한다. 예를 들어 `/diagnose`는 hard bug/performance regression에 쓰는 reproduce-minimise-hypothesise-instrument-fix-regression-test 루프라고 선언하고(`skills/engineering/diagnose/SKILL.md:1-4`), `/write-a-skill`은 description이 에이전트가 스킬을 로드할지 결정할 때 보는 유일한 정보라고 설명한다(`skills/productivity/write-a-skill/SKILL.md:60-75`).
- 긴 지식은 progressive disclosure 형태로 분리되어 있다. `/tdd`는 예시와 mocking 지침을 `tests.md`, `mocking.md`에 위임한다(`skills/engineering/tdd/SKILL.md:10-17`). `/improve-codebase-architecture`는 architecture vocabulary, dependency deepening, HTML report, interface design을 별도 문서로 분리한다(`skills/engineering/improve-codebase-architecture/SKILL.md:10-29`, `skills/engineering/improve-codebase-architecture/SKILL.md:68-81`).
- 여러 스킬이 “대화 중 바로 쓰기”를 강조한다. `/grill-with-docs`는 용어가 해결되면 `CONTEXT.md`를 즉시 업데이트하고 ADR은 세 조건이 모두 충족될 때만 제안하라고 지시한다(`skills/engineering/grill-with-docs/SKILL.md:72-86`). 글쓰기 draft 스킬들도 매번 파일을 다시 읽고 사용자 편집을 보존하라고 한다(`skills/in-progress/writing-fragments/SKILL.md:67-73`, `skills/in-progress/writing-shape/SKILL.md:54-57`).
- 이 저장소는 “AFK agent”를 명시적 대상으로 삼는다. triage는 `ready-for-agent` 상태에 agent brief comment를 남기고(`skills/engineering/triage/SKILL.md:71-78`), agent brief는 원 이슈보다 AFK 에이전트가 따를 권위 있는 contract라고 정의한다(`skills/engineering/triage/AGENT-BRIEF.md:1-4`).

## 구조/아키텍처

### 상위 구조

- `README.md`는 문제 정의, quickstart, skill reference를 담는다. Engineering 10개, Productivity 4개, Misc 4개를 사용자-facing 카탈로그로 나열한다(`README.md:143-176`).
- `CLAUDE.md`는 저장소 유지관리 규칙이다. bucket별 공개/비공개 정책과 README/plugin 동기화 요구사항을 둔다(`CLAUDE.md:1-14`).
- `CONTEXT.md`는 이 저장소 자체의 domain glossary다. issue tracker, issue, triage role을 정의하고 “backlog” 용어 충돌을 해소한다(`CONTEXT.md:1-26`). 이 파일은 저장소가 스스로 권장하는 `CONTEXT.md` 관행을 자기 저장소에도 적용한 사례다.
- `.claude-plugin/plugin.json`은 plugin install surface다. 다만 marketplace metadata는 없고 plugin name과 skills 배열만 있다(`.claude-plugin/plugin.json:1-18`).
- `scripts/link-skills.sh`와 `scripts/list-skills.sh`는 로컬 개발/사용 보조 스크립트다. 전자는 모든 비-deprecated skill을 `~/.claude/skills`에 symlink하고(`scripts/link-skills.sh:4-8`, `scripts/link-skills.sh:26-38`), 후자는 모든 `SKILL.md`를 정렬 출력한다(`scripts/list-skills.sh:1-7`).
- `docs/adr/0001-*`는 setup dependency 정책을 기록한다. 이 저장소의 prompt 설계 의사결정도 ADR로 관리한다는 근거다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:1-10`).

### 스킬 bucket

- `skills/engineering/`은 daily code work용이다. bucket README가 diagnose, grill-with-docs, triage, improve-codebase-architecture, setup, tdd, to-issues, to-prd, zoom-out, prototype을 나열한다(`skills/engineering/README.md:1-14`).
- `skills/productivity/`는 code-specific이 아닌 workflow tool이다. caveman, grill-me, handoff, write-a-skill이 있다(`skills/productivity/README.md:1-8`).
- `skills/misc/`는 “kept around but rarely used”라고 분류되며 git guardrails, shoehorn migration, exercise scaffold, pre-commit setup을 둔다(`skills/misc/README.md:1-8`).
- `skills/personal/`은 plugin에 홍보하지 않는 개인 setup용이다(`skills/personal/README.md:1-6`). 예를 들어 Obsidian vault skill은 개인 vault 절대경로를 포함한다(`skills/personal/obsidian-vault/SKILL.md:8-18`).
- `skills/in-progress/`는 아직 ship할 준비가 되지 않았고 plugin/top-level README에서 제외한다고 명시한다(`skills/in-progress/README.md:1-8`).
- `skills/deprecated/`는 더 이상 쓰지 않는 스킬이다(`skills/deprecated/README.md:1-8`). 다만 일부 아이디어는 active skill로 흡수됐다. 예를 들어 deprecated `design-an-interface`의 parallel sub-agent pattern은 active architecture skill의 `INTERFACE-DESIGN.md`로 더 정교하게 재등장한다(`skills/deprecated/design-an-interface/SKILL.md:24-46`, `skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md:19-39`).

### 데이터 흐름

- 설치 시 사용자는 스킬을 고른 뒤 `/setup-matt-pocock-skills`를 실행한다(`README.md:25-39`). setup skill은 현재 repo를 탐색하고 `CLAUDE.md`/`AGENTS.md`, root `CONTEXT.md`/`CONTEXT-MAP.md`, `docs/adr/`, `docs/agents/`, `.scratch/`의 존재를 읽는다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:19-29`).
- setup 결과는 `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`와 root agent instruction block이다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:72-117`). 후속 스킬은 이를 읽어 issue tracker 명령, label mapping, domain docs 위치를 결정한다(`skills/engineering/setup-matt-pocock-skills/domain.md:1-12`, `skills/engineering/setup-matt-pocock-skills/triage-labels.md:1-15`).
- hard dependency 스킬인 `/to-issues`, `/to-prd`, `/triage`는 setup 결과가 제공되어야 한다고 직접 말한다(`skills/engineering/to-issues/SKILL.md:8-11`, `skills/engineering/to-prd/SKILL.md:6-9`, `skills/engineering/triage/SKILL.md:36-40`).
- soft dependency 스킬인 `/diagnose`, `/tdd`, `/improve-codebase-architecture`, `/zoom-out`은 domain glossary와 ADR을 읽으라고 하지만, 없을 때 중단하라는 요구는 없다(`skills/engineering/diagnose/SKILL.md:8-11`, `skills/engineering/tdd/SKILL.md:45-48`, `skills/engineering/improve-codebase-architecture/SKILL.md:29-36`, `skills/engineering/zoom-out/SKILL.md:1-7`).
- 산출물은 issue tracker issue/PRD, `CONTEXT.md`, `docs/adr/`, `.out-of-scope/`, temp HTML report, throwaway prototype, temp handoff doc 등으로 분산된다. 각 산출 위치와 조건은 해당 skill에 명시된다(`skills/engineering/to-prd/SKILL.md:20-76`, `skills/engineering/grill-with-docs/SKILL.md:52-86`, `skills/engineering/triage/OUT-OF-SCOPE.md:1-18`, `skills/engineering/improve-codebase-architecture/SKILL.md:47-70`, `skills/engineering/prototype/SKILL.md:19-30`, `skills/productivity/handoff/SKILL.md:7-15`).

## 도구/명령/스크립트/프롬프트 인벤토리

### 설치/배포 표면

| 항목 | 위치 | 역할 | 근거 |
| --- | --- | --- | --- |
| skills.sh 설치 | `README.md` | `npx skills@latest add mattpocock/skills`로 사용자가 skill을 고르고 설치 | `README.md:25-35` |
| Claude plugin manifest | `.claude-plugin/plugin.json` | `mattpocock-skills` plugin 이름과 14개 skill 경로 선언 | `.claude-plugin/plugin.json:1-18` |
| 로컬 symlink 설치 | `scripts/link-skills.sh` | `~/.claude/skills`에 비-deprecated skill 디렉터리 symlink 생성 | `scripts/link-skills.sh:4-8`, `scripts/link-skills.sh:26-38` |
| skill 목록 출력 | `scripts/list-skills.sh` | 모든 `SKILL.md` 경로를 정렬 출력 | `scripts/list-skills.sh:1-7` |

### Engineering skills

| Skill | 위치 | 핵심 동작 | 주요 산출물/부작용 | 근거 |
| --- | --- | --- | --- | --- |
| `diagnose` | `skills/engineering/diagnose/SKILL.md` | feedback loop를 먼저 만들고 reproduce, hypothesis, instrumentation, fix, regression-test로 진행 | regression test, debug cleanup, post-mortem | `skills/engineering/diagnose/SKILL.md:12-31`, `skills/engineering/diagnose/SKILL.md:91-117` |
| `grill-with-docs` | `skills/engineering/grill-with-docs/SKILL.md` | 한 질문씩 grilling하며 code/doc과 대조하고 glossary/ADR을 갱신 | `CONTEXT.md`, `docs/adr/` | `skills/engineering/grill-with-docs/SKILL.md:6-14`, `skills/engineering/grill-with-docs/SKILL.md:52-86` |
| `triage` | `skills/engineering/triage/SKILL.md` | issue tracker의 issue를 category/state role state machine으로 이동 | labels, AI disclaimer comments, agent brief, out-of-scope docs | `skills/engineering/triage/SKILL.md:8-40`, `skills/engineering/triage/SKILL.md:61-103` |
| `improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture/SKILL.md` | shallow module을 deep module로 바꿀 후보를 찾고 HTML report로 제시 | temp HTML report, 후속 grilling, `CONTEXT.md`/ADR update | `skills/engineering/improve-codebase-architecture/SKILL.md:6-29`, `skills/engineering/improve-codebase-architecture/SKILL.md:47-81` |
| `setup-matt-pocock-skills` | `skills/engineering/setup-matt-pocock-skills/SKILL.md` | repo별 issue tracker/triage/domain docs 설정을 질문 후 기록 | `CLAUDE.md`/`AGENTS.md` block, `docs/agents/*.md` | `skills/engineering/setup-matt-pocock-skills/SKILL.md:7-15`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:70-121` |
| `tdd` | `skills/engineering/tdd/SKILL.md` | behavior/public interface 중심 red-green-refactor, vertical tracer bullet | tests, implementation, refactor | `skills/engineering/tdd/SKILL.md:8-17`, `skills/engineering/tdd/SKILL.md:18-41`, `skills/engineering/tdd/SKILL.md:43-109` |
| `to-issues` | `skills/engineering/to-issues/SKILL.md` | plan/PRD를 thin vertical slice issue로 분해 | issue tracker issues | `skills/engineering/to-issues/SKILL.md:6-32`, `skills/engineering/to-issues/SKILL.md:52-83` |
| `to-prd` | `skills/engineering/to-prd/SKILL.md` | 현재 대화와 코드 이해를 PRD로 합성하고 issue tracker에 publish | PRD issue, `ready-for-agent` label | `skills/engineering/to-prd/SKILL.md:6-20`, `skills/engineering/to-prd/SKILL.md:22-76` |
| `zoom-out` | `skills/engineering/zoom-out/SKILL.md` | 추상화 레벨을 올려 관련 모듈/호출자 지도를 요구 | 설명 응답 | `skills/engineering/zoom-out/SKILL.md:1-7` |
| `prototype` | `skills/engineering/prototype/SKILL.md` | logic prototype 또는 UI prototype으로 설계 질문을 검증 | throwaway TUI/route, notes/ADR/issue | `skills/engineering/prototype/SKILL.md:6-30`, `skills/engineering/prototype/LOGIC.md:1-79`, `skills/engineering/prototype/UI.md:1-112` |

### Productivity skills

| Skill | 위치 | 핵심 동작 | 근거 |
| --- | --- | --- | --- |
| `caveman` | `skills/productivity/caveman/SKILL.md` | 기술 정확도는 유지하고 filler/articles/pleasantries를 줄이는 지속 모드 | `skills/productivity/caveman/SKILL.md:1-25`, `skills/productivity/caveman/SKILL.md:37-49` |
| `grill-me` | `skills/productivity/grill-me/SKILL.md` | 문서 갱신 없는 순수 grilling, 한 질문씩 진행, 코드로 답할 수 있으면 탐색 | `skills/productivity/grill-me/SKILL.md:1-10` |
| `handoff` | `skills/productivity/handoff/SKILL.md` | 현재 대화를 OS temp dir의 handoff 문서로 압축, 민감정보 제거 | `skills/productivity/handoff/SKILL.md:1-15` |
| `write-a-skill` | `skills/productivity/write-a-skill/SKILL.md` | skill 구조, description 요구사항, script/reference split 지침 제공 | `skills/productivity/write-a-skill/SKILL.md:8-26`, `skills/productivity/write-a-skill/SKILL.md:60-117` |

### Misc skills

| Skill | 위치 | 핵심 동작 | 근거 |
| --- | --- | --- | --- |
| `git-guardrails-claude-code` | `skills/misc/git-guardrails-claude-code/SKILL.md` | Claude Code `PreToolUse` hook으로 위험 git 명령 차단 | `skills/misc/git-guardrails-claude-code/SKILL.md:1-18`, `skills/misc/git-guardrails-claude-code/SKILL.md:37-95` |
| `migrate-to-shoehorn` | `skills/misc/migrate-to-shoehorn/SKILL.md` | test file의 `as` assertion을 `@total-typescript/shoehorn`로 마이그레이션 | `skills/misc/migrate-to-shoehorn/SKILL.md:8-25`, `skills/misc/migrate-to-shoehorn/SKILL.md:65-118` |
| `scaffold-exercises` | `skills/misc/scaffold-exercises/SKILL.md` | course exercise directory/readme scaffold를 만들고 lint 통과 | `skills/misc/scaffold-exercises/SKILL.md:6-16`, `skills/misc/scaffold-exercises/SKILL.md:44-64` |
| `setup-pre-commit` | `skills/misc/setup-pre-commit/SKILL.md` | Husky, lint-staged, Prettier, typecheck/test pre-commit 구성 | `skills/misc/setup-pre-commit/SKILL.md:6-15`, `skills/misc/setup-pre-commit/SKILL.md:17-91` |

### Reference/tooling files

- Issue tracker templates는 GitHub, GitLab, local markdown을 지원한다. GitHub는 `gh issue create/view/list/comment/edit/close`를 사용한다(`skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md:1-22`). GitLab은 `glab issue`/`glab mr` 명령 체계를 사용한다(`skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md:1-23`). Local markdown은 `.scratch/<feature-slug>/PRD.md`와 `.scratch/<feature-slug>/issues/<NN>-<slug>.md` 규약을 사용한다(`skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md:1-19`).
- Triage label template는 canonical role과 실제 tracker label string의 매핑 테이블이다(`skills/engineering/setup-matt-pocock-skills/triage-labels.md:1-15`).
- Domain docs template는 `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`를 탐색 전 읽되 없으면 조용히 진행하라고 한다(`skills/engineering/setup-matt-pocock-skills/domain.md:1-12`).
- TDD reference는 좋은 테스트/나쁜 테스트, mocking boundary, testable interface, deep module, refactor candidates를 분리한다(`skills/engineering/tdd/tests.md:1-61`, `skills/engineering/tdd/mocking.md:1-59`, `skills/engineering/tdd/interface-design.md:1-31`, `skills/engineering/tdd/deep-modules.md:1-33`, `skills/engineering/tdd/refactoring.md:1-10`).
- Architecture reference는 `module/interface/implementation/depth/seam/adapter/leverage/locality` vocabulary와 deepening dependency category, HTML report scaffold, interface design sub-agent pattern을 제공한다(`skills/engineering/improve-codebase-architecture/LANGUAGE.md:1-53`, `skills/engineering/improve-codebase-architecture/DEEPENING.md:1-37`, `skills/engineering/improve-codebase-architecture/HTML-REPORT.md:1-123`, `skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md:1-44`).
- Diagnosis HITL template는 사람이 클릭해야 하는 상황에서도 `step`/`capture` helper로 구조화된 repro loop를 만들고 마지막에 `KEY=VALUE`를 출력한다(`skills/engineering/diagnose/scripts/hitl-loop.template.sh:1-41`).
- Git guardrail hook script는 JSON stdin에서 `.tool_input.command`를 `jq`로 읽고 regex pattern과 맞으면 exit code 2로 차단한다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:1-25`).

### 비공개/초안/폐기 프롬프트

- `personal`에는 article editing과 Obsidian vault 관리 skill이 있다(`skills/personal/README.md:1-6`). Obsidian skill은 개인 vault 절대경로와 wikilink 규약을 담으므로 공개 plugin에는 부적합하다(`skills/personal/obsidian-vault/SKILL.md:8-24`).
- `in-progress`에는 review, writing-beats, writing-fragments, writing-shape가 있다. README는 이들이 rough edge, breaking change, abandoned experiment 가능성이 있어 plugin/top-level README에서 제외된다고 말한다(`skills/in-progress/README.md:1-8`).
- `deprecated`에는 design-an-interface, qa, request-refactor-plan, ubiquitous-language가 있다(`skills/deprecated/README.md:1-8`). 이 중 `ubiquitous-language`는 `UBIQUITOUS_LANGUAGE.md`에 저장하는 예전 vocabulary 흐름을 쓰며(`skills/deprecated/ubiquitous-language/SKILL.md:1-20`), active 흐름은 `CONTEXT.md`와 ADR 중심으로 바뀌었다(`skills/engineering/grill-with-docs/SKILL.md:18-86`).

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

- `/setup-matt-pocock-skills`가 deterministic script가 아니라 prompt-driven skill인 이유는 repo마다 issue tracker, label vocabulary, domain doc layout이 다르고 사용자의 선택을 한 번에 덤프하지 말고 한 결정씩 받아야 하기 때문이다. 근거는 “prompt-driven skill, not a deterministic script”라는 명시와 탐색-발견 요약-세 결정 질문-초안 확인-작성 흐름이다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:15-34`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:70-121`). 엄밀한 추론: 이 설계는 repo-local conventions를 설정 파일로 캡처해 후속 skill의 ambiguity를 줄이는 bootstrapper다.
- hard dependency skill들이 setup 안내를 직접 넣은 이유는 issue tracker/label mapping이 없으면 “wrong, not just fuzzy”한 출력이 나오기 때문이다. ADR이 이 구분을 명시한다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`). 이 때문에 `to-issues`, `to-prd`, `triage`는 같은 setup pointer를 반복한다(`skills/engineering/to-issues/SKILL.md:8-11`, `skills/engineering/to-prd/SKILL.md:6-9`, `skills/engineering/triage/SKILL.md:36-40`).
- `/grill-me`와 `/grill-with-docs`가 질문을 하나씩 하도록 작성된 이유는 decision tree의 branch를 순차적으로 해소해 misalignment를 줄이기 위해서다. README는 misalignment의 fix를 grilling session이라고 부르고(`README.md:52-61`), 두 skill 모두 한 질문씩 묻고 코드로 답할 수 있으면 코드 탐색을 먼저 하라고 한다(`skills/productivity/grill-me/SKILL.md:6-10`, `skills/engineering/grill-with-docs/SKILL.md:6-14`).
- `/grill-with-docs`가 `CONTEXT.md`를 inline update하고 ADR을 sparingly offer하는 이유는 shared language와 hard-to-explain decision을 session 중 잃지 않기 위해서다. README는 shared language가 verbosity와 naming/token use를 개선한다고 주장한다(`README.md:73-99`). skill은 term conflict/fuzzy language/code contradiction을 즉시 다루고, 용어 해결 시 바로 `CONTEXT.md`를 갱신한다(`skills/engineering/grill-with-docs/SKILL.md:56-76`). ADR은 hard to reverse, surprising, real trade-off 세 조건을 모두 요구한다(`skills/engineering/grill-with-docs/SKILL.md:78-86`, `skills/engineering/grill-with-docs/ADR-FORMAT.md:29-47`).
- `/diagnose`가 feedback loop를 Phase 1로 두고 “This is the skill”이라고 강조하는 이유는 버그 수정의 핵심이 빠르고 결정적인 pass/fail signal이라고 보기 때문이다. skill은 test, curl/HTTP script, CLI fixture, headless browser, trace replay, throwaway harness, fuzz, bisect, differential, HITL script 순으로 loop 구성 방법을 제시한다(`skills/engineering/diagnose/SKILL.md:12-31`). 엄밀한 추론: harness 관점에서 이 skill은 DITTO의 “재현 가능한 평가 루프”와 가장 직접적으로 닮아 있다.
- `/diagnose`의 hypothesis와 instrumentation 단계가 ranked/falsifiable/one variable로 제한되는 이유는 single-hypothesis anchoring과 noisy logging을 막기 위해서다. skill은 3-5개 가설과 prediction을 요구하고, debug probe가 prediction에 매핑되어야 하며 “log everything and grep”을 금지한다(`skills/engineering/diagnose/SKILL.md:65-89`).
- `/tdd`가 horizontal test batch를 금지하고 tracer bullet vertical loop를 쓰는 이유는 테스트가 imagined behavior와 implementation shape에 고정되는 것을 막기 위해서다. skill은 horizontal slicing이 “crap tests”를 만든다고 설명하고, 한 테스트-한 구현 반복으로 배운 내용에 반응하라고 한다(`skills/engineering/tdd/SKILL.md:18-41`, `skills/engineering/tdd/SKILL.md:62-88`).
- `/tdd`의 public interface 중심 원칙은 refactor-resilient tests를 만들기 위해서다. skill은 good tests가 public API를 통해 real code path를 exercise하고 bad tests는 internals/mock/private methods에 결합된다고 설명한다(`skills/engineering/tdd/SKILL.md:8-17`). 보조 문서도 internal collaborator mocking을 금지하고 system boundary만 mock하라고 한다(`skills/engineering/tdd/mocking.md:1-15`).
- `/to-prd`가 인터뷰하지 말고 기존 context를 합성하라고 하는 이유는 이미 대화에서 결정된 내용을 issue tracker에 durable artifact로 옮기는 역할이기 때문이다. skill은 “Do NOT interview the user”라고 쓰고, repo 탐색/모듈 sketch/user confirmation 후 PRD template를 publish하라고 한다(`skills/engineering/to-prd/SKILL.md:6-20`).
- `/to-issues`가 vertical slices와 dependency order를 강제하는 이유는 각 issue를 독립적으로 잡아 구현 가능한 AFK 단위로 만들기 위해서다. skill은 slice가 schema/API/UI/tests를 관통하는 complete path여야 하고, blocker를 먼저 publish해 실제 issue id를 참조하라고 한다(`skills/engineering/to-issues/SKILL.md:22-32`, `skills/engineering/to-issues/SKILL.md:52-83`).
- `/triage`가 state machine과 canonical roles를 쓰는 이유는 issue tracker마다 label string은 달라도 triage 상태 의미는 고정하기 위해서다. skill은 category 2개와 state 5개를 정의하고 실제 label string은 setup mapping을 쓰라고 한다(`skills/engineering/triage/SKILL.md:21-40`). template도 canonical role과 tracker label을 분리한다(`skills/engineering/setup-matt-pocock-skills/triage-labels.md:1-15`).
- `/triage`가 모든 issue/comment에 AI disclaimer를 요구하는 이유는 triage 중 생성된 외부-facing 텍스트가 AI 산출물임을 명확히 하기 위해서다(`skills/engineering/triage/SKILL.md:10-15`). 엄밀한 추론: issue tracker는 사람과 외부 기여자가 읽는 표면이므로 provenance 표시가 필요하다.
- `.out-of-scope/` knowledge base가 있는 이유는 rejected feature request의 institutional memory와 deduplication을 유지하기 위해서다. 문서는 이 두 목적을 직접 제시하고, concept별 파일과 prior requests 목록을 요구한다(`skills/engineering/triage/OUT-OF-SCOPE.md:1-18`, `skills/engineering/triage/OUT-OF-SCOPE.md:49-68`).
- `/improve-codebase-architecture`가 HTML report를 temp dir에 쓰고 repo에 남기지 않는 이유는 architecture review가 탐색 산출물이며 작업 repo를 오염시키지 않기 위해서다. skill은 OS temp directory에 self-contained HTML을 쓰고 열라고 한다(`skills/engineering/improve-codebase-architecture/SKILL.md:47-51`). 엄밀한 추론: 이는 throwaway artifact와 durable code/doc artifact를 분리하는 정책이다.
- architecture skill이 특정 vocabulary를 강제하는 이유는 shared language 자체가 목적이기 때문이다. skill은 “consistent language is the point”라며 module/interface/depth/seam 등을 쓰라고 하고(`skills/engineering/improve-codebase-architecture/SKILL.md:10-29`), `LANGUAGE.md`는 같은 용어와 rejected framing을 정의한다(`skills/engineering/improve-codebase-architecture/LANGUAGE.md:1-53`).
- `/prototype`가 logic/UI 두 branch로 갈라지는 이유는 “무엇을 검증하는가”가 artifact shape를 결정하기 때문이다. skill은 prototype을 “throwaway code that answers a question”이라고 정의하고, logic/state question은 TUI, visual question은 URL variant UI로 라우팅한다(`skills/engineering/prototype/SKILL.md:6-18`). logic 문서는 pure module + thin TUI를 요구해 나중에 검증된 logic만 흡수할 수 있게 한다(`skills/engineering/prototype/LOGIC.md:26-40`). UI 문서는 같은 route의 `?variant=`로 실제 app context 안에서 비교하라고 한다(`skills/engineering/prototype/UI.md:14-33`, `skills/engineering/prototype/UI.md:56-93`).
- `handoff`가 OS temp dir에 쓰도록 작성된 이유는 작업 workspace를 불필요한 handoff artifact로 더럽히지 않고 다음 agent에게 필요한 context만 전달하기 위해서다. skill은 temp dir 저장, suggested skills, 기존 artifacts reference, sensitive info redaction을 요구한다(`skills/productivity/handoff/SKILL.md:7-15`).
- `write-a-skill`이 description 품질을 강조하는 이유는 description이 에이전트가 skill load 여부를 판단할 때 보는 유일한 정보이기 때문이다(`skills/productivity/write-a-skill/SKILL.md:60-75`). 스크립트를 deterministic/repeated/error handling 작업에만 추가하라는 지침은 generated code 반복을 줄이고 reliability를 높이기 위한 것이다(`skills/productivity/write-a-skill/SKILL.md:90-99`).
- `scripts/link-skills.sh`가 deprecated만 제외하는 이유는 로컬 author/dev 사용에서는 personal과 in-progress도 실험적으로 쓰려는 의도일 수 있다. 근거는 comment가 “all skills in the repository”를 링크한다고 말하고(`scripts/link-skills.sh:4-5`), find exclusion이 `deprecated`뿐이라는 점이다(`scripts/link-skills.sh:26`). 엄밀한 추론: plugin public surface와 local symlink surface를 분리한 설계지만, 그 차이가 명시적으로 문서화되지는 않았다.
- git guardrail skill과 hook script가 pattern blocklist로 작성된 이유는 Claude Code의 `PreToolUse` hook이 Bash command string을 사전에 검사하는 구조이기 때문이다. skill은 PreToolUse hook으로 dangerous git commands를 intercept한다고 설명하고(`skills/misc/git-guardrails-claude-code/SKILL.md:6-18`), script는 stdin JSON의 `.tool_input.command`를 읽어 regex pattern과 대조한다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:1-25`).

## 장점

- 문제-스킬 매핑이 뚜렷하다. README가 failure mode를 먼저 설명한 뒤 적절한 skill을 연결하므로 사용자가 왜 `/grill-me`, `/grill-with-docs`, `/tdd`, `/diagnose`, `/improve-codebase-architecture`를 써야 하는지 이해하기 쉽다(`README.md:42-141`).
- setup bootstrapper가 후속 skill의 전제를 명시적으로 만든다. issue tracker, triage labels, domain docs가 `docs/agents/*.md`에 저장되므로 이후 skill이 매번 같은 질문을 반복하지 않는다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:9-15`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:109-117`).
- hard/soft dependency 구분이 좋다. 실제로 틀린 side effect를 낼 수 있는 skill만 setup pointer를 강하게 요구하고, 나머지는 토큰 가볍게 유지한다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`).
- durable artifact와 throwaway artifact의 구분이 일관적이다. ADR/CONTEXT/out-of-scope/issue/agent brief는 durable로 남기고, architecture HTML report와 prototype shell/handoff는 temp 또는 삭제/흡수 대상으로 둔다(`skills/engineering/grill-with-docs/ADR-FORMAT.md:1-16`, `skills/engineering/triage/OUT-OF-SCOPE.md:1-18`, `skills/engineering/improve-codebase-architecture/SKILL.md:47-70`, `skills/engineering/prototype/SKILL.md:19-30`, `skills/productivity/handoff/SKILL.md:7-15`).
- AFK agent handoff 품질을 높이는 장치가 구체적이다. agent brief는 file path/line number를 피하고 behavior/interface/acceptance criteria/scope boundaries를 요구한다(`skills/engineering/triage/AGENT-BRIEF.md:7-37`). 이는 장기 대기 issue가 코드 이동으로 낡는 문제를 직접 다룬다.
- architecture skill은 시각적 report, shared vocabulary, dependency category, interface-design sub-agent를 조합해 단순 refactor checklist보다 더 강한 review harness를 만든다(`skills/engineering/improve-codebase-architecture/SKILL.md:47-70`, `skills/engineering/improve-codebase-architecture/DEEPENING.md:5-37`, `skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md:19-44`).
- diagnosis skill은 harness-first 사고가 강하다. deterministic loop, non-deterministic reproduction rate, HITL script, bisection/differential loop를 모두 포함한다(`skills/engineering/diagnose/SKILL.md:12-49`). DITTO 같은 평가/하네스 프로젝트가 차용하기 좋은 부분이다.
- self-documenting repository다. 저장소 자체도 `CONTEXT.md`와 ADR을 사용해 issue tracker/triage vocabulary와 setup pointer 정책을 기록한다(`CONTEXT.md:1-26`, `docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:1-10`).

## 약한 점/리스크

- README quickstart와 setup skill의 issue tracker 설명이 어긋난다. README는 setup이 GitHub, Linear, local files를 묻는다고 하지만(`README.md:35-38`), setup skill의 first-class 선택지는 GitHub, GitLab, local markdown, other이고 Linear는 other 예시에도 Jira/Linear로 묶여 있다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:36-45`). 이는 사용자 기대와 실제 template 지원 사이의 문서 drift다.
- `CLAUDE.md`의 공개 정책과 `.claude-plugin/plugin.json`이 불일치한다. `CLAUDE.md`는 `engineering/productivity/misc`의 모든 skill이 top-level README와 plugin entry를 가져야 한다고 한다(`CLAUDE.md:10-14`). README에는 misc 4개가 있지만(`README.md:169-176`), plugin manifest에는 engineering/productivity 14개만 있고 misc는 없다(`.claude-plugin/plugin.json:4-17`). 엄밀한 추론: 이 상태라면 installer/plugin 사용자는 README에 보이는 misc skill을 plugin 경로로 받지 못할 수 있다.
- `scripts/link-skills.sh`는 `personal`과 `in-progress`를 링크한다. find 조건이 deprecated만 제외하기 때문이다(`scripts/link-skills.sh:26`). `CLAUDE.md`는 personal/in-progress가 plugin/README에 나오면 안 된다고 할 뿐 local symlink에 대해 말하지 않는다(`CLAUDE.md:6-10`). 엄밀한 추론: 로컬 사용자 또는 기여자가 이 스크립트를 실행하면 rough edge가 있다고 문서화된 in-progress skill과 개인 경로를 담은 personal skill이 Claude에 노출될 수 있다(`skills/in-progress/README.md:1-3`, `skills/personal/obsidian-vault/SKILL.md:8-18`).
- `scripts/link-skills.sh`는 기존 target이 symlink가 아닌 경우 `rm -rf "$target"`로 삭제한다(`scripts/link-skills.sh:32-33`). 사용자의 `~/.claude/skills/<name>`에 수동 작성한 skill directory가 있으면 백업 없이 제거될 수 있다. 또한 symlink loop 방지에 `readlink -f`를 쓰는데(`scripts/link-skills.sh:13-18`), macOS 기본 `readlink`에는 `-f`가 없어 휴대성이 약하다. 저장소 자체가 Claude CLI 로컬 사용을 겨냥한다는 comment와 충돌하는 운영 리스크다(`scripts/link-skills.sh:4-8`).
- git guardrail hook은 문자열 regex blocklist라 우회/오탐 가능성이 있다. script는 `.tool_input.command` 하나를 regex로 검사하고(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:3-20`), blocked patterns는 `git push`, `git reset --hard`, `git clean -f`, `git checkout .` 등 고정 문자열이다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:6-16`). 엄밀한 추론: `git -C repo push`, alias, shell function, spacing/quoting variation 등은 별도 파싱 없이는 놓칠 수 있다.
- git guardrail hook은 `jq` 의존성을 명시적으로 검증하지 않는다. script는 `jq -r`를 바로 호출한다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:3-4`), skill의 설치/검증 단계도 jq 설치 확인 없이 echo JSON pipe 테스트만 제시한다(`skills/misc/git-guardrails-claude-code/SKILL.md:87-95`).
- 자동 검증/CI가 없다. 추적 파일에 package metadata, test runner, lint config, CI workflow가 없고 plugin/README consistency를 검사하는 스크립트도 없다. 이는 `CLAUDE.md`가 요구한 README/plugin 동기화 불일치가 실제로 발생한 현재 상태와 맞물린다(`CLAUDE.md:10-14`, `.claude-plugin/plugin.json:4-17`, `README.md:169-176`).
- deprecated skill 일부는 현재 vocabulary와 다르다. 예를 들어 `qa`와 `ubiquitous-language`는 `UBIQUITOUS_LANGUAGE.md`를 참조/생성하지만(`skills/deprecated/qa/SKILL.md:22-31`, `skills/deprecated/ubiquitous-language/SKILL.md:11-24`), active 흐름은 `CONTEXT.md`와 `docs/adr/` 중심이다(`skills/engineering/grill-with-docs/SKILL.md:18-86`). deprecated bucket이라 public risk는 낮지만 `scripts/list-skills.sh`는 deprecated까지 출력한다(`scripts/list-skills.sh:6-7`).
- 일부 skill은 강한 외부/개인 전제를 담는다. `scaffold-exercises`는 `pnpm ai-hero-cli internal lint`와 course exercise convention을 가정한다(`skills/misc/scaffold-exercises/SKILL.md:6-16`, `skills/misc/scaffold-exercises/SKILL.md:44-64`). `obsidian-vault`는 `/mnt/d/Obsidian Vault/AI Research/` 절대경로를 담는다(`skills/personal/obsidian-vault/SKILL.md:8-18`). bucket으로 격리되어 있지만 local link script의 노출 정책과 결합하면 혼란이 생길 수 있다.
- `disable-model-invocation: true` 같은 frontmatter는 일부 skill에만 있다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:1-5`, `skills/engineering/zoom-out/SKILL.md:1-5`, `skills/deprecated/ubiquitous-language/SKILL.md:1-5`). 엄밀한 추론: 이 필드가 skills.sh/Claude Code에서 의미 있는 메타데이터라면 좋지만, 저장소 안에는 해당 필드의 schema나 validation 설명이 없어 다른 런타임으로 이식할 때 의미가 불명확하다.

## DITTO에서 차용할 점

- “setup skill이 repo-local operating assumptions를 문서로 seed하고 후속 skill들이 소비한다”는 구조를 차용할 만하다. DITTO도 harness별 issue tracker, benchmark fixture, report format, escalation policy를 `docs/agents/*.md` 같은 repo-local 설정으로 고정하면 반복 질문과 drift를 줄일 수 있다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:9-15`, `skills/engineering/setup-matt-pocock-skills/domain.md:1-12`).
- hard dependency/soft dependency 구분을 도입할 가치가 있다. DITTO harness에서 없으면 잘못된 side effect가 나는 정보와, 없으면 품질만 낮아지는 정보를 분리하면 prompt가 가벼워진다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`).
- `CONTEXT.md`와 ADR을 “생성은 lazily, 소비는 먼저” 원칙으로 쓸 수 있다. docs가 없으면 조용히 진행하되, 용어/결정이 실제로 해결될 때만 durable artifact로 기록하는 방식은 보고서 하네스에도 맞다(`skills/engineering/setup-matt-pocock-skills/domain.md:5-12`, `skills/engineering/grill-with-docs/SKILL.md:72-86`).
- diagnosis skill의 feedback-loop-first 단계는 DITTO 평가 하네스에 직접 차용할 수 있다. 특히 deterministic pass/fail signal, flaky reproduction rate 향상, bisection/differential loop, HITL script는 “재현 가능성”을 핵심으로 삼는 하네스에 유용하다(`skills/engineering/diagnose/SKILL.md:12-49`, `skills/engineering/diagnose/scripts/hitl-loop.template.sh:1-41`).
- AFK-ready issue/brief 형식은 DITTO의 병렬 서브에이전트 지시서에도 좋다. file path/line number를 과도하게 고정하지 말고 behavior, interface, acceptance criteria, out-of-scope를 적게 하는 원칙은 장시간 병렬 작업에 강하다(`skills/engineering/triage/AGENT-BRIEF.md:7-37`, `skills/engineering/triage/AGENT-BRIEF.md:39-66`).
- architecture skill의 HTML temp report 패턴은 DITTO의 분석 결과 탐색 UI에 응용 가능하다. repo를 오염시키지 않고 temp에 self-contained report를 쓰며 diagram/prose를 섞는 방식이다(`skills/engineering/improve-codebase-architecture/SKILL.md:47-68`, `skills/engineering/improve-codebase-architecture/HTML-REPORT.md:1-34`).
- `.out-of-scope/` knowledge base는 반복 제안/반려 요청을 줄이는 데 차용할 수 있다. DITTO도 이미 검토해 제외한 harness feature나 repository family를 concept별 파일로 기록하면 같은 논쟁을 반복하지 않는다(`skills/engineering/triage/OUT-OF-SCOPE.md:1-18`, `skills/engineering/triage/OUT-OF-SCOPE.md:70-94`).
- `write-a-skill`의 description discipline은 DITTO skill/agent catalog에도 적용 가능하다. description이 로딩 판단의 유일한 입력이라는 가정, 1024자 제한, “Use when” trigger 작성 규칙은 catalog 품질을 높인다(`skills/productivity/write-a-skill/SKILL.md:60-89`).
- bucket taxonomy와 publication gating은 차용하되 자동 검증을 추가해야 한다. `engineering/productivity/misc` 같은 stable bucket과 `in-progress/deprecated/personal` 분리는 좋지만, README/plugin/link consistency는 DITTO에서 lint로 보강해야 한다(`CLAUDE.md:1-14`, `skills/in-progress/README.md:1-3`).

## 보완 계획

- DITTO에 차용할 경우 먼저 스킬/하네스 매니페스트 schema를 정의한다. 필수 필드는 `name`, `description`, `status`, `public surfaces`, `dependencies`, `side effects`, `artifact paths`로 두고, 현재 저장소의 `.claude-plugin/plugin.json`처럼 단순 배열만 두는 방식의 drift를 피한다(`.claude-plugin/plugin.json:1-18`).
- README, bucket README, plugin manifest, local installer script가 같은 public set을 가리키는지 검증하는 lint를 만든다. 이 저장소에서는 misc가 README에는 있지만 plugin에는 없는 drift가 확인됐다(`CLAUDE.md:10-14`, `README.md:169-176`, `.claude-plugin/plugin.json:4-17`).
- local install script는 destructive replacement를 기본 금지로 설계한다. `scripts/link-skills.sh`의 `rm -rf "$target"` 동작은 DITTO에서 `--force`가 있을 때만 허용하고, 충돌 시 백업/skip/report로 처리한다(`scripts/link-skills.sh:32-38`).
- shell hook은 command string regex 대신 가능한 한 structured command parsing 또는 deny-by-capability wrapper로 설계한다. 현재 git guardrail hook은 pattern list가 짧고 jq 의존성 검증이 없다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:3-20`).
- setup skill을 도입한다면 `GitHub/GitLab/local/other` 같은 backend template와 README 설명을 한 소스에서 생성한다. 이 저장소의 README는 Linear를 말하지만 setup template는 GitLab을 first-class로 둔다(`README.md:35-38`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:40-45`).
- report artifact 정책을 명확히 한다. DITTO의 분석 보고서는 repo 안 durable report로 남겨야 하므로, 이 저장소의 architecture temp HTML 원칙과 달리 사용자가 지정한 `reports/harnesses/*.md`만 쓰도록 agent 지침을 유지한다(`skills/engineering/improve-codebase-architecture/SKILL.md:47-49`).
- `in-progress`와 `personal`은 설치 surface에서 기본 제외한다. 실험용 로컬 설치가 필요하면 별도 `--include-in-progress` 또는 `--include-personal` flag로 명시한다. 이 저장소의 local link script는 deprecated만 제외해 초안/개인 skill이 노출될 수 있다(`scripts/link-skills.sh:26`, `skills/in-progress/README.md:1-3`, `skills/personal/README.md:1-6`).
- DITTO 하네스 분석 skill에는 “근거 없는 일반론 금지”를 schema화한다. 각 핵심 주장에 `path:line`과 commit SHA를 요구하는 현재 사용자 지시와, 이 저장소의 agent brief acceptance criteria discipline을 결합하면 report 품질을 자동 점검할 수 있다(`skills/engineering/triage/AGENT-BRIEF.md:26-37`).

## 근거 목록

- `README.md`: 저장소 목적, quickstart, 실패 모드, skill reference. 주요 근거: `README.md:15-19`, `README.md:25-39`, `README.md:42-141`, `README.md:143-176`.
- `CLAUDE.md`: bucket 구조와 공개/비공개 동기화 규칙. 주요 근거: `CLAUDE.md:1-14`.
- `CONTEXT.md`: 저장소 자체 domain glossary. 주요 근거: `CONTEXT.md:1-26`.
- `.claude-plugin/plugin.json`: plugin manifest와 공개 skill 경로. 주요 근거: `.claude-plugin/plugin.json:1-18`.
- `docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md`: setup hard/soft dependency 정책. 주요 근거: `docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:1-10`.
- `scripts/link-skills.sh`: local symlink installer. 주요 근거: `scripts/link-skills.sh:4-8`, `scripts/link-skills.sh:13-18`, `scripts/link-skills.sh:26-38`.
- `scripts/list-skills.sh`: skill listing script. 주요 근거: `scripts/list-skills.sh:1-7`.
- `skills/engineering/setup-matt-pocock-skills/SKILL.md` 및 seed templates: repo-local setup bootstrapper. 주요 근거: `skills/engineering/setup-matt-pocock-skills/SKILL.md:7-15`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:19-121`, `skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md:1-22`, `skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md:1-23`, `skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md:1-19`, `skills/engineering/setup-matt-pocock-skills/domain.md:1-51`, `skills/engineering/setup-matt-pocock-skills/triage-labels.md:1-15`.
- `skills/engineering/grill-with-docs/*`: grilling, `CONTEXT.md`, ADR format. 주요 근거: `skills/engineering/grill-with-docs/SKILL.md:6-86`, `skills/engineering/grill-with-docs/CONTEXT-FORMAT.md:1-63`, `skills/engineering/grill-with-docs/ADR-FORMAT.md:1-47`.
- `skills/engineering/diagnose/*`: debugging feedback-loop harness와 HITL template. 주요 근거: `skills/engineering/diagnose/SKILL.md:12-117`, `skills/engineering/diagnose/scripts/hitl-loop.template.sh:1-41`.
- `skills/engineering/tdd/*`: behavior/interface 중심 TDD. 주요 근거: `skills/engineering/tdd/SKILL.md:8-109`, `skills/engineering/tdd/tests.md:1-61`, `skills/engineering/tdd/mocking.md:1-59`, `skills/engineering/tdd/interface-design.md:1-31`, `skills/engineering/tdd/deep-modules.md:1-33`, `skills/engineering/tdd/refactoring.md:1-10`.
- `skills/engineering/to-prd/SKILL.md`, `skills/engineering/to-issues/SKILL.md`: PRD/issue generation. 주요 근거: `skills/engineering/to-prd/SKILL.md:6-76`, `skills/engineering/to-issues/SKILL.md:6-83`.
- `skills/engineering/triage/*`: issue triage state machine, agent brief, out-of-scope knowledge base. 주요 근거: `skills/engineering/triage/SKILL.md:8-103`, `skills/engineering/triage/AGENT-BRIEF.md:1-168`, `skills/engineering/triage/OUT-OF-SCOPE.md:1-101`.
- `skills/engineering/improve-codebase-architecture/*`: deep module vocabulary, architecture review, HTML report, interface design. 주요 근거: `skills/engineering/improve-codebase-architecture/SKILL.md:6-81`, `skills/engineering/improve-codebase-architecture/LANGUAGE.md:1-53`, `skills/engineering/improve-codebase-architecture/DEEPENING.md:1-37`, `skills/engineering/improve-codebase-architecture/HTML-REPORT.md:1-123`, `skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md:1-44`.
- `skills/engineering/prototype/*`: logic/UI prototype split. 주요 근거: `skills/engineering/prototype/SKILL.md:6-30`, `skills/engineering/prototype/LOGIC.md:1-79`, `skills/engineering/prototype/UI.md:1-112`.
- `skills/productivity/*`: caveman, grill-me, handoff, write-a-skill. 주요 근거: `skills/productivity/caveman/SKILL.md:1-49`, `skills/productivity/grill-me/SKILL.md:1-10`, `skills/productivity/handoff/SKILL.md:1-15`, `skills/productivity/write-a-skill/SKILL.md:1-117`.
- `skills/misc/*`: git guardrails, shoehorn migration, exercise scaffolding, pre-commit setup. 주요 근거: `skills/misc/git-guardrails-claude-code/SKILL.md:1-95`, `skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:1-25`, `skills/misc/migrate-to-shoehorn/SKILL.md:1-118`, `skills/misc/scaffold-exercises/SKILL.md:1-106`, `skills/misc/setup-pre-commit/SKILL.md:1-91`.
- `skills/personal/*`, `skills/in-progress/*`, `skills/deprecated/*`: 공개 제외/초안/폐기 skill 근거. 주요 근거: `skills/personal/README.md:1-6`, `skills/in-progress/README.md:1-8`, `skills/deprecated/README.md:1-8`.
- `.out-of-scope/*`: 저장소 자체의 out-of-scope policy 사례. 주요 근거: `.out-of-scope/mainstream-issue-trackers-only.md:1-25`, `.out-of-scope/question-limits.md:1-18`, `.out-of-scope/setup-skill-verify-mode.md:1-15`.

## ditto 적용 정리

### 적용할 기능/가치

- repo-local setup contract를 ditto의 하네스 실행 전제 고정 장치로 적용한다. mattpocock-skills는 setup skill이 issue tracker, triage labels, domain docs를 `docs/agents/*.md`와 root agent instruction block으로 기록하고 후속 skill이 이를 소비한다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:7-15`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:70-121`). ditto의 PURPOSE.md가 요구하는 사용자 인지 비용 최소화, 불필요한 질문 금지, 단계 간 정규화된 interface와 맞다.
- hard dependency/soft dependency 구분을 ditto의 스킬/하네스 로딩 정책에 적용한다. 보고서는 `to-issues`, `to-prd`, `triage`처럼 setup 없이는 잘못된 side effect가 나는 skill과, `diagnose`, `tdd`, `improve-codebase-architecture`, `zoom-out`처럼 품질만 낮아지는 skill을 분리한다고 정리한다(`docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`). 이는 ditto의 토큰 비용 절감, 사용자 의도 밖 작업 제한, 근거 없는 출력 방지에 직접 연결된다.
- `CONTEXT.md`와 ADR을 ditto의 ubiquitous language와 의사결정 영속화 장치로 적용한다. mattpocock-skills는 domain glossary를 먼저 읽고 없으면 조용히 진행하되, 용어가 해결되거나 결정 조건이 충족될 때만 `CONTEXT.md`와 ADR을 갱신한다(`skills/engineering/setup-matt-pocock-skills/domain.md:1-12`, `skills/engineering/grill-with-docs/SKILL.md:72-86`). 이는 PURPOSE.md의 상호 합의된 용어 사용, 주요 결정 및 변경사항 영속화, 할루시네이션 방지 요구와 맞다.
- diagnosis의 feedback-loop-first 절차를 ditto의 검증 하네스 기본 루프로 적용한다. 보고서의 diagnose skill은 deterministic pass/fail signal, flaky reproduction rate, bisection/differential loop, HITL script를 포함한다(`skills/engineering/diagnose/SKILL.md:12-49`, `skills/engineering/diagnose/scripts/hitl-loop.template.sh:1-41`). ditto가 모든 출력과 추론에 확실한 근거를 요구하고 E2E 테스트 도구를 핵심 기능으로 둔 목적에 맞는 실행 검증 패턴이다.
- AFK-ready agent brief, triage state machine, out-of-scope knowledge base를 ditto의 장기 실행/병렬 subagent 작업 계약으로 적용한다. triage skill은 agent brief를 권위 있는 contract로 두고 behavior, interface, acceptance criteria, scope boundaries를 요구한다(`skills/engineering/triage/AGENT-BRIEF.md:1-37`). out-of-scope 문서는 반복 제안과 반려 사유를 보존한다(`skills/engineering/triage/OUT-OF-SCOPE.md:1-18`, `skills/engineering/triage/OUT-OF-SCOPE.md:70-94`). 이는 PURPOSE.md의 감사 기록, 세션 핸드오프, Context Rot 해결, 장기간 작업 완수 요구와 연결된다.
- Deep Module 중심 architecture skill과 skill description discipline을 ditto의 agent/skill catalog 품질 기준으로 적용한다. 보고서는 architecture skill이 shared vocabulary, dependency category, interface-design sub-agent pattern, HTML report를 묶어 shallow module을 deep module로 바꾸는 후보를 찾는다고 정리한다(`skills/engineering/improve-codebase-architecture/SKILL.md:6-81`, `skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md:19-44`). `write-a-skill`은 description이 skill load 판단의 유일한 입력이라고 보고 1024자 제한과 trigger 작성 규칙을 둔다(`skills/productivity/write-a-skill/SKILL.md:60-89`). 이는 PURPOSE.md의 Deep Module 사고와 사용자 인지 비용 최소화 요구에 맞다.

### 적용 방식

- ditto의 하네스/스킬 매니페스트에 `name`, `description`, `status`, `public surfaces`, `dependencies`, `side effects`, `artifact paths`를 필수 필드로 둔다. setup 결과는 repo-local 설정으로 저장하고, 후속 단계는 사용자에게 재질문하기 전에 이 설정을 먼저 읽게 한다.
- dependency는 hard/soft로 나누고, hard dependency가 빠진 경우에만 명시적으로 setup 또는 사용자 확인을 요구한다. soft dependency는 `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`를 먼저 소비하되 없으면 진행하도록 해 토큰과 질문을 줄인다.
- 보고서/검증 하네스에는 pass/fail signal, 재현 절차, 계측 위치, 회귀 테스트 여부를 산출물 schema에 포함한다. 브라우저 E2E가 필요한 경우도 “사용자 시나리오를 검증하는 자동화 도구”라는 ditto 목적에 맞춰 같은 schema로 결과를 남긴다.
- 병렬 subagent 지시서는 agent brief 형태로 작성한다. 파일 line number에 과도하게 묶기보다 행동, 인터페이스, acceptance criteria, 제외 범위를 중심으로 쓰고, 완료 후 감사 기록과 핸드오프 자료가 남도록 한다.
- durable artifact와 throwaway artifact를 분리한다. `CONTEXT.md`, ADR, out-of-scope, issue/brief, 감사 기록은 영속화하고, 임시 HTML report/prototype/handoff 초안은 지정 temp 위치에 둔 뒤 필요한 정보만 durable artifact로 흡수한다.

### 적용 이후 제공 가치

- 사용자가 매 작업마다 issue tracker, 용어, 산출물 위치, 검증 기준을 다시 설명하지 않아도 되어 인지 비용이 줄어든다.
- setup 전제가 없는 상태에서 issue 생성, triage label 변경, 파일 수정 같은 side effect를 내는 실수를 줄인다.
- 근거 파일, 재현 로그, 테스트 결과, ADR이 같은 흐름에 묶여 ditto의 “증거 기반 완료” 기준을 강화한다.
- 장기 실행 작업과 병렬 subagent 작업이 agent brief와 감사 기록으로 이어져 Context Rot과 세션 단절 리스크를 줄인다.
- Deep Module 기준과 skill description discipline을 통해 하네스 인터페이스는 좁고 명확하게 유지하고, 구현과 참조 문서는 progressive disclosure로 분리할 수 있다.

### 리스크와 선행 조건

- setup contract 자체가 drift의 원인이 될 수 있다. 보고서에서 README는 Linear를 말하지만 setup skill은 GitLab을 first-class로 둔 불일치가 확인됐다(`README.md:35-38`, `skills/engineering/setup-matt-pocock-skills/SKILL.md:40-45`). ditto는 README, manifest, setup template를 같은 source에서 검증하는 lint가 선행되어야 한다.
- publication gating은 자동 검증이 필요하다. 이 저장소는 `CLAUDE.md`가 `engineering/productivity/misc`의 plugin entry를 요구하지만 plugin manifest에는 misc가 빠져 있다(`CLAUDE.md:10-14`, `.claude-plugin/plugin.json:4-17`, `README.md:169-176`). ditto는 public/private/in-progress/deprecated surface를 매니페스트와 CI로 검증해야 한다.
- local installer나 hook은 사용자 작업공간을 파괴하지 않아야 한다. `scripts/link-skills.sh`는 충돌 target을 `rm -rf`로 제거하고 deprecated만 제외해 personal/in-progress가 노출될 수 있다(`scripts/link-skills.sh:26-38`). ditto에서는 destructive replacement를 기본 금지하고 `--force` 같은 명시 옵션과 백업/skip/report 정책이 필요하다.
- command string regex guardrail은 우회와 오탐 가능성이 있다. git guardrail hook은 `.tool_input.command`를 regex blocklist와 대조하고 `jq` 의존성 검증도 없다(`skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:3-20`). ditto의 안전 정책은 structured command parsing 또는 권한 기반 wrapper를 우선 검토해야 한다.
- durable artifact가 늘어나면 토큰 비용과 갱신 비용이 증가한다. ditto는 PURPOSE.md의 토큰 비용 절감 목적에 맞게 `CONTEXT.md`/ADR/out-of-scope를 “먼저 소비, 필요할 때만 생성” 원칙으로 제한해야 한다.

### 근거

- PURPOSE.md 근거: ditto는 범용 개발 작업을 돕는 coding agent harness이며, 사용자 인지 비용 절감, 할루시네이션 방지, 사용자 의도 밖 추론/작업 제한, Context Rot 해결, 장기 실행 작업 완수, 토큰 비용 절감을 핵심 가치로 둔다. 핵심 기능으로 감사 기록과 세션 핸드오프, 주요 결정 및 변경사항 영속화, subagent 활용, ubiquitous language, 충분한 컨텍스트를 동반한 질문, 정규화된 interface 기반 오케스트레이션, E2E 테스트 도구, Deep Module 사고를 명시한다.
- 보고서 근거: 이 문서는 mattpocock-skills의 repo-local setup, hard/soft dependency ADR, `CONTEXT.md`/ADR 운용, diagnosis feedback loop, triage/agent brief/out-of-scope, architecture/deep module skill, skill description discipline을 확인했고 각각의 repo-relative 근거를 본문에 유지하고 있다(`skills/engineering/setup-matt-pocock-skills/SKILL.md:7-15`, `docs/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md:3-10`, `skills/engineering/grill-with-docs/SKILL.md:72-86`, `skills/engineering/diagnose/SKILL.md:12-49`, `skills/engineering/triage/AGENT-BRIEF.md:1-37`, `skills/engineering/improve-codebase-architecture/SKILL.md:6-81`, `skills/productivity/write-a-skill/SKILL.md:60-89`).
