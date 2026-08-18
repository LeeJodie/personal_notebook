import { crawlUrl } from "./crawl";
import { createH5, createMarkdownReader, isReaderDocument, type ReaderDocument } from "./reader";

export interface DocumentEnv {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  CUSTOMER_HTTP_CRAWLER?: Fetcher;
  CUSTOMER_HTTP_DOCUMENT_PROCESSOR?: Fetcher;
  CUSTOMER_HTTP_KNOWLEDGE_INDEX?: Fetcher;
  // Local-only Vite/Miniflare bridge. It is intentionally absent from hosted
  // bindings, where the private HTTP service binding above is required.
  LOCAL_DOCUMENT_PROCESSOR_URL?: string;
}

export interface Actor {
  tenantId: string;
  userId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  authMode: "platform" | "local";
}

interface DocumentRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  title: string;
  description: string;
  source_type: "upload" | "url";
  source_url: string | null;
  filename: string | null;
  media_type: string | null;
  size_bytes: number | null;
  status: "queued" | "parsing" | "ready" | "failed" | "deleting";
  progress: number;
  word_count: number;
  reader_json: string | null;
  original_key: string | null;
  h5_key: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const initializedStores = new WeakMap<D1Database, Promise<void>>();
const ACCEPTED_EXTENSIONS = new Set(["docx", "md", "txt", "pdf", "xlsx"]);
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function problem(message: string, status = 400, code = "BAD_REQUEST"): Response {
  return json({ error: code, message }, status);
}

export function getActor(request: Request): Actor | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) {
    const encodedName = request.headers.get("oai-authenticated-user-full-name");
    const displayName = encodedName && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8"
      ? decodeURIComponent(encodedName)
      : request.headers.get("oai-authenticated-user-email") || "已登录用户";
    return { userId, tenantId: `workspace:${userId}`, displayName, email: request.headers.get("oai-authenticated-user-email"), phone: null, authMode: "platform" };
  }
  return null;
}

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function readCookie(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

export async function hashOpaqueToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface LocalActorRow {
  user_id: string;
  email: string;
  phone: string | null;
  display_name: string;
  expires_at: string;
}

export async function getAuthenticatedActor(request: Request, env: Pick<DocumentEnv, "DB">): Promise<Actor | null> {
  const platformActor = getActor(request);
  if (platformActor) return platformActor;
  if (!isLocalRequest(request)) return null;
  const token = readCookie(request, "shengyue_local_session");
  if (!token) return null;
  const session = await env.DB.prepare("SELECT s.user_id, s.expires_at, u.email, u.phone, u.display_name FROM local_sessions s JOIN local_users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(await hashOpaqueToken(token)).first<LocalActorRow>();
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM local_sessions WHERE token_hash = ?").bind(await hashOpaqueToken(token)).run();
    return null;
  }
  return {
    userId: session.user_id,
    // Preserve access to pre-login localhost content for the default account;
    // every additional development account gets a separate tenant boundary.
    tenantId: session.user_id === "local-developer" ? "local-workspace" : `local:${session.user_id}`,
    displayName: session.display_name,
    email: session.email,
    phone: session.phone,
    authMode: "local",
  };
}

export function isLocalDevelopmentRequest(request: Request): boolean {
  return isLocalRequest(request);
}

export async function ensureDocumentStore(env: Pick<DocumentEnv, "DB">): Promise<void> {
  const current = initializedStores.get(env.DB);
  if (current) return current;
  const initialization = (async () => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL, source_url TEXT, filename TEXT, media_type TEXT, size_bytes INTEGER, status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0, word_count INTEGER NOT NULL DEFAULT 0, reader_json TEXT, original_key TEXT, h5_key TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_documents_owner_updated ON documents (tenant_id, owner_user_id, updated_at)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status, updated_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, section_title TEXT NOT NULL DEFAULT '', ordinal INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chunks_owner_document ON document_chunks (tenant_id, owner_user_id, document_id, ordinal)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS document_shares (id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, allow_download INTEGER NOT NULL DEFAULT 1, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, revoked_at TEXT)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_token_hash ON document_shares (token_hash)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_shares_document_status ON document_shares (document_id, status, expires_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS local_users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, phone TEXT, display_name TEXT NOT NULL, password_hash TEXT, password_salt TEXT, password_updated_at TEXT, created_at TEXT NOT NULL)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_local_users_email ON local_users (email)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS local_sessions (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_local_sessions_token_hash ON local_sessions (token_hash)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_local_sessions_user_expiry ON local_sessions (user_id, expires_at)"),
    ]);
    const columns = await env.DB.prepare("PRAGMA table_info(local_users)").all<{ name: string }>();
    const existing = new Set(columns.results.map((column) => column.name));
    const additions = [
      ["password_hash", "ALTER TABLE local_users ADD COLUMN password_hash TEXT"],
      ["password_salt", "ALTER TABLE local_users ADD COLUMN password_salt TEXT"],
      ["password_updated_at", "ALTER TABLE local_users ADD COLUMN password_updated_at TEXT"],
      ["phone", "ALTER TABLE local_users ADD COLUMN phone TEXT"],
    ] as const;
    for (const [column, statement] of additions) {
      if (!existing.has(column)) await env.DB.prepare(statement).run();
    }
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_local_users_phone ON local_users (phone)").run();
  })();
  initializedStores.set(env.DB, initialization);
  return initialization;
}

function safeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document";
}

function fileExtension(filename: string): string {
  return filename.trim().split(".").pop()?.toLowerCase() ?? "";
}

function now(): string {
  return new Date().toISOString();
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "").trim();
  // Export tools often append a 14-digit timestamp such as _20260817155132.
  // It identifies the source file but is not part of the reading title.
  return withoutExtension.replace(/[_\-\s]?(?:19|20)\d{12}(?:\d{3})?$/, "").trim().slice(0, 300) || "未命名文档";
}

function hasTrailingExportTimestamp(filename: string): boolean {
  return /[_\-\s]?(?:19|20)\d{12}(?:\d{3})?(?:\.[^.]+)?$/i.test(filename.trim());
}

function displayFilename(filename: string): string {
  const extension = filename.match(/\.[^.]+$/)?.[0] || "";
  return `${titleFromFilename(filename)}${extension}`;
}

function serializeRow(row: DocumentRow) {
  return {
    id: row.id,
    title: row.filename && hasTrailingExportTimestamp(row.filename) ? titleFromFilename(row.filename) : row.title,
    description: row.description,
    source_type: row.source_type,
    source_url: row.source_url,
    filename: row.filename,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    status: row.status,
    progress: row.progress,
    word_count: row.word_count,
    artifacts: [
      { type: "original", ready: Boolean(row.original_key) },
      { type: "h5", ready: Boolean(row.h5_key) },
    ],
    created_at: row.created_at,
    updated_at: row.updated_at,
    error_message: row.error_message,
  };
}

async function findOwnedDocument(env: DocumentEnv, actor: Actor, documentId: string): Promise<DocumentRow | null> {
  await ensureDocumentStore(env);
  const row = await env.DB.prepare("SELECT * FROM documents WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
    .bind(documentId, actor.tenantId, actor.userId)
    .first<DocumentRow>();
  return row ? normalizeLegacyDocumentTitle(env, actor, row) : null;
}

async function normalizeLegacyDocumentTitle(env: DocumentEnv, actor: Actor, row: DocumentRow): Promise<DocumentRow> {
  if (!row.filename || !hasTrailingExportTimestamp(row.filename)) return row;
  const normalizedTitle = titleFromFilename(row.filename);
  const oldFilenameTitle = row.filename.replace(/\.[^.]+$/, "").trim();
  if (row.title !== oldFilenameTitle || normalizedTitle === row.title) return row;
  let reader: ReaderDocument | null = null;
  try {
    const candidate = row.reader_json ? JSON.parse(row.reader_json) : null;
    if (isReaderDocument(candidate)) reader = { ...candidate, title: normalizedTitle, siteName: displayFilename(row.filename) };
  } catch {
    reader = null;
  }
  const h5Key = row.h5_key;
  if (reader && h5Key) {
    await env.DOCUMENTS.put(h5Key, createH5(reader), {
      httpMetadata: { contentType: "text/html; charset=utf-8", contentDisposition: `attachment; filename="${encodeURIComponent(`${normalizedTitle}.html`)}` },
    });
  }
  const updatedAt = now();
  await env.DB.prepare("UPDATE documents SET title = ?, reader_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
    .bind(normalizedTitle, reader ? JSON.stringify(reader) : row.reader_json, updatedAt, row.id, actor.tenantId, actor.userId).run();
  return { ...row, title: normalizedTitle, reader_json: reader ? JSON.stringify(reader) : row.reader_json, updated_at: updatedAt };
}

function extractChunks(document: ReaderDocument): Array<{ sectionTitle: string; content: string }> {
  const chunks: Array<{ sectionTitle: string; content: string }> = [];
  for (const section of document.sections) {
    let buffer = "";
    for (const paragraph of section.paragraphs) {
      const next = buffer ? `${buffer}\n${paragraph}` : paragraph;
      if (next.length > 900 && buffer) {
        chunks.push({ sectionTitle: section.title, content: buffer });
        buffer = paragraph;
      } else {
        buffer = next;
      }
    }
    if (buffer) chunks.push({ sectionTitle: section.title, content: buffer });
  }
  return chunks.slice(0, 500);
}

async function persistReader(env: DocumentEnv, actor: Actor, row: DocumentRow, reader: ReaderDocument): Promise<void> {
  const updatedAt = now();
  const h5Key = `tenants/${safeKeyPart(actor.tenantId)}/users/${safeKeyPart(actor.userId)}/documents/${row.id}/h5/index.html`;
  await env.DOCUMENTS.put(h5Key, createH5(reader), {
    httpMetadata: { contentType: "text/html; charset=utf-8", contentDisposition: `attachment; filename="${encodeURIComponent(`${reader.title}.html`)}"` },
  });
  const chunks = extractChunks(reader);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE documents SET title = ?, description = ?, status = 'ready', progress = 100, word_count = ?, reader_json = ?, h5_key = ?, error_message = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
      .bind(reader.title.slice(0, 300), reader.description.slice(0, 2_000), reader.wordCount, JSON.stringify(reader), h5Key, updatedAt, row.id, actor.tenantId, actor.userId),
    env.DB.prepare("DELETE FROM document_chunks WHERE document_id = ? AND tenant_id = ? AND owner_user_id = ?").bind(row.id, actor.tenantId, actor.userId),
  ];
  chunks.forEach((chunk, ordinal) => statements.push(
    env.DB.prepare("INSERT INTO document_chunks (id, document_id, tenant_id, owner_user_id, section_title, ordinal, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), row.id, actor.tenantId, actor.userId, chunk.sectionTitle.slice(0, 300), ordinal, chunk.content, updatedAt),
  ));
  await env.DB.batch(statements);
  // The D1 index remains the deterministic fallback. When the private vector
  // service is connected, index the same chunks for semantic retrieval without
  // exposing raw document text to a public endpoint.
  if (env.CUSTOMER_HTTP_KNOWLEDGE_INDEX && chunks.length) {
    try {
      await env.CUSTOMER_HTTP_KNOWLEDGE_INDEX.fetch("http://knowledge-index.internal/v1/chunks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: actor.tenantId,
          owner_user_id: actor.userId,
          document_id: row.id,
          document_title: reader.title,
          chunks: chunks.map((chunk, ordinal) => ({ id: `${row.id}:${ordinal}`, heading_path: [chunk.sectionTitle], text: chunk.content })),
        }),
      });
    } catch {
      // Persisted lexical search is intentionally kept available if the vector
      // provider is temporarily unavailable. A production deployment should
      // also enqueue a retry through its worker queue.
    }
  }
}

async function invokeDocumentProcessor(env: DocumentEnv, row: DocumentRow): Promise<ReaderDocument> {
  if (!row.original_key || !row.filename) throw new Error("未找到待解析的原始文件。");
  const source = await env.DOCUMENTS.get(row.original_key);
  if (!source) throw new Error("未找到待解析的原始文件。");
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": row.media_type || "application/octet-stream",
      // HTTP headers are ASCII-only in some local runtimes. Encoding preserves
      // Chinese filenames for the parser and its generated reader metadata.
      "x-source-filename": encodeURIComponent(row.filename),
      "x-source-url": row.source_url || "",
    },
    body: source.body,
  };
  const response = env.CUSTOMER_HTTP_DOCUMENT_PROCESSOR
    ? await env.CUSTOMER_HTTP_DOCUMENT_PROCESSOR.fetch("http://document-processor.internal/v1/parse", init)
    : env.LOCAL_DOCUMENT_PROCESSOR_URL
      ? await fetch(`${env.LOCAL_DOCUMENT_PROCESSOR_URL.replace(/\/$/, "")}/v1/parse`, init)
      : (() => { throw new Error("文档解析服务尚未启动。请先运行 npm run dev:processor；生产环境需配置 document-processor 私有服务绑定。"); })();
  const data = await response.json<{ document?: unknown; message?: string }>();
  if (!response.ok || !isReaderDocument(data.document)) {
    throw new Error(data.message || "文档解析服务没有返回可阅读内容。");
  }
  return data.document;
}

async function processOwnedDocument(env: DocumentEnv, actor: Actor, row: DocumentRow): Promise<DocumentRow> {
  await env.DB.prepare("UPDATE documents SET status = 'parsing', progress = 35, error_message = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
    .bind(now(), row.id, actor.tenantId, actor.userId).run();
  try {
    let reader: ReaderDocument;
    const extension = fileExtension(row.filename || "");
    if (extension === "md" || extension === "txt") {
      const source = row.original_key ? await env.DOCUMENTS.get(row.original_key) : null;
      if (!source) throw new Error("未找到待解析的原始文本文件。");
      reader = createMarkdownReader(await source.text(), row.title, "", extension === "txt" ? "上传的 TXT 文档" : "上传的 Markdown 文档");
    } else {
      reader = await invokeDocumentProcessor(env, row);
    }
    await persistReader(env, actor, row, reader);
  } catch (error) {
    await env.DB.prepare("UPDATE documents SET status = 'failed', progress = 100, error_message = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 1_000) : "文档解析失败。", now(), row.id, actor.tenantId, actor.userId).run();
  }
  const result = await findOwnedDocument(env, actor, row.id);
  if (!result) throw new Error("处理完成后未找到文档记录。");
  return result;
}

async function createUploadedDocument(request: Request, env: DocumentEnv, actor: Actor): Promise<Response> {
  const form = await request.formData();
  const incoming = form.get("file");
  if (!incoming || typeof (incoming as File).stream !== "function") return problem("请使用 file 字段上传文件。", 422, "FILE_REQUIRED");
  const file = incoming as File;
  const extension = fileExtension(file.name);
  if (!ACCEPTED_EXTENSIONS.has(extension)) return problem("当前仅支持 DOCX、MD、PDF、XLSX。", 422, "UNSUPPORTED_FILE_TYPE");
  if (file.size < 1 || file.size > MAX_FILE_BYTES) return problem("文件大小需在 1 字节到 200 MB 之间。", 413, "FILE_TOO_LARGE");
  const id = crypto.randomUUID();
  const createdAt = now();
  const sourceKey = `tenants/${safeKeyPart(actor.tenantId)}/users/${safeKeyPart(actor.userId)}/documents/${id}/source/${safeKeyPart(file.name)}`;
  await env.DOCUMENTS.put(sourceKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream", contentDisposition: `attachment; filename="${encodeURIComponent(file.name)}"` },
  });
  const row: DocumentRow = {
    id, tenant_id: actor.tenantId, owner_user_id: actor.userId, title: titleFromFilename(file.name), description: "",
    source_type: "upload", source_url: null, filename: file.name, media_type: file.type || "application/octet-stream", size_bytes: file.size,
    status: "queued", progress: 5, word_count: 0, reader_json: null, original_key: sourceKey, h5_key: null, error_message: null, created_at: createdAt, updated_at: createdAt,
  };
  await env.DB.prepare("INSERT INTO documents (id, tenant_id, owner_user_id, title, description, source_type, source_url, filename, media_type, size_bytes, status, progress, word_count, reader_json, original_key, h5_key, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.tenant_id, row.owner_user_id, row.title, row.description, row.source_type, row.source_url, row.filename, row.media_type, row.size_bytes, row.status, row.progress, row.word_count, row.reader_json, row.original_key, row.h5_key, row.error_message, row.created_at, row.updated_at).run();
  const processed = await processOwnedDocument(env, actor, row);
  return json({ document: serializeRow(processed), reader: processed.reader_json ? JSON.parse(processed.reader_json) : null }, processed.status === "ready" ? 201 : 202);
}

async function createUrlDocument(request: Request, env: DocumentEnv, actor: Actor): Promise<Response> {
  const body = await request.json<{ url?: string }>();
  if (!body.url) return problem("请输入网页地址。", 422, "URL_REQUIRED");
  const id = crypto.randomUUID();
  const createdAt = now();
  const row: DocumentRow = {
    id, tenant_id: actor.tenantId, owner_user_id: actor.userId, title: "正在抓取网页", description: "", source_type: "url", source_url: body.url,
    filename: null, media_type: "text/html", size_bytes: null, status: "parsing", progress: 15, word_count: 0, reader_json: null,
    original_key: null, h5_key: null, error_message: null, created_at: createdAt, updated_at: createdAt,
  };
  await env.DB.prepare("INSERT INTO documents (id, tenant_id, owner_user_id, title, description, source_type, source_url, filename, media_type, size_bytes, status, progress, word_count, reader_json, original_key, h5_key, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.tenant_id, row.owner_user_id, row.title, row.description, row.source_type, row.source_url, row.filename, row.media_type, row.size_bytes, row.status, row.progress, row.word_count, row.reader_json, row.original_key, row.h5_key, row.error_message, row.created_at, row.updated_at).run();
  try {
    const reader = await crawlUrl(body.url, env);
    await persistReader(env, actor, row, reader);
  } catch (error) {
    await env.DB.prepare("UPDATE documents SET status = 'failed', progress = 100, error_message = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 1_000) : "网页抓取失败。", now(), row.id, actor.tenantId, actor.userId).run();
  }
  const result = await findOwnedDocument(env, actor, id);
  if (!result) return problem("网页导入失败。", 500, "IMPORT_FAILED");
  return json({ document: serializeRow(result), reader: result.reader_json ? JSON.parse(result.reader_json) : null }, result.status === "ready" ? 201 : 202);
}

async function serveArtifact(env: DocumentEnv, row: DocumentRow, artifact: "original" | "h5"): Promise<Response> {
  const key = artifact === "original" ? row.original_key : row.h5_key;
  if (!key) return problem("该产物尚未生成。", 409, "ARTIFACT_NOT_READY");
  const object = await env.DOCUMENTS.get(key);
  if (!object) return problem("未找到该产物。", 404, "ARTIFACT_NOT_FOUND");
  const filename = artifact === "h5" ? `${row.title}.html` : row.filename || "document";
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || (artifact === "h5" ? "text/html; charset=utf-8" : "application/octet-stream"),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "private, no-store",
    },
  });
}

async function searchKnowledge(request: Request, env: DocumentEnv, actor: Actor): Promise<Response> {
  const body = await request.json<{ query?: string; limit?: number }>();
  const query = body.query?.trim();
  if (!query) return problem("请输入检索关键词。", 422, "QUERY_REQUIRED");
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  if (env.CUSTOMER_HTTP_KNOWLEDGE_INDEX) {
    try {
      const upstream = await env.CUSTOMER_HTTP_KNOWLEDGE_INDEX.fetch("http://knowledge-index.internal/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: actor.tenantId, owner_user_id: actor.userId, query, limit }),
      });
      if (upstream.ok) return new Response(upstream.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      // Fall through to the private D1 keyword index.
    }
  }
  const rows = await env.DB.prepare("SELECT c.id AS chunk_id, c.document_id, c.section_title, c.content, d.title AS document_title FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.tenant_id = ? AND c.owner_user_id = ? AND d.status = 'ready' AND LOWER(c.content) LIKE LOWER(?) ORDER BY d.updated_at DESC, c.ordinal ASC LIMIT ?")
    .bind(actor.tenantId, actor.userId, `%${query.slice(0, 200)}%`, limit).all<{ chunk_id: string; document_id: string; section_title: string; content: string; document_title: string }>();
  return json({ items: rows.results.map((row) => ({ document_id: row.document_id, document_title: row.document_title, chunk_id: row.chunk_id, score: 1, text: row.content, heading_path: [row.section_title] })) });
}

export async function handleDocumentRequest(request: Request, env: DocumentEnv): Promise<Response> {
  await ensureDocumentStore(env);
  const actor = await getAuthenticatedActor(request, env);
  if (!actor) return problem("请先登录后再访问个人资料。", 401, "UNAUTHENTICATED");
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/documents/upload") return createUploadedDocument(request, env, actor);
  if (request.method === "POST" && url.pathname === "/api/documents/import-url") return createUrlDocument(request, env, actor);
  if (request.method === "GET" && url.pathname === "/api/documents") {
    const rows = await env.DB.prepare("SELECT * FROM documents WHERE tenant_id = ? AND owner_user_id = ? ORDER BY updated_at DESC LIMIT 100").bind(actor.tenantId, actor.userId).all<DocumentRow>();
    return json({ items: rows.results.map(serializeRow), next_cursor: null });
  }
  if (request.method === "POST" && url.pathname === "/api/knowledge/search") return searchKnowledge(request, env, actor);

  const match = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})(?:\/(reader|process|artifacts\/(original|h5)))?$/i);
  if (!match) return problem("未知的文档接口。", 404, "NOT_FOUND");
  const row = await findOwnedDocument(env, actor, match[1]);
  if (!row) return problem("未找到该文档。", 404, "DOCUMENT_NOT_FOUND");
  if (request.method === "GET" && !match[2]) return json({ document: serializeRow(row) });
  if (request.method === "DELETE" && !match[2]) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM document_shares WHERE document_id = ? AND tenant_id = ? AND owner_user_id = ?").bind(row.id, actor.tenantId, actor.userId),
      env.DB.prepare("DELETE FROM document_chunks WHERE document_id = ? AND tenant_id = ? AND owner_user_id = ?").bind(row.id, actor.tenantId, actor.userId),
      env.DB.prepare("DELETE FROM documents WHERE id = ? AND tenant_id = ? AND owner_user_id = ?").bind(row.id, actor.tenantId, actor.userId),
    ]);
    await Promise.all([row.original_key && env.DOCUMENTS.delete(row.original_key), row.h5_key && env.DOCUMENTS.delete(row.h5_key)].filter(Boolean));
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && match[2] === "reader") {
    if (!row.reader_json) return problem("文档尚未转换完成。", 409, "DOCUMENT_NOT_READY");
    return json({ document_id: row.id, ...JSON.parse(row.reader_json) });
  }
  if (request.method === "GET" && (match[3] === "original" || match[3] === "h5")) return serveArtifact(env, row, match[3]);
  if (request.method === "POST" && match[2] === "process") {
    const processed = await processOwnedDocument(env, actor, row);
    return json({ document: serializeRow(processed), reader: processed.reader_json ? JSON.parse(processed.reader_json) : null }, processed.status === "ready" ? 200 : 422);
  }
  return problem("不支持该文档操作。", 405, "METHOD_NOT_ALLOWED");
}
