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
  assert.match(api, /\/v1\/tts\/synthesize:/);
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

test("reader exposes H5 download, default MeloTTS playback and a revocable share link", async () => {
  const [page, shareWorker, sharePage, ttsWorker, meloTts] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/share.ts", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
    readFile(new URL("worker/tts.ts", root), "utf8"),
    readFile(new URL("services/melotts/server.py", root), "utf8"),
  ]);
  assert.match(page, /一键下载 H5/);
  assert.match(page, /生成分享链接/);
  assert.match(page, /useState<"browser" \| "melotts">\("melotts"\)/);
  assert.match(page, /MeloTTS · 中文自然女声/);
  assert.match(page, /\/v1\/documents\/\$\{readerDocument\.documentId\}\/shares/);
  assert.match(shareWorker, /handleShareRequest/);
  assert.match(shareWorker, /tokenHash/);
  assert.match(shareWorker, /status = 'revoked'/);
  assert.match(shareWorker, /SHARE_DOWNLOAD_FORBIDDEN/);
  assert.match(sharePage, /下载 H5/);
  assert.match(sharePage, /\/v1\/public\/shares\//);
  assert.match(page, /speakFromOffset/);
  assert.match(page, /系统默认语音/);
  assert.match(sharePage, /shared-default-voice/);
  assert.doesNotMatch(page, /const changeVoice/);
  assert.doesNotMatch(sharePage, /const changeVoice/);
  assert.match(page, /privateTtsVoices/);
  assert.match(page, /MeloTTS/);
  assert.match(ttsWorker, /CUSTOMER_HTTP_TTS/);
  assert.match(ttsWorker, /\/v1\/synthesize/);
  assert.match(meloTts, /tts_to_file/);
  assert.match(meloTts, /spk2id/);
  assert.match(meloTts, /MeloTTS-Chinese/);
});

test("all in-app destinations retain the phone interface", async () => {
  const [page, styles, sharePage] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
  ]);
  assert.match(page, /const renderMobileReader/);
  assert.match(page, /const renderMobileLibrary/);
  assert.match(page, /const renderMobileHistory/);
  assert.match(page, /const renderMobileProcessing/);
  assert.match(page, /mobile-route-view/);
  assert.match(page, /mobile-url-next/);
  assert.match(page, /下一步，开始收听/);
  assert.match(styles, /\.desktop-route-view \{ display: none; \}/);
  assert.match(styles, /\.mobile-reader-dock/);
  assert.match(styles, /Public links use the same phone reader/);
  assert.match(sharePage, /shared-reader-player/);
});

test("clipboard imports distinguish web links from text and home only shows saved materials", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(page, /const pasteFromClipboard/);
  assert.match(page, /isWebAddress\(content\)/);
  assert.match(page, /new File\(\[content\], "剪贴板内容\.txt"/);
  assert.match(page, /mobile-clipboard-zone/);
  assert.match(page, /正在同步你的真实资料/);
  assert.match(page, /完成一次文件、网页或剪贴板导入后/);
  assert.doesNotMatch(page, /为什么伟大不能被计划/);
  assert.doesNotMatch(page, /Q2 团队复盘纪要/);
  assert.doesNotMatch(page, /消费电子趋势报告/);
  assert.match(styles, /\.mobile-clipboard-zone/);
  assert.match(styles, /\.mobile-material-empty/);
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

test("file processing never presents itself as a web crawl and history is a real tab", async () => {
  const [page, documents, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/documents.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(page, /const isUrlImport = sourceType === "url"/);
  assert.match(page, /文档解析/);
  assert.match(page, /const openHistory/);
  assert.match(page, /view === "history"/);
  assert.match(documents, /invokeDocumentProcessor/);
  assert.match(packageJson, /dev:processor/);
});

test("TXT titles, phone accounts, server-side ownership and back navigation are covered", async () => {
  const [page, documents, auth, api, schema, sharePage] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/documents.ts", root), "utf8"),
    readFile(new URL("worker/auth.ts", root), "utf8"),
    readFile(new URL("public/openapi.yaml", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
  ]);
  assert.match(page, /"TXT"/);
  assert.match(page, /手机号/);
  assert.match(page, /const \[viewHistory, setViewHistory\]/);
  assert.match(page, /const goBack/);
  assert.match(page, /返回上一页/);
  assert.match(page, /注册并进入私有空间/);
  assert.match(page, /退出登录/);
  assert.match(page, /上传、网页抓取、知识库、下载和分享都仅在身份验证后可用/);
  assert.match(page, /if \(!currentUser\)/);
  assert.match(documents, /ACCEPTED_EXTENSIONS = new Set\(\["docx", "md", "txt"/);
  assert.match(documents, /getAuthenticatedActor/);
  assert.match(documents, /local_sessions/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /PBKDF2/);
  assert.match(auth, /normalizePhone/);
  assert.match(auth, /WHERE phone = \?/);
  assert.match(auth, /PHONE_ALREADY_REGISTERED/);
  assert.match(auth, /local-bind-phone/);
  assert.match(auth, /local-register/);
  assert.match(auth, /local-signin/);
  assert.match(api, /\/v1\/auth\/me:/);
  assert.match(api, /\/v1\/auth\/local-register:/);
  assert.match(api, /\/v1\/auth\/local-bind-phone:/);
  assert.match(api, /phone:/);
  assert.match(schema, /idx_local_users_phone/);
  assert.match(sharePage, /shared-back-button/);
  assert.match(api, /TXT/);
});
