# ADR-0012: 제품/프로젝트전역/개인 3계층 격리 — `.ditto/local` 개인구획 + `dist/plugin` 배포조립

- 상태: accepted
- 결정 일자: 2026-06-07
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0005 (런타임 산출물 저장 — 2계층 gitignore 분리를 3계층으로 정밀화), ADR-0011 (Distribution 축), CLAUDE.md §9 (산출물 위치), `src/core/ditto-paths.ts`, `scripts/build-plugin.mjs`

## 컨텍스트

DITTO는 한 워크트리 안에 성격이 다른 세 종류의 자산을 섞어 두고 있었다.

1. **제품 표면** — 다른 사용자·PC에 배포되어 실행되는 단위: `.claude-plugin/plugin.json`, `hooks/`, `agents/`(루트), `skills/`, 컴파일된 `bin/`.
2. **프로젝트 전역 거버넌스** — git으로 팀과 공유해야 하는 결정 메모리: `.ditto/knowledge/`(glossary·ADR), `.ditto/architecture-spec.json`, `.ditto/agents/`(variant 카탈로그).
3. **개인 런타임 트레일** — 각 개발자·머신마다 다른 작업 흔적: `.ditto/work-items/`, `runs/`, `sessions/`, `cache/`, `logs/`, `worktrees/`, `handoff/`, `surfaces.json`.

ADR-0005는 이미 durable/ephemeral 2계층을 `.gitignore`로 갈라 두었지만, ① 개인 트레일과 프로젝트 전역 거버넌스가 둘 다 `.ditto/` 직속에 평면으로 섞여 있어 "팀이 공유할 것"과 "개인만 볼 것"의 경계가 경로상 드러나지 않았고, ② 배포 단위가 레포 루트 전체(`source: "./"`)를 가리켜 소스·테스트·dogfooding 트레일까지 플러그인 표면에 노출됐다.

## 결정

### D1 — 개인 런타임은 `.ditto/local/` 한 구획으로 물리 분리한다 (축2)

> **부분 supersede (2026-07-06, wi_2607069bk)** — D1의 "work-items를 개인 tier로 전부 `.ditto/local/`에 둔다"는 부분은 **ADR-20260706-work-item-record-run-split**이 supersede한다. work item은 이제 Record(커밋·공유, `.ditto/work-items/<id>/` = record.json + events/)와 Run(개인·폐기가능, `.ditto/local/work-items/<id>/`)으로 쪼개진다 — 프로젝트 메모리(status·AC verdict·github 멱등)는 커밋된 Record에 durable하게 남고, Run 삭제는 무손실이다. runs·sessions·cache·logs·worktrees·handoff의 개인 tier 분류와 D2·D3·3계층 골격은 불변.

- 개인 런타임 디렉터리/파일(work-items·runs·sessions·cache·logs·worktrees·handoff·surfaces.json)을 전부 `.ditto/local/<name>` 아래로 이전한다.
- 모든 store/모듈의 경로 상수는 단일 헬퍼 `src/core/ditto-paths.ts`의 `localDir(repoRoot, ...segments)`를 경유한다(약 30곳). 직접 `join(root,'.ditto','work-items',...)` 문자열을 더 이상 쓰지 않는다 — 경계가 코드 한 곳에 모인다.
- `.ditto/knowledge/`·`.ditto/architecture-spec.json`·`.ditto/agents/`는 `.ditto/` 직속(전역)에 그대로 둔다. `findRepoRoot` 마커(`.ditto`)와 스캔 제외 리스트(`.ditto` 전체)도 그대로다.

### D2 — gitignore가 3계층 경계를 집행한다 (축2)

- `.ditto/.gitignore`(init-scaffold 생성)는 `local/` 한 줄만 ignore하고 `knowledge/`·`agents/`는 추적한다.
- 레포 루트 `.gitignore`도 `.ditto/local/`만 ignore한다. 결과: 개인 트레일은 커밋되지 않고(개발자별), 거버넌스는 팀과 공유된다.

### D3 — 배포 단위는 `dist/plugin` 조립 산출물로 좁힌다 (축1)

- `scripts/build-plugin.mjs`(`bun run build:plugin`)가 제품 표면만 `dist/plugin/`에 조립한다: `.claude-plugin/plugin.json` + `hooks/` + `agents/`(루트) + `skills/`(+ 있으면 `commands/`) + 컴파일된 `bin/`.
- `src/`·`tests/`·`schemas/`·`.ditto/`·`reports/`는 조립물에 들어가지 않는다.
- `marketplace.json`의 source가 `./dist/plugin`을 가리키고, `install-plugin.mjs`의 register/build/place가 제품 표면을 `dist/plugin`에서 해석한다.
- 조립 시 바이너리는 레포 루트 `bin/`이 아니라 `dist/plugin/bin/`로 직접 컴파일한다 — 실행 중 세션의 라이브 `bin/ditto`를 빌드가 덮어쓰지 않게 한다.

## 근거

- 3계층은 "누가 무엇을 공유하는가"라는 서로 다른 수명·소유 모델을 가진 자산을 경로로 분리한다. 경로가 곧 정책이라 새 store를 추가해도 경계가 흐려지지 않는다(헬퍼 단일 경유).
- 개인 트레일을 gitignore로 빼면 다른 사용자·PC에서 깨끗한 거버넌스만 받아 적용할 수 있다(사용자 요구의 핵심).
- 배포 표면을 `dist/plugin`으로 좁히면 소스·dogfooding 트레일이 제품에 새지 않는다(축1 — distribution).
- 신규 의존 0: 기존 파일 store·gitignore·Node 조립 스크립트만으로 성립(ADR-0001 단순성, ADR-0002 SoT 준수).

## 대안 (기각)

- **knowledge를 `.ditto` 밖 소스트리(governance/)로 승격:** 이번엔 `.ditto/knowledge`를 전역 구획으로 유지(런타임 경로 규약 특례 회피). follow-up 후보로 남긴다.
- **개인 트레일을 계속 `.ditto/` 평면에 두고 gitignore 패턴만 늘리기:** 경계가 경로에 드러나지 않아 store가 늘수록 누락 위험이 커진다. 기각.
- **배포 단위로 레포 루트 전체 유지(`source: "./"`):** 소스·테스트·dogfooding 노출. 기각(D3).

## 철회/재검토 조건

- 전역 거버넌스(knowledge ADR/glossary)를 `.ditto` 밖 소스트리로 승격할 실익이 실증되면 → 런타임 경로 규약 특례를 정의하고 D1의 잔류 결정을 재검토.
- `dist/plugin` 조립 표면이 런타임에 부족한 파일을 요구하면(예: 추가 정적 자산) → ALWAYS_DIRS/OPTIONAL_DIRS 목록을 명시 확장.
