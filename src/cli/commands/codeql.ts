import { join } from 'node:path';
import { defineCommand } from 'citty';
import { AcgReviewStore } from '~/core/acg-review-store';
import { defaultDoctorDeps } from '~/core/codeql/doctor';
import { type CodeqlLedgerDeps, runCodeqlReviewToLedger } from '~/core/codeql/review-to-ledger';
import { type CodeqlLanguage, cacheKey } from '~/core/codeql/runner';
import { localDir } from '~/core/ditto-paths';
import { EvidenceStore, sha256Hex } from '~/core/evidence-store';
import {
  atomicWriteText,
  ensureDir,
  resolveRepoRootForCreate,
  writeJson as writeJsonFile,
} from '~/core/fs';
import type { HostRunProcess } from '~/core/hosts/types';
import { generateId } from '~/core/id';
import { reviewerOutput } from '~/schemas/reviewer-output';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/** Read a stream to the end (drain) so a piped child cannot block on a full pipe. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Build the process env: inherit, apply `set`, then remove `unset` keys. */
function composeEnv(base: NodeJS.ProcessEnv, set: Record<string, string>, unset: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(set)) env[k] = v;
  for (const k of unset) delete env[k];
  return env;
}

/** Real (Bun-backed) deps for the CodeQL → ledger pipeline. */
function defaultLedgerDeps(repoRoot: string): CodeqlLedgerDeps {
  const evidence = new EvidenceStore(repoRoot);
  const ledgerStore = new AcgReviewStore(repoRoot);
  return {
    spawn: ({ binary, args, repoRoot: root, cwd, env }): HostRunProcess => {
      const proc = Bun.spawn([binary, ...args], {
        cwd: cwd === '.' ? root : cwd,
        env: composeEnv(process.env, env.set, env.unset),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      return {
        entrypoint: binary,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        completion: proc.exited.then((code) => ({ exit_code: code, model_reported: null })),
      };
    },
    readText: (path) => Bun.file(path).text(),
    fileExists: (path) => Bun.file(path).exists(),
    drain: drainStream,
    appendRecord: (workItemId, record) => evidence.appendRecord(workItemId, record),
    sha256: sha256Hex,
    now: () => new Date().toISOString(),
    collectExtensions: defaultDoctorDeps.collectExtensions,
    cliAvailable: defaultDoctorDeps.cliAvailable,
    genReviewId: () => generateId('rv', async () => false),
    persistReviewerOutput: async (workItemId, output) => {
      const path = localDir(repoRoot, 'work-items', workItemId, 'reviewer-output.json');
      await ensureDir(localDir(repoRoot, 'work-items', workItemId));
      await writeJsonFile(path, reviewerOutput, output);
    },
    persistLedger: async (workItemId, graph) => {
      await ledgerStore.write(workItemId, graph);
    },
    persistDataflowDoDs: async (workItemId, dods) => {
      const path = localDir(repoRoot, 'work-items', workItemId, 'dataflow-dod.json');
      await ensureDir(localDir(repoRoot, 'work-items', workItemId));
      // Spec artifact (not a gated schema): write the propositions as plain JSON.
      await atomicWriteText(
        path,
        `${JSON.stringify({ schema_version: '0.1.0', dods }, null, 2)}\n`,
      );
    },
  };
}

/** Default security suite spec for a language (overridable with --suite). */
function defaultSuite(language: CodeqlLanguage): string {
  return `codeql/${language}-queries:codeql-suites/${language}-security-extended.qls`;
}

async function gitHeadSha(repoRoot: string): Promise<string> {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot });
    const sha = proc.stdout?.toString().trim();
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch {
    // not a repo / git unavailable → fall through
  }
  return 'workingdir000';
}

const reviewSubcommand = defineCommand({
  meta: {
    name: 'review',
    description:
      'Run CodeQL (doctor-gated) and project findings into the acg-review.json risk ledger the Stop gate reads',
  },
  args: {
    'work-item': {
      type: 'string',
      description: 'Work item id to write the ledger under',
      required: true,
    },
    'source-root': { type: 'string', description: 'Analysis source root (default: <repo>/src)' },
    language: { type: 'string', description: 'CodeQL language (default: javascript)' },
    suite: { type: 'string', description: 'Query suite spec (default: <lang>-security-extended)' },
    'build-command': {
      type: 'string',
      description: 'Build command for manual build-mode (compiled langs)',
    },
    'build-verified': {
      type: 'boolean',
      default: false,
      description: 'Assert a clean build was reproduced (unblocks compiled languages)',
    },
    binary: { type: 'string', description: "CodeQL binary (default 'codeql' on PATH)" },
    download: { type: 'boolean', default: true, description: 'Auto-download query packs' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const language = (args.language ?? 'javascript') as CodeqlLanguage;
      const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
      const commitSha = await gitHeadSha(repoRoot);
      const key = cacheKey(commitSha, language);
      const dbPath = localDir(repoRoot, 'cache', 'codeql', key, 'db');
      const sarifPath = localDir(
        repoRoot,
        'work-items',
        args['work-item'],
        'evidence',
        `codeql-${key}.sarif`,
      );
      // `codeql database create` makes the db leaf but NOT its parent chain, and
      // `analyze --output` will not create the sarif's parent either. Ensure both
      // exist before the spawn or create fails with "<dir> does not exist".
      await ensureDir(localDir(repoRoot, 'cache', 'codeql', key));
      await ensureDir(localDir(repoRoot, 'work-items', args['work-item'], 'evidence'));
      const res = await runCodeqlReviewToLedger(
        {
          workItemId: args['work-item'],
          repoRoot,
          sourceRoot,
          language,
          commitSha,
          dbPath,
          sarifPath,
          suite: args.suite ?? defaultSuite(language),
          buildCommand: args['build-command'],
          buildVerified: args['build-verified'],
          binary: args.binary,
          download: args.download,
        },
        defaultLedgerDeps(repoRoot),
      );

      if (format === 'json') {
        writeJson(res);
      } else if (res.gated) {
        writeHuman(
          `codeql review GATED — doctor先行 blocked, no analysis/ledger. Fix first:\n${res.doctor.findings
            .map((f) => `  ${f.severity}\t${f.kind}\t${f.message}`)
            .join('\n')}`,
        );
      } else {
        const dodLines = res.dataflowDoDs
          .map((d) => `  DoD ${d.rule_id}: GIVEN ${d.given} WHEN ${d.when} THEN ${d.then}`)
          .join('\n');
        writeHuman(
          `codeql review: ${res.findings} finding(s), verdict=${res.verdict}, ${res.highRiskWithoutEvidence} high-risk without evidence → acg-review.json ${res.ledgerWritten ? 'written' : 'not written'}${
            res.dataflowDoDs.length > 0
              ? `\n${res.dataflowDoDs.length} dataflow DoD(s) → dataflow-dod.json\n${dodLines}`
              : ''
          }`,
        );
      }
      // Doctor-gated is a precondition failure (exit non-zero); a written ledger is
      // success regardless of whether it blocks (blocking is the gate's job later).
      if (res.gated) process.exit(USAGE_ERROR_EXIT);
    } catch (err) {
      writeError(`codeql review failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const codeqlCommand = defineCommand({
  meta: {
    name: 'codeql',
    description: 'CodeQL deterministic provider — analyze and feed the ACG gate',
  },
  subCommands: { review: reviewSubcommand },
});
