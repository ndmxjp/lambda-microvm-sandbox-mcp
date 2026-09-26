import { GetMicrovmImageCommand, LambdaMicrovmsClient, ListManagedMicrovmImagesCommand } from "@aws-sdk/client-lambda-microvms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { imageArnFor, setupHint, type Config } from "./config.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Read-only health check of everything `sandbox_create` depends on. */
export async function runDoctor(config: Config, log: (msg: string) => void): Promise<boolean> {
  const checks: Check[] = [];
  const sts = new STSClient({ region: config.region });
  let account: string | undefined;
  try {
    const id = await sts.send(new GetCallerIdentityCommand({}));
    account = id.Account;
    checks.push({ name: "credentials", ok: true, detail: `${id.Arn} (account ${account})` });
  } catch (err) {
    checks.push({ name: "credentials", ok: false, detail: `no usable AWS credentials: ${String(err).split("\n")[0]}` });
  }
  const microvms = new LambdaMicrovmsClient({ region: config.region });
  try {
    await microvms.send(new ListManagedMicrovmImagesCommand({}));
    checks.push({ name: "region", ok: true, detail: `Lambda MicroVMs available in ${config.region}` });
  } catch (err) {
    checks.push({ name: "region", ok: false, detail: `Lambda MicroVMs not reachable in ${config.region}: ${String(err).split("\n")[0]}` });
  }
  if (account) {
    const arn = imageArnFor(config, account);
    try {
      const img = await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: arn }));
      const active = img.latestActiveImageVersion;
      checks.push({
        name: "image",
        ok: Boolean(active),
        detail: active ? `${arn} latest ACTIVE version ${active}` : `${arn} exists but has no ACTIVE version (${img.state}); ${setupHint(config)}`,
      });
    } catch (err) {
      const notFound = /NotFound/i.test(String((err as { name?: string }).name ?? err));
      checks.push({ name: "image", ok: false, detail: notFound ? `${arn} not found; ${setupHint(config)}` : `${arn}: ${String(err).split("\n")[0]}` });
    }
  }
  checks.push({
    name: "config",
    ok: true,
    detail: `max duration ${config.maxDurationS}s, idle ${config.idleS}s, suspended ${config.suspendedS}s, internet egress ${config.internetEgress}, state file ${config.stateFile}` +
      (config.transferBucket ? `, transfer bucket ${config.transferBucket}` : ", direct chunked transfers"),
  });
  for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(12)} ${c.detail}`);
  return checks.every((c) => c.ok);
}
