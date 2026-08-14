import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("product UI replaces all starter preview markers", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /把任何资料/);
  assert.match(page, /我的知识库/);
  assert.match(page, /导出 H5/);
  assert.match(layout, /声阅/);
  assert.doesNotMatch(page + layout, /codex-preview|SkeletonPreview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("OpenAPI contract includes ingestion, progress, TTS and knowledge search", async () => {
  const api = await readFile(new URL("public/openapi.yaml", root), "utf8");
  assert.match(api, /\/v1\/assets\/uploads:/);
  assert.match(api, /\/v1\/jobs\/\{job_id\}\/events:/);
  assert.match(api, /\/v1\/tts\/sessions:/);
  assert.match(api, /\/v1\/knowledge\/search:/);
});
