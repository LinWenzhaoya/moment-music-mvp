// The app is one client-rendered page, so production is a static snapshot: build, render "/" once with
// `vinext start`, and copy the client assets next to it. Output: dist/static (served by Caddy).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
if (spawnSync("npx", ["vinext", "build"], { stdio: "inherit", env }).status !== 0) process.exit(1);
const port = 3099;
const server = spawn("npx", ["vinext", "start", "--port", String(port)], { env, stdio: "ignore", detached: true });
try {
  let html = "";
  for (let attempt = 0; attempt < 60 && !html; attempt += 1) {
    await sleep(500);
    try { const response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) html = await response.text(); } catch { /* not up yet */ }
  }
  if (!html.includes("/_next/static/")) throw new Error("rendered page is missing its assets");
  rmSync("dist/static", { recursive: true, force: true });
  mkdirSync("dist/static", { recursive: true });
  cpSync("dist/client", "dist/static", { recursive: true, filter: (path) => !/[/\\](\.vite|_headers|\.assetsignore|vinext-client-entry-manifest\.json)$/.test(path) });
  writeFileSync("dist/static/index.html", html);
  console.log(`dist/static ready (${html.length} bytes of HTML)`);
} finally {
  process.kill(-server.pid);
}
