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
  assert.doesNotMatch(page, /!result\.reader\.description \|\| !Array\.isArray\(result\.reader\.sections\)/);
  assert.match(page, /未生成任何替代内容/);
  assert.match(worker, /handleCrawlRequest/);
  assert.match(crawler, /extractDocumentFromHtml/);
  assert.match(documents, /env\.DOCUMENTS\.put/);
  assert.match(documents, /document_chunks/);
});

test("Crawl4AI keeps policy bodies complete and separates visible source facts from narration", async () => {
  const [crawler, crawlWorker, page, sharePage, reader] = await Promise.all([
    readFile(new URL("services/crawler/main.py", root), "utf8"),
    readFile(new URL("worker/crawl.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
    readFile(new URL("worker/reader.ts", root), "utf8"),
  ]);
  assert.match(crawler, /content_selector = content_selector_for\(target\)/);
  assert.match(crawler, /crawler_run_config\(content_selector\)/);
  assert.match(crawler, /#mainText \.view/);
  assert.match(crawler, /word_count_threshold=1/);
  assert.match(crawler, /beijing_policy_body_html/);
  assert.match(crawler, /beijing_policy_markdown = html_body_to_markdown/);
  assert.match(crawler, /is_page_chrome/);
  assert.match(crawler, /is_redundant_description/);
  assert.match(crawler, /html_body_to_markdown\(metadata_html, source_url\)/);
  assert.match(crawler, /getattr\(markdown_result, "raw_markdown"/);
  assert.match(crawler, /extract_display_metadata/);
  assert.match(crawler, /displayMetadata=display_metadata/);
  assert.match(crawler, /is_section_heading/);
  assert.match(crawlWorker, /LOCAL_CRAWLER_URL/);
  assert.match(crawlWorker, /npm run dev:crawler/);
  assert.match(crawlWorker, /extractBeijingPolicyBody/);
  assert.match(crawlWorker, /return view \|\| mainText/);
  assert.match(crawlWorker, /PDF\\s\*格式下载/);
  assert.match(crawlWorker, /elementContents/);
  assert.match(crawlWorker, /scopedPolicyBody \? \{ title: "网页正文", paragraphs: \[\] \} : null/);
  assert.match(crawlWorker, /<strong\\b/);
  assert.match(page, /<SourceMetadata items=\{readerDocument\.displayMetadata\}/);
  assert.match(sharePage, /document\.displayMetadata\?\.length/);
  assert.match(reader, /data-speech-content/);
  assert.doesNotMatch(page, /\[readerDocument\.title, readerDocument\.description, \.\.\.readerDocument\.sections/);
  assert.doesNotMatch(sharePage, /\[document\.title, document\.description, \.\.\.document\.sections/);
});

test("reader exposes H5 download, configurable MeloTTS playback and a revocable share link", async () => {
  const [page, shareWorker, sharePage, ttsWorker, meloTts, reader] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/share.ts", root), "utf8"),
    readFile(new URL("app/share/[shareId]/shared-reader.tsx", root), "utf8"),
    readFile(new URL("worker/tts.ts", root), "utf8"),
    readFile(new URL("services/melotts/server.py", root), "utf8"),
    readFile(new URL("worker/reader.ts", root), "utf8"),
  ]);
  assert.match(page, /一键下载 H5/);
  assert.match(page, /生成分享链接/);
  assert.match(page, /useState<"unavailable" \| "melotts" \| "edge-tts">\("unavailable"\)/);
  assert.match(page, /selectedTtsVoice/);
  assert.match(page, /MELOTTS_SPEED_OPTIONS = \[0\.5, 0\.75, 1, 1\.25, 1\.5, 2\]/);
  assert.match(page, /const \[ttsMode, setTtsMode\] = useState<TtsMode>\("local"\)/);
  assert.match(page, /本地模式 · MeloTTS/);
  assert.match(page, /联网模式 · EdgeTTS/);
  assert.match(page, /if \(ttsProvider !== "unavailable"\)/);
  assert.match(page, /const \[ttsVoicesLoading, setTtsVoicesLoading\] = useState\(false\)/);
  assert.match(page, /正在加载音色，请稍候再开始朗读/);
  assert.match(page, /aria-label="收起面板"/);
  assert.match(page, /\/v1\/documents\/\$\{readerDocument\.documentId\}\/shares/);
  assert.match(shareWorker, /handleShareRequest/);
  assert.match(shareWorker, /tokenHash/);
  assert.match(shareWorker, /status = 'revoked'/);
  assert.match(shareWorker, /SHARE_DOWNLOAD_FORBIDDEN/);
  assert.match(shareWorker, /ttsAction === "synthesize"/);
  assert.match(shareWorker, /synthesizeMeloTts/);
  assert.match(sharePage, /↓ H5/);
  assert.match(sharePage, /\/v1\/public\/shares\//);
  assert.doesNotMatch(page, /const speakFromOffset/);
  assert.match(page, /selectMeloVoice/);
  assert.match(sharePage, /const changeVoice/);
  assert.match(sharePage, /tts\/synthesize/);
  assert.doesNotMatch(sharePage, /speechSynthesis/);
  assert.match(page, /privateTtsVoices/);
  assert.match(page, /function readerDescription/);
  assert.match(sharePage, /function readerDescription/);
  assert.match(page, /MeloTTS/);
  assert.match(page, /mobile-dock-progress/);
  assert.match(page, /拖动定位朗读进度/);
  assert.match(page, /prefetchMeloAhead/);
  assert.match(page, /readerSpeechText/);
  assert.match(page, /缓存播放/);
  assert.match(page, /ttsAudioCacheRequest/);
  assert.doesNotMatch(page, /mobile-reader-section-index/);
  assert.doesNotMatch(page, /<p className="section-eyebrow">\{section\.eyebrow\}/);
  assert.doesNotMatch(reader, /<p class="eyebrow">\$\{escapeHtml\(section\.eyebrow\)\}/);
  assert.match(ttsWorker, /CUSTOMER_HTTP_TTS/);
  assert.match(ttsWorker, /\/v1\/synthesize/);
  assert.match(ttsWorker, /MIN_MELOTTS_SPEED = 0\.5/);
  assert.match(ttsWorker, /MAX_MELOTTS_SPEED = 2/);
  assert.match(meloTts, /tts_to_file/);
  assert.match(meloTts, /spk2id/);
  assert.match(meloTts, /speaker_ids\.items\(\)/);
  assert.match(meloTts, /ge=0\.5, le=2\.0/);
  assert.doesNotMatch(meloTts, /vars\(getattr\(melo_tts\.hps\.data, "spk2id"/);
  assert.match(meloTts, /MeloTTS-Chinese/);
  assert.match(meloTts, /EDGE_VOICES/);
  assert.match(meloTts, /synthesize_edge/);
  assert.match(meloTts, /edge_tts\.Communicate/);
  assert.match(sharePage, /联网 · EdgeTTS/);
  assert.match(sharePage, /shared-player-progress/);
  assert.match(sharePage, /缓存播放/);
  const audioCache = await readFile(new URL("app/lib/tts-audio-cache.ts", root), "utf8");
  assert.match(audioCache, /shengyue-tts-audio-v1/);
  assert.match(audioCache, /TTS_AUDIO_CACHE_LIMIT = 80/);
  assert.match(meloTts, /def normalize_spoken_numbers/);
  assert.match(meloTts, /DATE_PATTERN/);
  assert.match(meloTts, /TIME_PATTERN/);
  assert.match(meloTts, /LANDLINE_PHONE_PATTERN/);
  assert.match(meloTts, /LABELED_LOCAL_PHONE_PATTERN/);
  assert.match(meloTts, /BARE_LONG_NUMBER_PATTERN/);
  assert.match(meloTts, /value = normalize_spoken_numbers\(value\)/);
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
  assert.match(page, /function MobileImportIcon/);
  assert.match(page, /<MobileImportIcon kind="file" \/>/);
  assert.match(page, /正在同步你的真实资料/);
  assert.match(page, /完成一次文件、网页或剪贴板导入后/);
  assert.doesNotMatch(page, /为什么伟大不能被计划/);
  assert.doesNotMatch(page, /Q2 团队复盘纪要/);
  assert.doesNotMatch(page, /消费电子趋势报告/);
  assert.match(styles, /\.mobile-clipboard-zone/);
  assert.match(styles, /Import entry: use stable SVG artwork/);
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

test("third-party local deployment scripts install and manage the private stack", async () => {
  const [deploy, start, restart, common, guide] = await Promise.all([
    readFile(new URL("deploy.sh", root), "utf8"),
    readFile(new URL("start.sh", root), "utf8"),
    readFile(new URL("restart.sh", root), "utf8"),
    readFile(new URL("scripts/local-common.sh", root), "utf8"),
    readFile(new URL("docs/LOCAL_DEPLOYMENT.md", root), "utf8"),
  ]);
  assert.match(deploy, /npm ci/);
  assert.match(deploy, /crawl4ai-setup/);
  assert.match(deploy, /document_processor\/requirements\.txt/);
  assert.match(deploy, /https:\/\/github\.com\/myshell-ai\/MeloTTS\.git/);
  assert.match(deploy, /download_model\.py/);
  assert.match(deploy, /exec \.\/start\.sh/);
  assert.match(start, /--host 0\.0\.0\.0 --port 3000/);
  assert.match(start, /--host 127\.0\.0\.1 --port 8780/);
  assert.match(start, /--host 127\.0\.0\.1 --port 9876/);
  assert.match(start, /8780\/healthz/);
  assert.match(start, /8765\/healthz/);
  assert.match(restart, /stop_service crawler/);
  assert.match(restart, /exec "\$ROOT_DIR\/start\.sh"/);
  assert.match(common, /service_is_running/);
  assert.match(common, /kill -0/);
  assert.match(guide, /\.\/deploy\.sh/);
  assert.match(guide, /局域网/);
});
