/**
 * wizard 대화형 프롬프트 primitive (readline 기반, IO 주입형).
 *
 * 핵심 규칙: **TTY가 없으면 묻지 않는다.** `ditto`는 사람이 터미널에서 직접 돌릴 때만
 * 대화하고, 에이전트/CI가 부를 땐 입력을 받을 수 없으므로 기본값으로 진행한다(CRA의
 * `--yes` 패턴). IO를 주입해 stdin 없이 순수 로직을 단위테스트한다 — codeql InstallDeps와
 * 같은 주입 패턴.
 */

export interface PromptIO {
  /** stdin이 TTY인가. false면 어떤 프롬프트도 묻지 않고 기본값을 돌려준다. */
  isTTY: boolean;
  /** 한 줄 질문하고 입력 한 줄을 받는다(개행 포함 가능, 호출부가 trim). */
  ask: (query: string) => Promise<string>;
  /** 안내/목록 출력. */
  write: (text: string) => void;
  /**
   * 화살표/체크박스 TUI 위젯(실제 단말 전용). 있으면 TTY 경로에서 우선 사용한다.
   * raw-mode init이 throw하거나 사용자가 취소하면 `undefined`를 돌려주고, 그러면
   * 기존 line-based(ask/write) 경로로 fallback한다(ADR-0018). 단위테스트의 주입 IO는
   * 이 필드를 제공하지 않으므로 항상 line-based 순수 로직을 탄다.
   */
  tui?: TuiPrompts;
}

/** 실제 단말에서 화살표+space 체크 TUI를 제공하는 어댑터. fallback이 필요하면 undefined 반환. */
export interface TuiPrompts {
  /** 화살표+Enter 단일선택. */
  select: (message: string, options: Option[], defaultValue: string) => Promise<string | undefined>;
  /** space 체크박스 다중선택. */
  multiSelect: (message: string, choices: Choice[]) => Promise<string[] | undefined>;
  /** y/n 확인. */
  confirm: (message: string, defaultYes: boolean) => Promise<boolean | undefined>;
}

/** y/n 확인. 비TTY거나 빈 입력이면 defaultYes. */
export async function confirm(
  io: PromptIO,
  message: string,
  defaultYes: boolean,
): Promise<boolean> {
  if (!io.isTTY) return defaultYes;
  if (io.tui) {
    const r = await io.tui.confirm(message, defaultYes);
    if (r !== undefined) return r;
  }
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = (await io.ask(`${message} ${hint} `)).trim().toLowerCase();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

export interface Choice {
  /** 사용자에게 보이는 라벨. */
  label: string;
  /** 선택 시 반환되는 값. */
  value: string;
  /** 기본 체크 여부(추론 결과). */
  checked: boolean;
}

export interface Option {
  label: string;
  value: string;
}

/**
 * 단일 선택(번호). 비TTY거나 빈/잘못된 입력이면 defaultValue.
 * defaultValue는 options에 존재해야 한다(호출부 책임).
 */
export async function select(
  io: PromptIO,
  message: string,
  options: Option[],
  defaultValue: string,
): Promise<string> {
  if (!io.isTTY || options.length === 0) return defaultValue;
  if (io.tui) {
    const r = await io.tui.select(message, options, defaultValue);
    if (r !== undefined) return r;
  }
  const defaultIdx = options.findIndex((o) => o.value === defaultValue);
  io.write(`${message}\n`);
  options.forEach((o, i) => {
    const mark = o.value === defaultValue ? '(기본)' : '';
    io.write(`  ${i + 1}. ${o.label} ${mark}\n`);
  });
  const ans = (await io.ask(`번호 (Enter=${defaultIdx + 1}): `)).trim();
  if (ans === '') return defaultValue;
  const n = Number.parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
  return defaultValue;
}

/**
 * 다중선택(번호 입력 방식 — raw-mode 화살표 없이 line-based라 견고·테스트 용이).
 * 비TTY거나 빈 입력이면 기본 체크된 항목(추론 결과)을 그대로 돌려준다.
 * 범위 밖/비숫자 토큰은 무시한다.
 */
export async function multiSelect(
  io: PromptIO,
  message: string,
  choices: Choice[],
): Promise<string[]> {
  const defaults = choices.filter((c) => c.checked).map((c) => c.value);
  if (!io.isTTY || choices.length === 0) return defaults;
  if (io.tui) {
    const r = await io.tui.multiSelect(message, choices);
    if (r !== undefined) return r;
  }

  io.write(`${message}\n`);
  choices.forEach((c, i) => io.write(`  ${i + 1}. [${c.checked ? 'x' : ' '}] ${c.label}\n`));
  const ans = (await io.ask('설치할 번호 (쉼표 구분, Enter=기본값 유지): ')).trim();
  if (ans === '') return defaults;

  const picked = new Set(
    ans
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length),
  );
  return choices.filter((_, i) => picked.has(i + 1)).map((c) => c.value);
}
