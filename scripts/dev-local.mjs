import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["local-music/server.mjs"], { stdio: "inherit", env: process.env }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", env: process.env }),
];

function shutdown(signal = "SIGTERM") {
  for (const child of children) if (!child.killed) child.kill(signal);
}

process.on("SIGINT", () => { shutdown("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); process.exit(0); });
process.on("exit", () => shutdown());
for (const child of children) child.on("exit", (code) => { if (code && code !== 0) process.exitCode = code; });
