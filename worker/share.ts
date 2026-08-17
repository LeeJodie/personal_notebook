import { ensureDocumentStore, getAuthenticatedActor, type DocumentEnv } from "./documents";
import { isReaderDocument } from "./reader";

interface ShareDocumentRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  reader_json: string | null;
  h5_key: string | null;
  status: string;
}

interface ShareRow {
  id: string;
  document_id: string;
  tenant_id: string;
  owner_user_id: string;
  token_hash: string;
  allow_download: number;
  expires_at: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
  revoked_at: string | null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function error(message: string, status: number, code: string): Response {
  return json({ error: code, message }, status);
}

async function tokenHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function readShareHours(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 720) return null;
  return value;
}

async function findOwnedDocument(env: DocumentEnv, documentId: string, tenantId: string, userId: string): Promise<ShareDocumentRow | null> {
  return env.DB.prepare("SELECT id, tenant_id, owner_user_id, reader_json, h5_key, status FROM documents WHERE id = ? AND tenant_id = ? AND owner_user_id = ?")
    .bind(documentId, tenantId, userId).first<ShareDocumentRow>();
}

function serializeShare(row: ShareRow) {
  return {
    id: row.id,
    document_id: row.document_id,
    // A raw bearer token is returned only at creation time, never from a
    // subsequent list call. This keeps historic share records inspectable
    // without turning their database id into an access credential.
    reader_url: null,
    expires_at: row.expires_at,
    allow_download: Boolean(row.allow_download),
    status: row.status,
    created_at: row.created_at,
  };
}

export async function handleShareRequest(request: Request, env: DocumentEnv): Promise<Response> {
  const url = new URL(request.url);
  const publicMatch = url.pathname.match(/^\/api\/shares\/([a-f0-9]{32,128})(?:\/artifacts\/(h5))?$/i);
  await ensureDocumentStore(env);

  if (request.method === "GET" && publicMatch) {
    const [, publicToken, artifact] = publicMatch;
    const share = await env.DB.prepare("SELECT s.id, s.document_id, s.tenant_id, s.owner_user_id, s.token_hash, s.allow_download, s.expires_at, s.status, s.created_at, s.revoked_at, d.reader_json, d.h5_key, d.status AS document_status FROM document_shares s JOIN documents d ON d.id = s.document_id WHERE s.token_hash = ?")
      .bind(await tokenHash(publicToken)).first<(ShareRow & { reader_json: string | null; h5_key: string | null; document_status: string })>();
    if (!share || share.status !== "active" || share.document_status !== "ready") return error("分享链接不存在、已关闭或资料尚未就绪。", 404, "SHARE_NOT_FOUND");
    if (Date.parse(share.expires_at) <= Date.now()) {
      await env.DB.prepare("UPDATE document_shares SET status = 'expired' WHERE id = ? AND status = 'active'").bind(share.id).run();
      return error("该分享链接已过期。", 410, "SHARE_EXPIRED");
    }
    let reader: unknown;
    try { reader = share.reader_json ? JSON.parse(share.reader_json) : null; } catch { reader = null; }
    if (!isReaderDocument(reader)) return error("分享内容损坏，请联系资料所有者重新处理。", 500, "SHARE_CONTENT_INVALID");
    if (artifact === "h5") {
      if (!share.allow_download) return error("资料所有者未允许下载该 H5。", 403, "SHARE_DOWNLOAD_FORBIDDEN");
      if (!share.h5_key) return error("该资料的 H5 产物尚未生成。", 409, "ARTIFACT_NOT_READY");
      const h5 = await env.DOCUMENTS.get(share.h5_key);
      if (!h5) return error("未找到该 H5 产物。", 404, "ARTIFACT_NOT_FOUND");
      return new Response(h5.body, {
        headers: {
          "content-type": h5.httpMetadata?.contentType || "text/html; charset=utf-8",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${(reader as { title: string }).title}.html`)}`,
          "cache-control": "private, no-store",
        },
      });
    }
    return json({ reader, allow_download: Boolean(share.allow_download), expires_at: share.expires_at });
  }

  const actor = await getAuthenticatedActor(request, env);
  if (!actor) return error("请先登录后再管理分享链接。", 401, "UNAUTHENTICATED");
  const match = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})\/shares(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) return error("未知的分享接口。", 404, "NOT_FOUND");
  const document = await findOwnedDocument(env, match[1], actor.tenantId, actor.userId);
  if (!document) return error("未找到该文档。", 404, "DOCUMENT_NOT_FOUND");

  if (request.method === "GET" && !match[2]) {
    const shares = await env.DB.prepare("SELECT * FROM document_shares WHERE document_id = ? AND tenant_id = ? AND owner_user_id = ? ORDER BY created_at DESC")
      .bind(document.id, actor.tenantId, actor.userId).all<ShareRow>();
    return json({ items: shares.results.map(serializeShare) });
  }

  if (request.method === "POST" && !match[2]) {
    if (document.status !== "ready" || !document.reader_json) return error("文档尚未转换完成，暂不能分享。", 409, "DOCUMENT_NOT_READY");
    const body = await request.json<{ expires_in_hours?: number; allow_download?: boolean }>();
    const hours = readShareHours(body.expires_in_hours ?? 168);
    if (!hours) return error("分享有效期需在 1 小时到 30 天之间。", 422, "INVALID_EXPIRY");
    const rawToken = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const createdAt = new Date().toISOString();
    const row: ShareRow = {
      id: crypto.randomUUID(), document_id: document.id, tenant_id: actor.tenantId, owner_user_id: actor.userId,
      token_hash: await tokenHash(rawToken), allow_download: body.allow_download === false ? 0 : 1,
      expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(), status: "active", created_at: createdAt, revoked_at: null,
    };
    await env.DB.prepare("INSERT INTO document_shares (id, document_id, tenant_id, owner_user_id, token_hash, allow_download, expires_at, status, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.document_id, row.tenant_id, row.owner_user_id, row.token_hash, row.allow_download, row.expires_at, row.status, row.created_at, row.revoked_at).run();
    const shareUrl = `${url.origin}/share/${rawToken}`;
    return json({ ...serializeShare(row), reader_url: shareUrl, share_url: shareUrl }, 201);
  }

  if (request.method === "DELETE" && match[2]) {
    const result = await env.DB.prepare("UPDATE document_shares SET status = 'revoked', revoked_at = ? WHERE id = ? AND document_id = ? AND tenant_id = ? AND owner_user_id = ? AND status = 'active'")
      .bind(new Date().toISOString(), match[2], document.id, actor.tenantId, actor.userId).run();
    if (!result.meta.changes) return error("分享链接不存在或已关闭。", 404, "SHARE_NOT_FOUND");
    return new Response(null, { status: 204 });
  }
  return error("不支持该分享操作。", 405, "METHOD_NOT_ALLOWED");
}
