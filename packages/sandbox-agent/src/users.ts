import { readFileSync } from "node:fs";
import type { ExecUser } from "./state.js";

/** Resolve a user from /etc/passwd without native bindings. */
export function lookupUser(name: string, passwdPath = "/etc/passwd"): ExecUser | null {
  let text: string;
  try {
    text = readFileSync(passwdPath, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts[0] !== name) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    const home = parts[5] ?? "/";
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { name, uid, gid, home };
  }
  return null;
}

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
