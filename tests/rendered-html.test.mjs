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

test("URL imports use the persistent document API and dynamic reader data", async () => {
  const [page, worker, crawler, documents] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/crawl.ts", root), "utf8"),
    readFile(new URL("worker/documents.ts", root), "utf8"),
  ]);
  assert.match(page, /fetch\("\/v1\/documents:import-url"/);
  assert.match(page, /fetch\("\/v1\/documents:upload"/);
  assert.match(page, /readerDocument\.sections\.map/);
  assert.match(page, /未生成任何替代内容/);
  assert.match(worker, /handleCrawlRequest/);
  assert.match(crawler, /extractDocumentFromHtml/);
  assert.match(documents, /env\.DOCUMENTS\.put/);
  assert.match(documents, /document_chunks/);
});

test("reader exposes H5 download and a revocable share link", async () => {
  const [page, shareWorker, sharePage] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/share.ts", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
  ]);
  assert.match(page, /一键下载 H5/);
  assert.match(page, /生成分享链接/);
  assert.match(page, /\/v1\/documents\/\$\{readerDocument\.documentId\}\/shares/);
  assert.match(shareWorker, /handleShareRequest/);
  assert.match(shareWorker, /tokenHash/);
  assert.match(shareWorker, /status = 'revoked'/);
  assert.match(shareWorker, /SHARE_DOWNLOAD_FORBIDDEN/);
  assert.match(sharePage, /下载 H5/);
  assert.match(sharePage, /\/v1\/public\/shares\//);
});

test("backend includes durable document parsing and private knowledge boundaries", async () => {
  const [schema, processor, share] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("services/document_processor/main.py", root), "utf8"),
    readFile(new URL("worker/share.ts", root), "utf8"),
  ]);
  assert.match(schema, /documentShares/);
  assert.match(schema, /documentChunks/);
  assert.match(processor, /parse_docx/);
  assert.match(processor, /parse_pdf/);
  assert.match(processor, /parse_xlsx/);
  assert.match(share, /tokenHash/);
  assert.match(share, /owner_user_id/);
});
