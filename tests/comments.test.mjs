import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MUSIC_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "moment-comments-")), "test.sqlite");
const { db } = await import("../local-music/db.mjs");
const { addComment, commentsForTrack, journal, validateComment } = await import("../local-music/comments.mjs");

const insertTrack = db.prepare(`INSERT INTO tracks (relative_path, title, artist, folder, file_size, modified_at) VALUES (?, ?, ?, '下载', 1, 1)`);
const a = Number(insertTrack.run("a.mp3", "After Hours", "The Weeknd").lastInsertRowid);
const copy = Number(insertTrack.run("b/a.mp3", "After Hours", "The Weeknd").lastInsertRowid);

test("validateComment rejects empty text and clamps the rest", () => {
  assert.equal(validateComment({ body: "   " }).error, "写点什么再保存");
  const { value } = validateComment({ body: " 很酷 ", positionSeconds: 192.4, mood: "有掌控感" });
  assert.deepEqual([value.body, value.positionSeconds, value.mood], ["很酷", 192, "有掌控感"]);
});

test("comments belong to the song, so every copy sees them, newest first", () => {
  assert.equal(addComment(a, { body: "第一次" }).status, 201);
  assert.equal(addComment(copy, { body: "第二次", mood: "平静" }).status, 201);
  assert.deepEqual(commentsForTrack(a).map((item) => item.body).sort(), ["第一次", "第二次"]);
  assert.equal(journal(10).length, 2);
  assert.equal(addComment(99999, { body: "x" }).status, 404);
});
