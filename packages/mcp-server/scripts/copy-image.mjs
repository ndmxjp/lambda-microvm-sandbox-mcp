// Copy the built sandbox-agent image assets into this package so `setup` can ship them.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "sandbox-agent", "dist", "image");
const dst = join(here, "..", "image");
mkdirSync(dst, { recursive: true });
for (const f of ["Dockerfile", "agent.mjs", "sudo.mjs"]) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error(`${from} missing: build packages/sandbox-agent first`);
  copyFileSync(from, join(dst, f));
}
console.log(`image assets copied to ${dst}`);
