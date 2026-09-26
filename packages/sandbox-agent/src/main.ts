import { startAgent, optionsFromEnv } from "./index.js";

const agent = await startAgent(optionsFromEnv());

const shutdown = (sig: string): void => {
  console.error(`[sandbox-agent] ${sig}, shutting down`);
  void agent.close().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
