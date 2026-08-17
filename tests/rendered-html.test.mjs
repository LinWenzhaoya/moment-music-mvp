import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Moment product surface replaces the starter preview", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/MomentApp.tsx", import.meta.url), "utf8");
  assert.match(page, /MomentApp/);
  assert.match(app, /生成此刻歌单/);
  assert.match(app, /遗忘旧爱/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});
