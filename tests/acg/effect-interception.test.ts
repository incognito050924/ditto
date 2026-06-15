import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareTraces, interceptEffects } from '~/acg/tidy/effect-interception';

// A mutable fs handle (CJS require) — patchable, unlike a frozen `import * as fs` namespace.
// The interception applicability boundary (effects must be reached via a patchable object
// reference, not an import-bound binding) is documented in effect-interception.ts.
const fsCjs = require('node:fs') as typeof import('node:fs');

// wi_260615t8o ac-1 (ADR-0018) — the effect-interception core. It patches a whitelist of
// effect channels (object+method), runs a function, records the ordered (channel,args)
// trace of calls that pass through, and ALWAYS restores the originals afterward.

describe('interceptEffects — record ordered effect trace, always restore', () => {
  test('records each patched-channel call in order, with args, and returns the fn value', () => {
    const io = {
      read: (path: string) => `contents:${path}`,
      write: (path: string, _data: string) => path.length,
    };
    const r = interceptEffects(
      [
        { obj: io, method: 'read', name: 'io.read' },
        { obj: io, method: 'write', name: 'io.write' },
      ],
      () => {
        const a = io.read('a.txt');
        io.write('b.txt', a);
        return 'done';
      },
    );
    expect(r.returned).toBe('done');
    expect(r.threw).toBeUndefined();
    expect(r.trace).toEqual([
      { channel: 'io.read', args: ['a.txt'] },
      { channel: 'io.write', args: ['b.txt', 'contents:a.txt'] },
    ]);
  });

  test('calls the REAL underlying method (interception is transparent to behavior)', () => {
    let writes = 0;
    const io = { write: (_p: string) => ++writes };
    interceptEffects([{ obj: io, method: 'write', name: 'io.write' }], () => {
      io.write('x');
      io.write('y');
    });
    expect(writes).toBe(2); // the original ran both times
  });

  test('restores the original method after the run (no global leak)', () => {
    const io = { read: (p: string) => p };
    const original = io.read;
    interceptEffects([{ obj: io, method: 'read', name: 'io.read' }], () => io.read('z'));
    expect(io.read).toBe(original);
  });

  test('restores even when the function throws, and captures the throw', () => {
    const io = { read: (p: string) => p };
    const original = io.read;
    const r = interceptEffects([{ obj: io, method: 'read', name: 'io.read' }], () => {
      io.read('q');
      throw new Error('boom');
    });
    expect(io.read).toBe(original);
    expect(r.threw?.message).toBe('boom');
    expect(r.trace).toEqual([{ channel: 'io.read', args: ['q'] }]);
  });

  test('intercepts a REAL node:fs channel and stays transparent (ac-1 real channel)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ditto-eff-'));
    try {
      const p = join(dir, 'f.txt');
      writeFileSync(p, 'hello');
      const r = interceptEffects(
        [{ obj: fsCjs, method: 'readFileSync', name: 'fs.readFileSync' }],
        () => fsCjs.readFileSync(p, 'utf8'),
      );
      expect(r.returned).toBe('hello'); // the real read still happened
      expect(r.trace).toEqual([{ channel: 'fs.readFileSync', args: [p, 'utf8'] }]);
      // restored: a subsequent direct read is not recorded anywhere
      expect(fsCjs.readFileSync(p, 'utf8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compareTraces — behavior preservation = identical observable effect trace', () => {
  const t = (channel: string, ...args: unknown[]) => ({ channel, args });

  test('identical traces → not refuted', () => {
    const a = [t('fs.write', 'a', 'x'), t('fs.write', 'b', 'y')];
    const b = [t('fs.write', 'a', 'x'), t('fs.write', 'b', 'y')];
    expect(compareTraces(a, b).refuted).toBe(false);
  });

  test('different args → refuted at the first divergence', () => {
    const a = [t('fs.write', 'a', 'x'), t('fs.write', 'b', 'y')];
    const b = [t('fs.write', 'a', 'x'), t('fs.write', 'b', 'CHANGED')];
    const d = compareTraces(a, b);
    expect(d.refuted).toBe(true);
    expect(d.firstDivergence).toBe(1);
  });

  test('different channel/order → refuted', () => {
    const a = [t('fs.read', 'a'), t('fs.write', 'b')];
    const b = [t('fs.write', 'b'), t('fs.read', 'a')];
    expect(compareTraces(a, b).refuted).toBe(true);
  });

  test('different length → refuted (an effect appeared or vanished)', () => {
    const a = [t('fs.write', 'a')];
    const b = [t('fs.write', 'a'), t('fs.write', 'b')];
    const d = compareTraces(a, b);
    expect(d.refuted).toBe(true);
    expect(d.firstDivergence).toBe(1);
  });
});
