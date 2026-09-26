/**
 * `sudo` replacement installed in the image as /usr/bin/sudo.
 *
 * Real sudo cannot work here: the MicroVM container runs with no_new_privileges,
 * so setuid binaries never gain root. This shim forwards the command to the
 * root sandbox-agent over a unix socket that only root and the sandbox group can
 * open. Supports the non-interactive subset agents actually use:
 *   sudo [-n] [-E] [-H] [-S] [-u root] [--] command [args...]
 *   sudo -i | sudo -s          (root bash, reading the script from stdin)
 */
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import type { RootRelayRequest, RootRelayResponse } from "./protocol.js";

const SOCKET = process.env.SANDBOX_ROOT_SOCKET ?? "/run/sandbox-agent/root.sock";

function usage(msg: string): never {
  process.stderr.write(`sudo: ${msg}\n`);
  process.exit(1);
}

function parse(argv: string[]): { argv: string[]; keepEnv: boolean } {
  let keepEnv = false;
  let shell = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-")) break;
    if (a === "-E" || a === "--preserve-env") keepEnv = true;
    else if (a === "-n" || a === "--non-interactive" || a === "-H" || a === "-S" || a === "-k" || a === "-b") continue;
    else if (a === "-i" || a === "-s") shell = true;
    else if (a === "-u" || a === "--user") {
      const u = argv[++i];
      if (u !== "root" && u !== "0" && u !== "#0") usage(`only -u root is supported in this sandbox (got ${u ?? ""})`);
    } else if (a.startsWith("-u")) {
      if (a.slice(2) !== "root") usage("only -u root is supported in this sandbox");
    } else if (a === "-v" || a === "-l" || a === "--version") {
      process.stdout.write("sandbox sudo shim (root relay); all commands allowed\n");
      process.exit(0);
    } else usage(`unsupported option ${a}`);
  }
  const rest = argv.slice(i);
  if (rest.length === 0) {
    if (shell) return { argv: ["bash"], keepEnv };
    usage("a command is required (interactive sudo is not available)");
  }
  return { argv: shell ? ["bash", "-c", rest.join(" ")] : rest, keepEnv };
}

const { argv, keepEnv } = parse(process.argv.slice(2));
const env: Record<string, string> = keepEnv
  ? (Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>)
  : {};
env.HOME = "/root";
env.USER = "root";
env.LOGNAME = "root";
env.SUDO_USER = process.env.USER ?? "sandbox";
if (process.env.TERM) env.TERM = process.env.TERM;

let stdin: string | undefined;
if (!process.stdin.isTTY) {
  try {
    stdin = readFileSync(0).toString("base64");
  } catch {
    stdin = undefined;
  }
}
const req: RootRelayRequest = { argv, cwd: process.cwd(), env, timeout_s: 3600, ...(stdin !== undefined ? { stdin } : {}) };

const sock = connect(SOCKET);
const chunks: Buffer[] = [];
sock.on("error", (err) => usage(`cannot reach the sandbox agent at ${SOCKET}: ${err.message}`));
sock.on("data", (c: Buffer) => chunks.push(c));
sock.on("end", () => {
  const res = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RootRelayResponse;
  if ("error" in res) usage(`${res.error}: ${res.message}`);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.truncated) process.stderr.write("sudo: output truncated at 1 MiB\n");
  if (res.timed_out) process.stderr.write("sudo: command timed out\n");
  process.exitCode = res.exit_code ?? (res.signal ? 128 : 1);
});
sock.end(JSON.stringify(req));
