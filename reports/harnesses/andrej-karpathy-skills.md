# andrej-karpathy-skills 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/forrestchang/andrej-karpathy-skills`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/andrej-karpathy-skills`
- 기준 커밋: `2c606141936f1eeef17fa3043a72095b4765b9c2` (`2c60614`, `main`, `origin/main`)
- 기준 커밋 메시지: `Sync Chinese README with English version (add Cursor section) (#95)`
- 이 보고서의 모든 `repo-relative/path:line` 근거는 위 기준 커밋을 기준으로 한다.

## 조사 방법

- `gh repo clone forrestchang/andrej-karpathy-skills /private/tmp/ditto-harness-analysis/andrej-karpathy-skills`로 저장소를 지정 경로에 클론했다.
- `git rev-parse HEAD`로 기준 커밋 `2c606141936f1eeef17fa3043a72095b4765b9c2`를 확인했다.
- `git ls-files`, `rg --files --hidden`, `find . -maxdepth 4 -type f`로 일반 파일과 숨김 디렉터리 파일을 모두 확인했다. 추적 파일은 `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.cursor/rules/karpathy-guidelines.mdc`, `CLAUDE.md`, `CURSOR.md`, `EXAMPLES.md`, `README.md`, `README.zh.md`, `skills/karpathy-guidelines/SKILL.md` 9개다.
- `nl -ba`로 README, 중국어 README, Cursor 문서, Claude 루트 지침, Cursor rule, Claude plugin metadata, marketplace metadata, skill 정의, 예제 문서를 라인 번호와 함께 읽었다.
- 실행 가능한 소스 코드, 테스트, 빌드 스크립트, 패키지 매니저 메타데이터(`package.json`, `pyproject.toml` 등)는 추적 파일 목록에 없었다. 따라서 이 저장소는 코드 실행 하네스가 아니라 LLM 코딩 행동을 제약하는 프롬프트/스킬 배포 하네스로 분석한다. 이는 `git ls-files`의 9개 추적 파일 구성과 플러그인/스킬/규칙 파일의 내용에서 나온 엄밀한 추론이다.

## 핵심 특징

- 저장소의 기본 목적은 “Claude Code 행동 개선”을 위한 단일 `CLAUDE.md` 지침 제공이다. README는 저장소를 “A single `CLAUDE.md` file to improve Claude Code behavior”라고 정의하고, Karpathy의 LLM 코딩 함정 관찰에서 유래했다고 설명한다(`README.md:7`).
- 문제 정의는 세 가지로 압축된다. 모델이 잘못된 가정을 확인하지 않고 진행하는 문제(`README.md:15`), 과도한 추상화와 코드 팽창 문제(`README.md:17`), 이해하지 못한 주변 코드/주석까지 변경하는 문제(`README.md:19`)다.
- 해결책은 네 원칙으로 고정된다. `Think Before Coding`, `Simplicity First`, `Surgical Changes`, `Goal-Driven Execution`이 각각 잘못된 가정, 과잉 복잡성, 무관한 편집, 검증 가능한 성공 기준 문제를 다룬다는 표가 있다(`README.md:23-30`).
- 같은 지침을 세 배포 표면에 중복 탑재한다. 루트 `CLAUDE.md`는 프로젝트별 Claude 지침(`CLAUDE.md:1-5`), `skills/karpathy-guidelines/SKILL.md`는 Claude Code plugin skill 정의(`skills/karpathy-guidelines/SKILL.md:1-5`), `.cursor/rules/karpathy-guidelines.mdc`는 Cursor project rule이고 `alwaysApply: true`로 자동 적용된다(`.cursor/rules/karpathy-guidelines.mdc:1-4`, `CURSOR.md:7-9`).
- 플러그인 메타데이터는 `.claude-plugin/plugin.json`에서 이름, 설명, 버전, 라이선스, 키워드, 스킬 경로를 선언한다(`.claude-plugin/plugin.json:2-10`). marketplace 메타데이터는 `karpathy-skills`라는 marketplace id와 플러그인 엔트리를 선언한다(`.claude-plugin/marketplace.json:2-16`).
- README는 Claude Code plugin 설치를 권장 옵션으로 두며, marketplace 추가 명령과 plugin 설치 명령을 제공한다(`README.md:101-113`). 프로젝트별 사용을 위해 `curl -o CLAUDE.md ...` 또는 기존 `CLAUDE.md`에 append하는 명령도 제공한다(`README.md:115-126`).
- Cursor 지원은 README와 별도 문서에 명시되어 있다. README는 `.cursor/rules/karpathy-guidelines.mdc`가 커밋되어 같은 지침을 Cursor에 적용한다고 설명한다(`README.md:128-130`). `CURSOR.md`는 Cursor가 `.claude-plugin/`이나 `CLAUDE.md`를 기본으로 읽지 않는다고 구분한다(`CURSOR.md:21-24`).
- 예제 문서는 추상 원칙을 실제 코드 리뷰 상황으로 번역한다. 예를 들어 “export user data” 요청에서 전체 사용자/파일 위치/필드/CSV 스키마를 임의 가정하는 코드를 나쁜 예로 들고(`EXAMPLES.md:11-36`), 구현 전 scope/format/fields/volume을 물어보는 흐름을 좋은 예로 제시한다(`EXAMPLES.md:38-55`).

## 구조/아키텍처

### 파일 구조

- `README.md`: 영어 소개, 문제/해결 원칙, 설치, Cursor 사용, 작동 여부 지표, 커스터마이징, tradeoff, 라이선스 문서다(`README.md:11-171`).
- `README.zh.md`: 영어 README의 중국어 번역판이다. 같은 설치 명령과 Cursor 섹션을 포함한다(`README.zh.md:99-130`).
- `CLAUDE.md`: 프로젝트 루트에 놓는 Claude Code 행동 지침이다. “project-specific instructions와 merge”하라고 설명하고, tradeoff를 먼저 밝힌다(`CLAUDE.md:1-5`).
- `.claude-plugin/plugin.json`: Claude Code plugin 패키지 메타데이터다. `skills` 배열이 `./skills/karpathy-guidelines`를 가리킨다(`.claude-plugin/plugin.json:2-10`).
- `.claude-plugin/marketplace.json`: marketplace 엔트리다. marketplace 이름/id가 `karpathy-skills`이고, 플러그인 `andrej-karpathy-skills`의 source가 `./`로 지정된다(`.claude-plugin/marketplace.json:2-16`).
- `skills/karpathy-guidelines/SKILL.md`: YAML frontmatter가 있는 재사용 가능한 skill 정의다. name, description, license를 선언하고(`skills/karpathy-guidelines/SKILL.md:1-5`), 본문에 네 원칙을 담는다(`skills/karpathy-guidelines/SKILL.md:13-67`).
- `.cursor/rules/karpathy-guidelines.mdc`: Cursor project rule이다. description과 `alwaysApply: true` frontmatter가 있고(`.cursor/rules/karpathy-guidelines.mdc:1-4`), 본문은 `CLAUDE.md`와 같은 네 원칙을 담는다(`.cursor/rules/karpathy-guidelines.mdc:12-70`).
- `CURSOR.md`: Cursor 적용 방식, 다른 프로젝트로 복사하는 방법, Claude Code와 Cursor 적용 경로 차이, 동기화 유지 지침을 문서화한다(`CURSOR.md:5-28`).
- `EXAMPLES.md`: 네 원칙별 나쁜 패턴과 좋은 패턴을 코드 예시로 설명한다(`EXAMPLES.md:1-4`, `EXAMPLES.md:498-522`).

### 아키텍처 해석

- 이 저장소의 중심 아티팩트는 “동일한 행동 정책 텍스트”다. 그 정책이 `CLAUDE.md`, Cursor rule, skill file로 복제되어 각 에이전트 런타임의 읽기 경로에 맞게 배포된다. 이는 `CURSOR.md`가 Claude Code는 plugin marketplace 또는 `CLAUDE.md`를 사용하고 Cursor는 `.cursor/rules/` 파일을 사용한다고 명시하는 데서 확인된다(`CURSOR.md:21-24`).
- 엄밀한 추론: 저장소는 실행 시점에 코드를 호출하는 harness가 아니라, LLM의 계획/편집/검증 행동을 제어하는 prompt harness다. 근거는 추적 파일 전체가 markdown/json 설정 파일뿐이고, plugin metadata가 skill 경로만 선언하며(`.claude-plugin/plugin.json:10`), skill 본문도 실행 스크립트가 아니라 행동 지침으로 구성되어 있기 때문이다(`skills/karpathy-guidelines/SKILL.md:13-67`).
- 엄밀한 추론: 같은 텍스트를 여러 파일에 복제하는 구조는 단일 소스 자동 생성보다 유지보수 비용을 감수한 호환성 우선 설계다. 근거는 `CURSOR.md`가 네 원칙 변경 시 `CLAUDE.md`, `.cursor/rules/karpathy-guidelines.mdc`, 필요 시 `skills/karpathy-guidelines/SKILL.md`를 함께 동기화하라고 직접 지시하기 때문이다(`CURSOR.md:26-28`).

## 도구/명령/스크립트/프롬프트 인벤토리

### Claude Code plugin marketplace 명령

- `/plugin marketplace add forrestchang/andrej-karpathy-skills`: Claude Code 안에서 marketplace를 먼저 추가하는 명령으로 문서화되어 있다(`README.md:101-106`).
- `/plugin install andrej-karpathy-skills@karpathy-skills`: 추가한 marketplace에서 plugin을 설치하는 명령으로 문서화되어 있다(`README.md:108-111`).
- 역할: 지침을 Claude Code plugin으로 설치해 모든 프로젝트에서 skill을 사용할 수 있게 하는 경로다. README가 “making the skill available across all your projects”라고 설명한다(`README.md:113`).

### 프로젝트별 `CLAUDE.md` 설치 명령

- 신규 프로젝트: `curl -o CLAUDE.md https://raw.githubusercontent.com/forrestchang/andrej-karpathy-skills/main/CLAUDE.md`(`README.md:117-120`).
- 기존 프로젝트 append: `echo "" >> CLAUDE.md` 후 raw `CLAUDE.md`를 `>> CLAUDE.md`로 붙인다(`README.md:122-126`).
- 역할: plugin을 쓰지 않거나 프로젝트별 지침으로 병합하려는 경우를 위한 파일 기반 설치 경로다. README는 이 지침들이 project-specific instructions와 merge되도록 설계되었다고 말한다(`README.md:149-161`).

### Claude Code plugin metadata

- `.claude-plugin/plugin.json`: plugin 이름은 `andrej-karpathy-skills`, 버전은 `1.0.0`, 라이선스는 `MIT`, 키워드는 `guidelines`, `best-practices`, `coding`, `karpathy`, skills 경로는 `./skills/karpathy-guidelines`다(`.claude-plugin/plugin.json:2-10`).
- `.claude-plugin/marketplace.json`: marketplace 이름/id는 `karpathy-skills`, plugin source는 `./`, category는 `workflow`다(`.claude-plugin/marketplace.json:2-16`, `.claude-plugin/marketplace.json:20-27`).
- 역할: Claude Code plugin marketplace가 저장소 루트의 plugin과 skill 경로를 발견할 수 있게 하는 배포 메타데이터다. 이는 plugin source가 `./`이고 skills가 `./skills/karpathy-guidelines`를 가리키는 구조에서 확인된다(`.claude-plugin/marketplace.json:14`, `.claude-plugin/plugin.json:10`).

### Skill 정의

- `skills/karpathy-guidelines/SKILL.md` frontmatter는 `name: karpathy-guidelines`, 설명, `license: MIT`를 선언한다(`skills/karpathy-guidelines/SKILL.md:1-5`).
- description은 이 skill을 “writing, reviewing, or refactoring code” 때 사용하며 overcomplication 회피, surgical changes, assumptions surface, verifiable success criteria 정의를 목적으로 한다(`skills/karpathy-guidelines/SKILL.md:2-3`).
- 본문은 네 원칙과 세부 행동을 담는다. 예: 구현 전 명시적 가정, 여러 해석 제시, 단순 대안 제시, 불명확하면 멈추고 질문하기(`skills/karpathy-guidelines/SKILL.md:13-21`), 요청 밖 기능/단일사용 추상/미요청 설정 추가 금지(`skills/karpathy-guidelines/SKILL.md:23-33`), 주변 코드/주석/포맷 개선 금지와 기존 스타일 일치(`skills/karpathy-guidelines/SKILL.md:35-49`), 테스트/검증 목표로 변환(`skills/karpathy-guidelines/SKILL.md:51-67`)이다.

### Cursor project rule

- `.cursor/rules/karpathy-guidelines.mdc`는 Cursor rule frontmatter에 `alwaysApply: true`를 둔다(`.cursor/rules/karpathy-guidelines.mdc:1-4`).
- `CURSOR.md`는 이 파일이 커밋되어 있고 Cursor에서 폴더를 열면 별도 설치 없이 적용된다고 설명한다(`CURSOR.md:5-9`).
- 다른 프로젝트에 적용하려면 `.cursor/rules/karpathy-guidelines.mdc`를 대상 프로젝트의 `.cursor/rules/`로 복사하라고 한다(`CURSOR.md:11-15`).
- Cursor는 `.claude-plugin/`이나 `CLAUDE.md`를 기본으로 읽지 않는다고 설명하므로, Cursor rule이 별도로 필요한 이유가 문서화되어 있다(`CURSOR.md:21-24`).

### Root prompt 파일

- `CLAUDE.md`는 “Behavioral guidelines to reduce common LLM coding mistakes”이며 project-specific instructions와 merge하라고 한다(`CLAUDE.md:1-5`).
- 네 원칙은 구현 전 사고(`CLAUDE.md:7-15`), 단순성 우선(`CLAUDE.md:17-27`), 외과적 변경(`CLAUDE.md:29-43`), 목표 기반 실행(`CLAUDE.md:45-61`)으로 구성된다.
- 마지막 문장은 지침의 작동 신호를 “fewer unnecessary changes”, “fewer rewrites”, “clarifying questions before implementation”로 정의한다(`CLAUDE.md:63-65`).

### 예제 문서

- `EXAMPLES.md`는 “four principles”를 실제 코드 예제로 보여주며 LLM이 흔히 틀리는 방식과 고치는 방식을 설명한다고 시작한다(`EXAMPLES.md:1-4`).
- `Think Before Coding`: export 요청에서 scope/format/fields/volume을 구현 전 명확히 해야 한다는 예시를 제공한다(`EXAMPLES.md:38-55`).
- `Simplicity First`: 단순 할인 계산에 Strategy/ABC/dataclass 등 과잉 구조를 쓰는 예를 나쁜 예로 들고(`EXAMPLES.md:101-147`), 단일 함수 구현을 좋은 예로 든다(`EXAMPLES.md:149-160`).
- `Surgical Changes`: 빈 이메일 버그 수정에서 사용자명 검증, docstring, 댓글 변경까지 추가하는 diff를 나쁜 예로 들고(`EXAMPLES.md:229-268`), 이메일 처리에 필요한 줄만 바꾸는 diff를 좋은 예로 든다(`EXAMPLES.md:269-292`).
- `Goal-Driven Execution`: 인증 문제를 막연히 “review/improve/test”하는 대신 구체 이슈와 재현 테스트, 구현, edge case, 회귀 확인으로 나누라고 제시한다(`EXAMPLES.md:374-411`).
- 문서 말미는 “overcomplicated” 예시가 design pattern이나 best practice처럼 보일 수 있으나 문제는 complexity를 필요 전에 추가하는 timing이라고 정리한다(`EXAMPLES.md:507-522`).

### 스크립트/소스/테스트/패키지 메타데이터

- 추적 파일에는 실행 스크립트, 소스 디렉터리, 테스트 파일, 패키지 매니저 파일이 없다. 확인된 메타데이터는 Claude plugin/marketplace JSON과 skill/Cursor frontmatter다.
- 엄밀한 추론: 이 저장소의 검증 단위는 자동 테스트가 아니라 “LLM 행동이 diff와 질문/검증 루프에서 어떻게 나타나는가”다. 근거는 README가 작동 여부를 diff의 불필요 변경 감소, 과잉복잡성 재작업 감소, 구현 전 질문, 깨끗한 PR로 정의하기 때문이다(`README.md:140-147`).

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

### 1. `CLAUDE.md`: 짧은 루트 지침 파일이어야 하는 이유

- 근거: README가 저장소 목적을 “single `CLAUDE.md` file”이라고 정의하고(`README.md:7`), 프로젝트별 설치 옵션에서 raw `CLAUDE.md`를 새 프로젝트에 저장하거나 기존 파일에 append하도록 안내한다(`README.md:115-126`).
- 근거: `CLAUDE.md` 자체도 project-specific instructions와 merge하라고 말한다(`CLAUDE.md:1-5`).
- 엄밀한 추론: 루트 지침은 장황한 교육 문서보다 짧아야 실제 프로젝트의 기존 지침과 충돌을 줄이고 컨텍스트 비용을 낮춘다. 근거는 `CLAUDE.md`가 예제 없이 네 원칙의 핵심 행동만 65줄로 압축되어 있고(`CLAUDE.md:1-65`), 예제는 별도 `EXAMPLES.md`로 분리되어 있기 때문이다(`EXAMPLES.md:1-4`).

### 2. Claude Code plugin/skill: 프로젝트 전역 재사용 경로가 필요한 이유

- 근거: README는 plugin 설치를 recommended로 표시하고(`README.md:101`), plugin 설치 시 모든 프로젝트에서 skill을 사용할 수 있게 된다고 설명한다(`README.md:113`).
- 근거: `.claude-plugin/plugin.json`은 plugin이 `skills/karpathy-guidelines`를 포함한다고 선언한다(`.claude-plugin/plugin.json:10`).
- 엄밀한 추론: 같은 행동 규칙을 매 프로젝트마다 `CLAUDE.md`로 복사하면 동기화와 배포가 번거롭기 때문에 plugin/skill 메타데이터가 필요하다. 근거는 README가 plugin 설치와 per-project `CLAUDE.md` 설치를 별도 옵션으로 제시하고(`README.md:99-126`), `CURSOR.md`가 contributor에게 여러 파일 동기화를 요구한다는 점이다(`CURSOR.md:26-28`).

### 3. Cursor rule: 별도 `.cursor/rules` 파일이어야 하는 이유

- 근거: `CURSOR.md`는 Cursor에서 프로젝트 폴더를 열면 커밋된 rule이 `alwaysApply: true`라 별도 설치가 필요 없다고 설명한다(`CURSOR.md:5-9`).
- 근거: Cursor는 `.claude-plugin/`이나 `CLAUDE.md`를 기본으로 읽지 않는다고 명시한다(`CURSOR.md:21-24`).
- 엄밀한 추론: Cursor 지원을 실제로 보장하려면 Claude 전용 배포 파일을 재사용할 수 없고 Cursor가 인식하는 `.cursor/rules/*.mdc` 형식에 같은 지침을 복제해야 한다. 근거는 Cursor rule frontmatter의 `alwaysApply: true`와 본문 네 원칙 구성이다(`.cursor/rules/karpathy-guidelines.mdc:1-70`).

### 4. `EXAMPLES.md`: 원칙 문서와 분리된 예제 파일이어야 하는 이유

- 근거: README/CLAUDE/SKILL은 네 원칙을 간결하게 설명하지만, `EXAMPLES.md`는 “real-world code examples”로 각 원칙의 나쁜 패턴과 수정 방식을 보여준다고 밝힌다(`EXAMPLES.md:1-4`).
- 근거: 예제는 구현 전 질문, 과잉 추상화 제거, 최소 diff, 테스트 우선 검증을 길게 보여준다(`EXAMPLES.md:38-55`, `EXAMPLES.md:149-160`, `EXAMPLES.md:269-292`, `EXAMPLES.md:388-411`).
- 엄밀한 추론: 예제를 루트 prompt에 넣지 않은 것은 런타임 지침의 토큰 비용을 줄이면서도 사용자/기여자가 원칙을 학습할 수 있게 하기 위한 분리다. 근거는 runtime 성격의 `CLAUDE.md`가 65줄로 짧고, 예제 문서는 522줄로 상세하다는 파일 구성이다(`CLAUDE.md:1-65`, `EXAMPLES.md:1-522`).

### 5. Marketplace metadata: 공개 설치 경험을 위해 필요한 이유

- 근거: README의 설치 플로우는 marketplace add 후 plugin install을 전제로 한다(`README.md:101-111`).
- 근거: `.claude-plugin/marketplace.json`은 marketplace id `karpathy-skills`, plugin name `andrej-karpathy-skills`, source `./`, category `workflow`를 선언한다(`.claude-plugin/marketplace.json:2-16`, `.claude-plugin/marketplace.json:20-27`).
- 엄밀한 추론: marketplace 파일은 “이 저장소를 plugin registry처럼 추가했을 때 어떤 plugin을 노출할지”를 설명하기 위해 필요하다. 근거는 marketplace가 plugins 배열로 루트 source를 가리키고, plugin.json이 실제 skill 경로를 가리키는 두 단계 구조다(`.claude-plugin/marketplace.json:11-16`, `.claude-plugin/plugin.json:10`).

## 장점

- 문제-원칙 매핑이 선명하다. README는 세 가지 LLM 실패 모드를 먼저 인용하고(`README.md:11-20`), 네 원칙이 무엇을 해결하는지 표로 연결한다(`README.md:23-30`).
- 지침이 행동 단위로 구체적이다. 구현 전 가정 명시/해석 제시/단순 대안 제시/혼란 시 질문(`CLAUDE.md:11-15`), 요청 밖 기능 금지와 단일사용 추상 금지(`CLAUDE.md:21-25`), 주변 코드 변경 금지와 기존 스타일 준수(`CLAUDE.md:33-43`), 테스트와 검증 기준으로 작업 변환(`CLAUDE.md:49-61`)이 바로 실행 가능한 문장이다.
- 배포 경로가 다양하다. Claude Code plugin marketplace(`README.md:101-113`), per-project `CLAUDE.md` curl/append(`README.md:115-126`), Cursor project rule(`README.md:128-130`, `CURSOR.md:5-15`), 개인 Cursor skill 복사/symlink(`CURSOR.md:17-19`)를 모두 제공한다.
- Cursor와 Claude Code의 적용 차이를 명확히 분리한다. Claude Code는 plugin marketplace 또는 `CLAUDE.md`, Cursor는 `.cursor/rules/`를 사용한다고 문서화한다(`CURSOR.md:21-24`).
- 과도한 일반론을 예제로 교정한다. 예제 문서는 “best practice처럼 보이는 overcomplicated code”의 문제가 timing이라고 설명하고(`EXAMPLES.md:507-522`), 어떤 diff가 불필요한 변경인지 구체적으로 보여준다(`EXAMPLES.md:229-292`).
- tradeoff를 숨기지 않는다. README는 이 지침이 “caution over speed”에 편향되어 있고, 사소한 one-liner에는 판단을 쓰라고 말한다(`README.md:163-167`). `CLAUDE.md`와 skill도 같은 tradeoff를 앞부분에 둔다(`CLAUDE.md:5`, `skills/karpathy-guidelines/SKILL.md:11`).

## 약한 점/리스크

- 단일 소스 생성 체계가 없다. `CLAUDE.md`, Cursor rule, skill 본문이 거의 같은 내용을 중복 보유하고, `CURSOR.md`는 변경 시 세 파일을 동기화하라고 지시한다(`CURSOR.md:26-28`). 엄밀한 추론: 자동 검증/생성 스크립트가 없기 때문에 내용 drift가 발생할 수 있다. 근거는 추적 파일 목록에 생성 스크립트나 테스트가 없고, 수동 동기화 지침만 존재한다는 점이다.
- `README.md`는 `.cursor/rules/karpathy-guidelines.mdc`가 커밋되어 있다고 말하지만(`README.md:128-130`), 일반 `rg --files`에는 숨김 파일이 나오지 않는다. 사용자 입장에서는 숨김 디렉터리를 의식하지 않으면 rule 위치를 놓칠 수 있다. 단, `CURSOR.md`는 경로를 명시해 이 위험을 낮춘다(`CURSOR.md:7-15`).
- 원칙은 강하지만 자동 측정 장치가 없다. README의 작동 여부 지표는 “fewer unnecessary changes”, “fewer rewrites”, “clarifying questions”, “clean PRs”처럼 관찰 가능한 현상이지만(`README.md:140-147`), 이를 측정하는 lint/test/script는 없다. 엄밀한 추론: DITTO 같은 평가 하네스에서 재사용하려면 별도 메트릭 수집이 필요하다.
- `Goal-Driven Execution`은 테스트 우선/검증 루프를 강조하지만, 모든 작업에 테스트가 가능한 것은 아니다. README가 trivial task에는 full rigor가 필요 없다고 tradeoff를 명시해 일부 완충하지만(`README.md:163-167`), test가 없는 레거시/문서 작업에서 어느 수준의 검증이면 충분한지 세부 기준은 없다.
- “No error handling for impossible scenarios”는 과잉 방어 코드를 줄이는 데 유용하지만(`CLAUDE.md:21-25`), 안전/보안/데이터 손실 가능성이 있는 시스템에서는 “impossible” 판단이 틀릴 수 있다. 엄밀한 추론: 이 원칙을 DITTO에 적용할 때는 도메인 위험도에 따라 예외를 둬야 한다. 근거는 지침 자체가 가정을 명시하고 불확실하면 질문하라고 요구한다는 점이다(`CLAUDE.md:11-15`).
- Karpathy 원문 트윗을 근거로 삼지만, 저장소 내부에는 원문 전문이나 검증 데이터가 없다. README와 skill은 관찰 출처 링크를 제공하지만(`README.md:7`, `skills/karpathy-guidelines/SKILL.md:9`), 정량 평가나 실험 결과는 포함하지 않는다.

## DITTO에서 차용할 점

- DITTO 하네스 프롬프트도 “문제 정의 -> 행동 원칙 -> 성공 기준” 순서로 구성할 수 있다. 이 저장소는 문제를 먼저 인용하고(`README.md:11-20`), 네 원칙과 해결 대상을 표로 연결한다(`README.md:23-30`).
- 작업 시작 전 “가정/해석/단순 대안/혼란”을 드러내라는 체크를 도입할 가치가 있다. 해당 행동은 `CLAUDE.md`와 skill에 같은 문장으로 들어 있다(`CLAUDE.md:11-15`, `skills/karpathy-guidelines/SKILL.md:17-21`).
- 코드 편집 에이전트에는 “모든 변경 라인이 사용자 요청으로 추적되어야 한다”는 규칙을 명시하는 것이 효과적이다. 이 저장소는 그 문장을 surgical change의 test로 둔다(`CLAUDE.md:43`).
- DITTO의 평가/보고 작업에는 “명령형 작업을 검증 가능한 목표로 변환”하는 패턴을 가져올 수 있다. 저장소는 “Add validation”, “Fix the bug”, “Refactor X”를 테스트/검증 기준으로 바꾸는 예를 든다(`CLAUDE.md:49-61`).
- prompt harness를 여러 런타임에 배포해야 한다면, Claude plugin/skill, root instruction, Cursor rule처럼 런타임별 엔트리포인트를 분리하는 구조를 차용할 수 있다. 이 저장소는 plugin metadata와 skill path를 선언하고(`.claude-plugin/plugin.json:2-10`), Cursor가 Claude 파일을 기본으로 읽지 않는다고 분명히 나눈다(`CURSOR.md:21-24`).
- 예제는 runtime prompt에서 분리하되, 실패 예와 수정 예를 pair로 유지하는 방식을 차용할 수 있다. `EXAMPLES.md`는 각 원칙별로 나쁜 예와 좋은 예를 제공하고(`EXAMPLES.md:7-95`, `EXAMPLES.md:97-223`, `EXAMPLES.md:225-368`, `EXAMPLES.md:370-496`), anti-pattern summary까지 제공한다(`EXAMPLES.md:498-505`).
- DITTO 보고서 작성 지침에는 “tradeoff note”를 포함해야 한다. 이 저장소는 caution-over-speed 편향과 trivial task 예외를 명시한다(`README.md:163-167`).

## 보완 계획

- 단일 원본 템플릿을 두고 `CLAUDE.md`, `.cursor/rules/karpathy-guidelines.mdc`, `skills/karpathy-guidelines/SKILL.md`를 생성하는 스크립트를 추가한다. 필요성 근거: 현재 `CURSOR.md`는 세 파일 수동 동기화를 요구한다(`CURSOR.md:26-28`).
- 생성 결과가 drift되지 않았는지 확인하는 CI 또는 로컬 검증 스크립트를 둔다. 필요성 근거: 같은 네 원칙이 루트 지침(`CLAUDE.md:7-61`), Cursor rule(`.cursor/rules/karpathy-guidelines.mdc:12-66`), skill(`skills/karpathy-guidelines/SKILL.md:13-67`)에 중복되어 있다.
- “작동 여부” 지표를 DITTO 평가 지표로 구체화한다. 예: 변경 파일 수/라인 수, 요청 범위 밖 diff 비율, 구현 전 질문 발생 여부, 테스트 또는 검증 명령 실행 여부. 필요성 근거: README가 qualitative 지표를 이미 제시하지만 자동 측정은 제공하지 않는다(`README.md:140-147`).
- high-risk 작업 예외 규칙을 추가한다. 예: 보안, 결제, 데이터 삭제, 마이그레이션 작업에서는 “No error handling for impossible scenarios”보다 threat model/rollback/observability를 우선한다. 필요성 근거: 현재 지침은 과잉 방어 코드 금지에 집중하지만(`CLAUDE.md:21-25`), 위험도별 예외 기준은 없다.
- Cursor/Claude 외 런타임을 지원할 경우, 각 런타임이 어떤 파일을 실제로 읽는지 문서화한다. 필요성 근거: Cursor는 `.claude-plugin/`이나 `CLAUDE.md`를 기본으로 읽지 않는다는 차이를 따로 적어야 했다(`CURSOR.md:21-24`).
- 설치 문서에는 숨김 파일 확인 방법을 덧붙인다. 필요성 근거: Cursor rule은 `.cursor/rules/karpathy-guidelines.mdc`에 있고(`.cursor/rules/karpathy-guidelines.mdc:1-4`), 숨김 디렉터리라 일반 파일 탐색에서 놓치기 쉽다.

## 근거 목록

- `README.md:7`: 저장소 목적을 단일 `CLAUDE.md` 기반 Claude Code 행동 개선으로 정의.
- `README.md:11-20`: 잘못된 가정, 과잉복잡성, 무관한 주변 변경이라는 문제 정의.
- `README.md:23-30`: 네 원칙과 해결 대상 매핑.
- `README.md:34-43`: Think Before Coding 세부 행동.
- `README.md:45-57`: Simplicity First 세부 행동과 senior engineer overcomplication test.
- `README.md:59-75`: Surgical Changes 세부 행동과 변경 라인 traceability test.
- `README.md:77-97`: Goal-Driven Execution과 검증 가능한 계획 템플릿.
- `README.md:99-126`: Claude plugin 설치와 per-project `CLAUDE.md` 설치 명령.
- `README.md:128-130`: Cursor rule 포함과 `CURSOR.md` 참조.
- `README.md:140-147`: 지침 작동 여부 관찰 지표.
- `README.md:149-161`: project-specific rule과 병합하는 커스터마이징 방식.
- `README.md:163-167`: caution over speed tradeoff와 trivial task 예외.
- `README.zh.md:99-130`: 중국어 README도 plugin 설치, `CLAUDE.md` 설치, Cursor 사용 섹션을 포함.
- `CLAUDE.md:1-5`: root instruction의 목적과 tradeoff.
- `CLAUDE.md:7-65`: 네 원칙의 압축 실행 지침.
- `.claude-plugin/plugin.json:2-10`: plugin 이름, 설명, 버전, 라이선스, 키워드, skill path.
- `.claude-plugin/marketplace.json:2-16`: marketplace id/name과 plugin source, 설명, 버전.
- `.claude-plugin/marketplace.json:20-27`: marketplace plugin keyword/category.
- `skills/karpathy-guidelines/SKILL.md:1-5`: skill frontmatter.
- `skills/karpathy-guidelines/SKILL.md:13-67`: skill 본문 네 원칙.
- `.cursor/rules/karpathy-guidelines.mdc:1-4`: Cursor rule frontmatter와 `alwaysApply: true`.
- `.cursor/rules/karpathy-guidelines.mdc:12-70`: Cursor rule 본문 네 원칙.
- `CURSOR.md:5-9`: 이 저장소에서 Cursor rule이 자동 적용되는 방식.
- `CURSOR.md:11-19`: 다른 프로젝트 또는 개인 Cursor skill로 옮기는 방법.
- `CURSOR.md:21-24`: Claude Code와 Cursor가 읽는 지침 경로 차이.
- `CURSOR.md:26-28`: 세 지침 파일 동기화 유지 지침.
- `EXAMPLES.md:1-4`: 예제 문서 목적.
- `EXAMPLES.md:11-55`: export 기능 요청에서 숨은 가정과 구현 전 질문 예시.
- `EXAMPLES.md:97-160`: discount 계산에서 과잉 추상화와 단순 구현 비교.
- `EXAMPLES.md:162-221`: 사용자 preference 저장에서 미요청 기능을 추가하는 위험.
- `EXAMPLES.md:225-292`: 빈 이메일 버그 수정에서 최소 diff 원칙.
- `EXAMPLES.md:293-367`: upload logging에서 스타일 drift 위험과 기존 스타일 유지.
- `EXAMPLES.md:370-452`: 인증/ratelimit 작업에서 검증 가능한 계획 구성.
- `EXAMPLES.md:454-494`: duplicate score sorting 버그의 test-first 재현/수정 예.
- `EXAMPLES.md:498-522`: anti-pattern 요약과 premature complexity의 문제.

## ditto 적용 정리

- 적용할 기능/가치: `Think Before Coding`, `Simplicity First`, `Surgical Changes`, `Goal-Driven Execution`을 DITTO의 기본 작업 계약으로 흡수한다. PURPOSE.md가 말하는 “사용자의 의도와 벗어나 LLM이 멋대로 추론 및 작업을 하는 것을 구조적으로 제한”, “할루시네이션 방지”, “사용자의 인지 비용 최소화”와 직접 맞는다. 보고서 본문에서도 이 네 원칙이 잘못된 가정, 과잉 복잡성, 무관한 편집, 검증 가능한 성공 기준 문제를 각각 다룬다고 정리되어 있다(`README.md:23-30`, `CLAUDE.md:7-65`).
- 어떻게 적용할지: DITTO의 구현/리뷰/문서 작업 단계 진입 시 “가정, 가능한 해석, 가장 단순한 대안, 불확실하면 질문”을 먼저 점검하는 짧은 체크를 둔다. 질문은 PURPOSE.md의 요구처럼 사용자가 판단할 충분한 컨텍스트를 포함할 때만 발생시킨다. 근거는 구현 전 명시적 가정, 여러 해석 제시, 단순 대안 제시, 불명확하면 질문하라는 지침이다(`CLAUDE.md:11-15`, `skills/karpathy-guidelines/SKILL.md:17-21`, `EXAMPLES.md:11-55`).
- 어떻게 적용할지: 코드 편집 agent의 감사 기록에 “변경 라인 또는 변경 묶음이 어떤 사용자 요청/성공 기준에 대응하는가”를 남긴다. PURPOSE.md의 “모든 액션에는 감사 기록이 누적된다”와 “주요 결정 및 변경사항 영속화”에 맞추어, surgical change의 traceability test를 DITTO의 diff 검증 항목으로 만든다. 보고서 근거는 요청 밖 기능, 단일사용 추상, 주변 코드/주석/포맷 변경을 금지하고 모든 변경 라인이 사용자 요청으로 추적되어야 한다는 규칙이다(`CLAUDE.md:21-43`, `README.md:59-75`, `EXAMPLES.md:225-292`).
- 적용 이후 제공 가치: 명령형 요청을 검증 가능한 목표로 바꾸는 루프를 DITTO 오케스트레이션에 넣으면, 장기간 작업에서도 “처음 의도한 바, 목적대로 끈질기게 완수”하고 완료 주장을 테스트/빌드/실행 로그/산출물 diff 같은 증거 위에 둘 수 있다. 보고서는 “Add validation”, “Fix the bug”, “Refactor X”를 테스트와 검증 기준으로 변환하는 패턴을 제시한다(`CLAUDE.md:49-61`, `README.md:77-97`, `EXAMPLES.md:370-452`, `EXAMPLES.md:454-494`).
- 적용 이후 제공 가치: 런타임 prompt는 짧은 원칙으로 유지하고, 실패/수정 예시는 별도 참조 문서로 분리한다. 이는 PURPOSE.md의 “Token 비용을 낭비하지 않는다”, “Context Rot 이슈 해결”, “정제된 출력 메시지” 가치와 맞는다. 보고서 근거는 `CLAUDE.md`가 65줄의 압축 지침이고 예제는 `EXAMPLES.md`로 분리되어 있으며, 나쁜 예와 좋은 예를 pair로 유지한다는 점이다(`CLAUDE.md:1-65`, `EXAMPLES.md:1-4`, `EXAMPLES.md:498-522`).
- 주의할 리스크나 선행 조건: 이 저장소처럼 `CLAUDE.md`, Cursor rule, skill 본문을 수동 복제하면 DITTO의 하네스/서브에이전트/런타임별 지침도 drift될 수 있다. DITTO는 PURPOSE.md에서 단계별 정규화된 interface와 산출물 계약을 요구하므로, 여러 런타임 엔트리포인트를 둘 경우 단일 원본 또는 drift 검증이 선행되어야 한다. 보고서도 수동 동기화 지침과 자동 검증 부재를 약점으로 기록한다(`CURSOR.md:26-28`, `.cursor/rules/karpathy-guidelines.mdc:1-70`, `skills/karpathy-guidelines/SKILL.md:13-67`).
- 주의할 리스크나 선행 조건: 이 지침은 “caution over speed”에 편향되어 있고 자동 측정 장치가 없다. 따라서 DITTO에 넣을 때는 trivial task 예외, 보안/데이터 삭제/마이그레이션 같은 high-risk 예외, 그리고 변경 파일 수, 요청 범위 밖 diff 비율, 구현 전 질문 여부, 검증 명령 실행 여부 같은 관찰 지표를 함께 정의해야 한다. 보고서 근거는 작동 여부가 정성 지표로만 제시되고(`README.md:140-147`), tradeoff가 명시되어 있으며(`README.md:163-167`), “impossible scenario” 판단이 위험할 수 있다는 리스크 분석이다(`CLAUDE.md:21-25`).
