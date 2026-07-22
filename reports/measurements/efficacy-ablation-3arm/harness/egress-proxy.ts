#!/usr/bin/env bun
/**
 * Loopback allowlist egress proxy for the 3-arm ablation sandbox.
 *
 * Listens on 127.0.0.1 only. Handles HTTP CONNECT tunnels (HTTPS) and
 * absolute-form plain-HTTP requests. A hostname passes only when it equals an
 * allowlist entry or is a subdomain of one; everything else gets 403.
 * EVERY decision (allow and deny) is appended as one JSONL line to --log —
 * that log is the evidence base for the "zero positive egress" assertion and
 * for allowlist tuning during the pilot.
 *
 * Under ABLATION_NET_MODE=sandbox-exec the session process can only reach
 * loopback, so this proxy is the single egress door and the allowlist is
 * actually enforced (not merely advisory proxy-env cooperation).
 *
 * Usage: bun egress-proxy.ts --port 18790 --allow api.anthropic.com,claude.ai --log egress.jsonl
 * Prints "READY <port>" on stdout once listening.
 */
import net from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(argVal("--port") ?? "18790");
const allow = (argVal("--allow") ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const logPath = argVal("--log");
if (logPath) mkdirSync(dirname(logPath), { recursive: true });

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((a) => h === a || h.endsWith("." + a));
}

function log(rec: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
  if (logPath) appendFileSync(logPath, line + "\n");
  else console.log(line);
}

const server = net.createServer((client) => {
  client.on("error", () => {});
  client.once("data", (buf) => {
    const head = buf.toString("latin1");
    const m = head.match(/^([A-Z]+) +(\S+)/);
    if (!m) {
      client.destroy();
      return;
    }
    const verb = m[1]!;
    let host = "";
    let targetPort = 80;
    let replay: Buffer | null = null;
    if (verb === "CONNECT") {
      const [h, p] = m[2]!.split(":");
      host = h ?? "";
      targetPort = p ? Number(p) : 443;
    } else {
      try {
        const u = new URL(m[2]!);
        host = u.hostname;
        targetPort = u.port ? Number(u.port) : 80;
        replay = buf;
      } catch {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
    }
    const allowed = hostAllowed(host);
    log({ verb, host, port: targetPort, allowed });
    if (!allowed) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\negress denied by ablation allowlist\n");
      return;
    }
    const upstream = net.connect(targetPort, host, () => {
      if (verb === "CONNECT") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } else if (replay) {
        upstream.write(replay);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY ${port}`);
});
