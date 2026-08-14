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
  assert.match(page, /一键下载 H5/);
  assert.match(layout, /声阅/);
  assert.doesNotMatch(page + layout, /codex-preview|SkeletonPreview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("OpenAPI contract includes ingestion, progress, sharing, TTS and knowledge search", async () => {
  const api = await readFile(new URL("public/openapi.yaml", root), "utf8");
  assert.match(api, /\/v1\/assets\/uploads:/);
  assert.match(api, /\/v1\/jobs\/\{job_id\}\/events:/);
  assert.match(api, /\/v1\/documents\/\{document_id\}\/shares:/);
  assert.match(api, /\/v1\/public\/shares\/\{share_token\}:/);
  assert.match(api, /\/v1\/tts\/sessions:/);
  assert.match(api, /\/v1\/knowledge\/search:/);
});

test("URL imports use the crawl API and dynamic reader data", async () => {
  const [page, worker, crawler] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/crawl.ts", root), "utf8"),
  ]);
  assert.match(page, /fetch\("\/api\/crawl"/);
  assert.match(page, /readerDocument\.sections\.map/);
  assert.match(page, /未生成任何替代内容/);
  assert.match(worker, /handleCrawlRequest/);
  assert.match(crawler, /extractDocumentFromHtml/);
});

test("reader exposes H5 download and a revocable share link", async () => {
  const [page, shareWorker, sharePage] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/share.ts", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
  ]);
  assert.match(page, /一键下载 H5/);
  assert.match(page, /生成分享链接/);
  assert.match(page, /fetch\("\/api\/shares"/);
  assert.match(shareWorker, /handleShareRequest/);
  assert.match(shareWorker, /x-share-revoke-token/);
  assert.match(sharePage, /下载 H5/);
});
