#!/usr/bin/env -S npx tsx
/**
 * End-to-end smoke test against a real MicroVM. Starts one VM from
 * SANDBOX_IMAGE_ARN, exercises exec / files / suspend / resume, records the
 * timings, and ALWAYS terminates the VM at the end. Billable: refuses to run
 * without --yes.
 *
 *   npm run smoke-test -- --yes --region ap-northeast-1
 */
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { RealMicrovmApi } from "../packages/mcp-server/src/aws.ts";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { Registry } from "../packages/mcp-server/src/registry.ts";
import { SandboxService } from "../packages/mcp-server/src/service.ts";

const argv = process.argv.slice(2);
if (!argv.includes("--yes")) {
  console.error("smoke-test starts a billable MicroVM; pass --yes to proceed");
  process.exit(2);
}
const config = loadConfig(argv.filter((a) => a !== "--yes"));
const api = new RealMicrovmApi(config.region);
const sts = new STSClient({ region: config.region });
const service = new SandboxService({
  config,
  api,
  accountId: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account as string,
  registry: new Registry(null),
});
const timings: Record<string, number> = {};
const t = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const s = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = Date.now() - s;
    console.log(`  ${name}: ${timings[name]} ms`);
  }
};

let id: string | undefined;
try {
  const created = await t("create (RunMicrovm + ready)", () => service.create({ name: "smoke", max_duration_s: 900 }));
  id = created.sandbox_id;
  console.log(`sandbox ${id} at ${created.endpoint}`);

  const who = await t("exec whoami", () =>
    service.exec(id as string, { command: "whoami; id; pwd; node --version; python3 --version; git --version" }),
  );
  console.log(who.stdout.trim());
  if (who.exit_code !== 0) throw new Error(`toolchain check failed: ${who.stderr}`);

  const root = await t("exec sudo (shim over root relay)", () =>
    service.exec(id as string, { command: "sudo -n whoami && echo hi | sudo tee /root/from-sudo >/dev/null && sudo cat /root/from-sudo" }),
  );
  if (root.stdout.trim() !== "root\nhi") throw new Error(`sudo failed (${root.exit_code}): ${root.stdout} ${root.stderr}`);
  const asRoot = await t("exec as_root", () => service.exec(id as string, { command: "whoami", as_root: true }));
  if (asRoot.stdout.trim() !== "root") throw new Error(`as_root failed: ${asRoot.stderr}`);
  const pkg = await t("exec sudo dnf install (bc)", () =>
    service.exec(id as string, {
      // dnf in the al2023-minimal image is microdnf: no -q flag.
      command: "sudo dnf install -y bc >/dev/null && echo '2+3' | bc",
      timeout_s: 300,
    }),
  );
  console.log(`  dnf result: ${pkg.stdout.trim()} (exit ${pkg.exit_code}) ${pkg.stderr.trim().slice(0, 200)}`);

  await t("write file", () => service.writeFile(id as string, { path: "hello.txt", content: "hello from smoke test\n" }));
  const read = await t("read file", () => service.readFile(id as string, { path: "hello.txt" }));
  if (read.content !== "hello from smoke test\n") throw new Error("file roundtrip mismatch");
  const owner = await service.exec(id as string, { command: "stat -c %U hello.txt" });
  console.log(`  file owner: ${owner.stdout.trim()}`);

  await t("suspend", () => service.suspend(id as string));
  await new Promise((r) => setTimeout(r, 3000));
  const afterResume = await t("exec after suspend (auto-resume)", () => service.exec(id as string, { command: "cat hello.txt" }));
  if (afterResume.stdout !== "hello from smoke test\n") throw new Error("state lost across suspend");

  const status = await t("status", () => service.status(id as string));
  console.log(`  state: ${status.state}`);
  console.log("\nSMOKE TEST PASSED");
  console.log(JSON.stringify(timings, null, 2));
} finally {
  if (id) {
    await t("destroy", () => service.destroy(id as string));
  }
}
