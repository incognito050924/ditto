import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Minimal LSP diagnostics client. Given an installed language server, opens one
 * file and returns the diagnostics the server pushes for it.
 *
 * Per ADR-0018 the server is an OPTIONAL tool: absence must DEGRADE, never halt.
 * `resolveServer` returns `null` when no server is found (no spawn, no throw),
 * and `getDiagnostics` returns `[]` in every degrade case — server absent, spawn
 * failure, or a timeout waiting for `publishDiagnostics`.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

/** One LSP position (zero-based line/character). */
export interface Position {
  line: number;
  character: number;
}

/** Minimal diagnostic shape — just what a degrade-aware caller needs. */
export interface Diagnostic {
  range: { start: Position; end: Position };
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

/** Per-language server descriptor: the binary name and LSP `languageId`. */
interface ServerSpec {
  bin: string;
  languageId: string;
}

/** The only language wired up so far. Keep this table minimal. */
const SERVERS: Record<string, ServerSpec> = {
  typescript: { bin: 'typescript-language-server', languageId: 'typescript' },
};

/** LSP severity number → our string. Defaults to 'error' for unknown values. */
function severityFromLsp(n: number | undefined): DiagnosticSeverity {
  switch (n) {
    case 2:
      return 'warning';
    case 3:
      return 'information';
    case 4:
      return 'hint';
    default:
      return 'error';
  }
}

/**
 * Resolve the server binary for a language, or `null` when none is installed.
 *
 * Order: env `<LANG>_LSP_BIN` (e.g. `TYPESCRIPT_LSP_BIN`) → `Bun.which(bin)` →
 * ditto-managed `~/.local/share/ditto/lsp/<bin>/<bin>`. Never throws — absence
 * is the expected case (`Bun.which` returns `null`; we never raw-spawn to probe).
 *
 * The env override is authoritative: when it is set it is the operator's explicit
 * choice, so a set-but-missing path resolves to `null` (degrade) rather than
 * falling back to PATH.
 */
export function resolveServer(language: string): string | null {
  const spec = SERVERS[language];
  if (!spec) return null;

  const envBin = process.env[`${language.toUpperCase()}_LSP_BIN`];
  if (envBin !== undefined) return existsSync(envBin) ? envBin : null;

  const onPath = Bun.which(spec.bin);
  if (onPath) return onPath;

  const managed = join(homedir(), '.local', 'share', 'ditto', 'lsp', spec.bin, spec.bin);
  if (existsSync(managed)) return managed;

  return null;
}

export interface GetDiagnosticsOptions {
  /** Language key into the server table (default 'typescript'). */
  language?: string;
  /** Milliseconds to wait for `publishDiagnostics` before degrading. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Build a `Content-Length`-framed LSP message. */
function frame(msg: unknown, enc: TextEncoder): Uint8Array {
  const body = JSON.stringify(msg);
  return enc.encode(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function fileUri(path: string): string {
  return `file://${path}`;
}

/**
 * Open `filePath` against the language server and return its diagnostics.
 *
 * Degrades to `[]` (never throws, never hangs) when the server is absent, when
 * spawning fails, or when `publishDiagnostics` does not arrive within the
 * timeout. The timeout-degrade is part of the ADR-0018 optional-tool contract.
 */
export async function getDiagnostics(
  filePath: string,
  opts: GetDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
  const language = opts.language ?? 'typescript';
  const spec = SERVERS[language];
  if (!spec) return [];

  const binary = resolveServer(language);
  if (!binary) return [];

  let text: string;
  try {
    text = await Bun.file(filePath).text();
  } catch {
    return [];
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, '--stdio'], {
      cwd: dirname(filePath),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return [];
  }

  const enc = new TextEncoder();
  const uri = fileUri(filePath);
  const stdin = proc.stdin as import('bun').FileSink;
  const send = (msg: unknown): void => {
    stdin.write(frame(msg, enc));
    stdin.flush();
  };

  // Drain stderr so the pipe never blocks the server.
  void (async () => {
    try {
      for await (const _ of proc.stderr as ReadableStream<Uint8Array>) {
        // discard
      }
    } catch {
      // process gone — nothing to drain
    }
  })();

  const cleanup = (): void => {
    try {
      send({ jsonrpc: '2.0', id: 999, method: 'shutdown' });
      send({ jsonrpc: '2.0', method: 'exit' });
    } catch {
      // stdin may already be closed
    }
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };

  let buf = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const result = await new Promise<Diagnostic[]>((resolve) => {
    let settled = false;
    const finish = (diags: Diagnostic[]): void => {
      if (settled) return;
      settled = true;
      resolve(diags);
    };

    timer = setTimeout(() => finish([]), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    type LspDiagnosticIn = {
      range: Diagnostic['range'];
      severity?: number;
      message: string;
      source?: string;
    };
    type RpcIncoming = {
      id?: number | string;
      method?: string;
      result?: unknown;
      params?: { items?: unknown[]; uri?: string; diagnostics?: LspDiagnosticIn[] };
    };
    const onMessage = (msg: RpcIncoming): void => {
      // Server → client request (has both id and method): answer minimally so
      // the server proceeds. `workspace/configuration` gates diagnostics.
      if (msg.id !== undefined && msg.method) {
        if (msg.method === 'workspace/configuration') {
          const items = Array.isArray(msg.params?.items) ? msg.params?.items : [];
          send({ jsonrpc: '2.0', id: msg.id, result: items.map(() => ({})) });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: null });
        }
        return;
      }

      if (msg.id === 1 && msg.result) {
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: { uri, languageId: spec.languageId, version: 1, text },
          },
        });
        return;
      }

      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri === uri) {
        const diags: Diagnostic[] = (msg.params?.diagnostics ?? []).map((d: LspDiagnosticIn) => ({
          range: d.range,
          severity: severityFromLsp(d.severity),
          message: d.message,
          ...(d.source ? { source: d.source } : {}),
        }));
        finish(diags);
      }
    };

    // Read stdout via the async iterator (the framing parser handles partial
    // frames across chunks).
    void (async () => {
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buf = Buffer.concat([buf, Buffer.from(chunk)]);
          while (true) {
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const header = buf.subarray(0, headerEnd).toString('utf8');
            const match = header.match(/Content-Length:\s*(\d+)/i);
            const len = match ? Number.parseInt(match[1] as string, 10) : 0;
            const bodyStart = headerEnd + 4;
            if (buf.length < bodyStart + len) break;
            const body = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
            buf = buf.subarray(bodyStart + len);
            try {
              onMessage(JSON.parse(body));
            } catch {
              // skip a malformed frame rather than abort
            }
          }
        }
      } catch {
        // stream closed — fall through to degrade
      }
      finish([]);
    })();

    // Kick off the handshake.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(dirname(filePath)),
        capabilities: {
          textDocument: { publishDiagnostics: {} },
          workspace: { configuration: true },
        },
      },
    });
  });

  if (timer) clearTimeout(timer);
  cleanup();
  return result;
}
