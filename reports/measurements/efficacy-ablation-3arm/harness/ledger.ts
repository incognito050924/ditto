#!/usr/bin/env bun
/**
 * Append-only attempt ledger for the 3-arm ablation (JSONL, O_APPEND,
 * single-writer — same durability model the repo already relies on for
 * autopilot decision logs).
 *
 * Every trial — valid or invalid — is preserved: discard-and-rerun cannot
 * manufacture favorable results because ids are monotonic, the total-attempt
 * cap counts ALL session events, and each line carries the sha256 of the
 * previous raw line (tamper-evident chain; "genesis" for the first line).
 * Adjudication (valid/invalid + reason) is a separate appended event that
 * references an existing attempt — session lines are never rewritten.
 *
 * Subcommands:
 *   next-id                              print the next monotonic attempt id;
 *                                        exit 3 when the cap is reached
 *   check-append --attempt N             dry-run the append guards (cap,
 *                                        monotonicity) without writing
 *   append --event session --attempt N --arm B0|B1|A --status completed|truncated
 *          [--artifacts <path>] [--digest <sha256>]
 *   append --event adjudication --attempt N --status valid|invalid [--reason <text>]
 *   verify                               recompute the chain + invariants
 *   show                                 human-readable dump
 *
 * File: --file <path> or $ABLATION_LEDGER_FILE. Cap: --max or
 * $ABLATION_MAX_ATTEMPTS (default 15).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

type Entry = {
  ts: string;
  event: "session" | "adjudication";
  attempt: number;
  arm?: string;
  status?: string;
  reason?: string;
  artifacts?: string;
  digest?: string;
  prev_sha256: string;
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = argVal("--file") ?? process.env.ABLATION_LEDGER_FILE;
const max = Number(argVal("--max") ?? process.env.ABLATION_MAX_ATTEMPTS ?? "15");
const cmd = process.argv[2];

if (!file) {
  console.error("error: no ledger file (--file or ABLATION_LEDGER_FILE)");
  process.exit(2);
}

function rawLines(): string[] {
  if (!existsSync(file!)) return [];
  return readFileSync(file!, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function parsed(lines: string[]): Entry[] {
  return lines.map((l) => JSON.parse(l) as Entry);
}

function sessionEvents(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.event === "session");
}

function maxAttempt(entries: Entry[]): number {
  return sessionEvents(entries).reduce((m, e) => Math.max(m, e.attempt), 0);
}

/** Cap + monotonicity guards for a new session event. Returns error or null. */
function sessionGuards(entries: Entry[], attempt: number): string | null {
  const sessions = sessionEvents(entries);
  if (sessions.length >= max) {
    return `attempt cap reached (${sessions.length}/${max}) — no new attempt ids`;
  }
  if (attempt <= maxAttempt(entries)) {
    return `attempt id ${attempt} is not monotonic (last issued: ${maxAttempt(entries)})`;
  }
  return null;
}

switch (cmd) {
  case "next-id": {
    const entries = parsed(rawLines());
    if (sessionEvents(entries).length >= max) {
      console.error(`attempt cap reached (${sessionEvents(entries).length}/${max}) — refusing to issue a new id`);
      process.exit(3);
    }
    console.log(String(maxAttempt(entries) + 1));
    break;
  }
  case "check-append": {
    const attempt = Number(argVal("--attempt"));
    if (!Number.isInteger(attempt) || attempt < 1) {
      console.error("error: --attempt must be a positive integer");
      process.exit(2);
    }
    const err = sessionGuards(parsed(rawLines()), attempt);
    if (err) {
      console.error(err);
      process.exit(3);
    }
    console.log("ok");
    break;
  }
  case "append": {
    const event = argVal("--event");
    const attempt = Number(argVal("--attempt"));
    if ((event !== "session" && event !== "adjudication") || !Number.isInteger(attempt) || attempt < 1) {
      console.error("error: append needs --event session|adjudication and a positive --attempt");
      process.exit(2);
    }
    const lines = rawLines();
    const entries = parsed(lines);
    const entry: Entry = {
      ts: new Date().toISOString(),
      event,
      attempt,
      prev_sha256: lines.length ? sha256(lines[lines.length - 1]!) : "genesis",
    };
    if (event === "session") {
      const arm = argVal("--arm");
      const status = argVal("--status");
      if (!arm || !["B0", "B1", "A"].includes(arm) || !status || !["completed", "truncated"].includes(status)) {
        console.error("error: session append needs --arm B0|B1|A and --status completed|truncated");
        process.exit(2);
      }
      const err = sessionGuards(entries, attempt);
      if (err) {
        console.error(err);
        process.exit(3);
      }
      entry.arm = arm;
      entry.status = status;
      const artifacts = argVal("--artifacts");
      const digest = argVal("--digest");
      if (artifacts) entry.artifacts = artifacts;
      if (digest) entry.digest = digest;
    } else {
      const status = argVal("--status");
      const reason = argVal("--reason");
      if (!status || !["valid", "invalid"].includes(status)) {
        console.error("error: adjudication append needs --status valid|invalid");
        process.exit(2);
      }
      if (!sessionEvents(entries).some((e) => e.attempt === attempt)) {
        console.error(`error: adjudication references unknown attempt ${attempt}`);
        process.exit(2);
      }
      if (status === "invalid" && !reason) {
        console.error("error: an invalid adjudication requires --reason");
        process.exit(2);
      }
      entry.status = status;
      if (reason) entry.reason = reason;
    }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n", { flag: "a" });
    console.log(`appended ${event} attempt=${attempt}`);
    break;
  }
  case "verify": {
    const lines = rawLines();
    const errors: string[] = [];
    let prev = "genesis";
    let lastSession = 0;
    const sessionAttempts = new Set<number>();
    lines.forEach((raw, i) => {
      let e: Entry;
      try {
        e = JSON.parse(raw) as Entry;
      } catch {
        errors.push(`line ${i + 1}: not valid JSON`);
        return;
      }
      if (e.prev_sha256 !== prev) {
        errors.push(`line ${i + 1}: chain broken (expected prev_sha256=${prev}, got ${e.prev_sha256})`);
      }
      prev = sha256(raw);
      if (e.event === "session") {
        if (e.attempt <= lastSession) {
          errors.push(`line ${i + 1}: session attempt ${e.attempt} not monotonic (last ${lastSession})`);
        }
        lastSession = Math.max(lastSession, e.attempt);
        sessionAttempts.add(e.attempt);
      } else if (e.event === "adjudication") {
        if (!sessionAttempts.has(e.attempt)) {
          errors.push(`line ${i + 1}: adjudication for unknown attempt ${e.attempt}`);
        }
        if (e.status === "invalid" && !e.reason) {
          errors.push(`line ${i + 1}: invalid adjudication without reason`);
        }
      } else {
        errors.push(`line ${i + 1}: unknown event '${(e as { event: string }).event}'`);
      }
    });
    if (sessionAttempts.size > max) {
      errors.push(`session count ${sessionAttempts.size} exceeds cap ${max}`);
    }
    if (errors.length) {
      for (const err of errors) console.error(err);
      process.exit(1);
    }
    console.log(`ok — ${lines.length} entries, ${sessionAttempts.size}/${max} attempts, chain intact`);
    break;
  }
  case "show": {
    for (const e of parsed(rawLines())) {
      console.log(
        `${e.ts} ${e.event.padEnd(12)} attempt=${e.attempt} ${e.arm ?? ""} ${e.status ?? ""} ${e.reason ?? ""}`.trim(),
      );
    }
    break;
  }
  default:
    console.error("usage: ledger.ts next-id|check-append|append|verify|show [flags]");
    process.exit(2);
}
