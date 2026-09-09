#!/usr/bin/env node
// pt-api — start the PACT.TAILOR intelligence API.
//   pt-api [--port <n>] [--data <dir>] [--var <dir>] [--replay]
// Port default 4200 (env PT_API_PORT overrides); data/var default to the
// workspace's intelligence/data and intelligence/var directories.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { startServer } from "./server.js";

interface CliArgs {
  port: number;
  dataDir: string;
  varDir: string;
  replay: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/api/dist
  const workspaceRoot = path.resolve(here, "../../.."); // intelligence/
  const args: CliArgs = {
    port: Number.parseInt(process.env["PT_API_PORT"] ?? "4200", 10),
    dataDir: path.join(workspaceRoot, "data"),
    varDir: path.join(workspaceRoot, "var"),
    replay: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") args.port = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--data") args.dataDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--var") args.varDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--replay") args.replay = true;
    else {
      console.error(`pt-api: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.port) || args.port < 0) {
    console.error(`pt-api: invalid port ${args.port}`);
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const app = buildApp({ dataDir: args.dataDir, varDir: args.varDir, replay: args.replay });
const server = startServer(app, args.port);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
