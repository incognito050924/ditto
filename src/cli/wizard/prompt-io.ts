/**
 * 실제 stdin/stdout을 쓰는 PromptIO 구현(readline). 순수 로직(prompt.ts)과 분리해
 * 테스트가 node:readline에 의존하지 않게 한다.
 */
import { createInterface } from 'node:readline/promises';
import type { PromptIO } from './prompt';

export interface StdioPromptIO extends PromptIO {
  /** readline 인터페이스를 닫는다(wizard 종료 시 1회). */
  close: () => void;
}

/** process.stdin/stdout에 묶인 PromptIO를 만든다. wizard가 1회 생성·재사용·close. */
export function createStdioPromptIO(): StdioPromptIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    isTTY: Boolean(process.stdin.isTTY),
    ask: (query) => rl.question(query),
    write: (text) => {
      process.stdout.write(text);
    },
    close: () => {
      rl.close();
    },
  };
}
