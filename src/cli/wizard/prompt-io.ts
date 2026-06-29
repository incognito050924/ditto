import { createInterface } from 'node:readline/promises';
/**
 * 실제 stdin/stdout을 쓰는 PromptIO 구현. 순수 로직(prompt.ts)과 분리해
 * 테스트가 node:readline·@clack/prompts에 의존하지 않게 한다.
 *
 * 두 채널을 제공한다:
 *   - line-based readline(ask/write) — fallback 경로(raw-mode 불가·취소 시).
 *   - @clack/prompts TUI(tui) — 화살표 이동+space 체크 위젯. TTY에서만 우선 사용.
 * clack은 비TTY에서 자동 fallback하지 않고 piped stdin을 garble하므로, prompt.ts의
 * isTTY 게이트가 load-bearing이다 — io.isTTY가 false면 tui를 아예 호출하지 않는다.
 */
import {
  confirm as clackConfirm,
  multiselect as clackMultiselect,
  select as clackSelect,
  isCancel,
} from '@clack/prompts';
import type { PromptIO, TuiPrompts } from './prompt';

export interface StdioPromptIO extends PromptIO {
  /** readline 인터페이스를 닫는다(wizard 종료 시 1회). */
  close: () => void;
}

/**
 * @clack/prompts 기반 화살표+체크박스 TUI. raw-mode init이 throw하거나 사용자가
 * 취소(Ctrl-C)하면 `undefined`를 돌려줘 prompt.ts가 line-based로 fallback하게 한다.
 * 어떤 경우에도 throw하지 않는다(ADR-0018: 도구 부재가 의도 실현을 막지 않는다).
 */
const clackTui: TuiPrompts = {
  async select(message, options, defaultValue) {
    try {
      const r = await clackSelect({
        message,
        options: options.map((o) => ({ value: o.value, label: o.label })),
        initialValue: defaultValue,
      });
      return isCancel(r) ? undefined : (r as string);
    } catch {
      return undefined;
    }
  },
  async multiSelect(message, choices) {
    try {
      const r = await clackMultiselect({
        message,
        options: choices.map((c) => ({ value: c.value, label: c.label })),
        initialValues: choices.filter((c) => c.checked).map((c) => c.value),
        required: false,
      });
      return isCancel(r) ? undefined : (r as string[]);
    } catch {
      return undefined;
    }
  },
  async confirm(message, defaultYes) {
    try {
      const r = await clackConfirm({ message, initialValue: defaultYes });
      return isCancel(r) ? undefined : (r as boolean);
    } catch {
      return undefined;
    }
  },
};

/** process.stdin/stdout에 묶인 PromptIO를 만든다. wizard가 1회 생성·재사용·close. */
export function createStdioPromptIO(): StdioPromptIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const isTTY = Boolean(process.stdin.isTTY);
  return {
    isTTY,
    ask: (query) => rl.question(query),
    write: (text) => {
      process.stdout.write(text);
    },
    // TTY일 때만 clack TUI를 노출한다. 비TTY면 prompt.ts가 기본값으로 즉시 빠져 tui를
    // 부르지 않지만, 방어적으로 비TTY엔 아예 달지 않는다(piped stdin garble 회피).
    ...(isTTY ? { tui: clackTui } : {}),
    close: () => {
      rl.close();
    },
  };
}
