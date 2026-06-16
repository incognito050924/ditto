import { describe, expect, test } from 'bun:test';
import { type Choice, type PromptIO, confirm, multiSelect } from '~/cli/wizard/prompt';

/** 답변 큐 + 출력 캡처를 갖는 가짜 PromptIO. */
function fakeIO(opts: { isTTY: boolean; answers?: string[] }): {
  io: PromptIO;
  output: string[];
  asked: string[];
} {
  const answers = [...(opts.answers ?? [])];
  const output: string[] = [];
  const asked: string[] = [];
  const io: PromptIO = {
    isTTY: opts.isTTY,
    ask: async (query) => {
      asked.push(query);
      return answers.shift() ?? '';
    },
    write: (text) => {
      output.push(text);
    },
  };
  return { io, output, asked };
}

const choices: Choice[] = [
  { label: 'TypeScript (142)', value: 'typescript', checked: true },
  { label: 'Python (37)', value: 'python', checked: true },
  { label: 'Lua (3)', value: 'lua', checked: false },
];

describe('confirm', () => {
  test('비TTY면 묻지 않고 defaultYes 반환', async () => {
    const { io, asked } = fakeIO({ isTTY: false });
    expect(await confirm(io, '계속?', true)).toBe(true);
    expect(await confirm(io, '계속?', false)).toBe(false);
    expect(asked).toEqual([]); // 한 번도 묻지 않음
  });

  test('빈 입력은 기본값', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['', ''] });
    expect(await confirm(io, 'x', true)).toBe(true);
    expect(await confirm(io, 'x', false)).toBe(false);
  });

  test('y/yes → true, n/no → false (대소문자 무시)', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['Y', 'yes', 'N', 'no'] });
    expect(await confirm(io, 'x', false)).toBe(true);
    expect(await confirm(io, 'x', false)).toBe(true);
    expect(await confirm(io, 'x', true)).toBe(false);
    expect(await confirm(io, 'x', true)).toBe(false);
  });

  test('TTY일 때 힌트가 기본값에 따라 다르다', async () => {
    const { io, asked } = fakeIO({ isTTY: true, answers: ['', ''] });
    await confirm(io, 'A', true);
    await confirm(io, 'B', false);
    expect(asked[0]).toContain('[Y/n]');
    expect(asked[1]).toContain('[y/N]');
  });
});

describe('multiSelect', () => {
  test('비TTY면 기본 체크된 값만 반환(묻지 않음)', async () => {
    const { io, asked } = fakeIO({ isTTY: false });
    expect(await multiSelect(io, '도구', choices)).toEqual(['typescript', 'python']);
    expect(asked).toEqual([]);
  });

  test('빈 입력은 기본 체크 유지', async () => {
    const { io } = fakeIO({ isTTY: true, answers: [''] });
    expect(await multiSelect(io, '도구', choices)).toEqual(['typescript', 'python']);
  });

  test('번호 입력으로 선택 집합 교체 (Lua만)', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['3'] });
    expect(await multiSelect(io, '도구', choices)).toEqual(['lua']);
  });

  test('쉼표 다중 선택', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['1, 3'] });
    expect(await multiSelect(io, '도구', choices)).toEqual(['typescript', 'lua']);
  });

  test('범위 밖/비숫자 토큰은 무시', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['2, 99, abc'] });
    expect(await multiSelect(io, '도구', choices)).toEqual(['python']);
  });

  test('선택지 목록을 [x]/[ ] 마킹과 함께 출력', async () => {
    const { io, output } = fakeIO({ isTTY: true, answers: [''] });
    await multiSelect(io, '분석/언어 도구', choices);
    const joined = output.join('');
    expect(joined).toContain('1. [x] TypeScript');
    expect(joined).toContain('3. [ ] Lua');
  });

  test('빈 선택지는 빈 배열', async () => {
    const { io } = fakeIO({ isTTY: true, answers: ['1'] });
    expect(await multiSelect(io, '도구', [])).toEqual([]);
  });
});
