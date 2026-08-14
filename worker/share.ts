interface ShareSection {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: string[];
}

export interface SharedReaderDocument {
  title: string;
  description: string;
  sourceUrl: string;
  siteName: string;
  fetchedAt: string;
  wordCount: number;
  engine: "demo" | "crawl4ai" | "server-html-extractor";
  sections: ShareSection[];
}

interface ShareRecord {
  document: SharedReaderDocument;
  allowDownload: boolean;
  expiresAt: number;
  revokeToken: string;
}

// This store makes link sharing fully testable in a local Worker process. It
// deliberately has no production persistence guarantee: production must map
// this contract to a `document_shares` row plus the private H5 artifact.
const developmentShares = new Map<string, ShareRecord>();
const MAX_SHARE_DOCUMENT_CHARS = 32_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function invalid(message: string, status = 422): Response {
  return json({ error: "INVALID_SHARE_REQUEST", message }, status);
}

function asText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeDocument(value: unknown): SharedReaderDocument | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const title = asText(input.title, 300);
  const description = asText(input.description, 2_000);
  const siteName = asText(input.siteName, 300);
  const engine = input.engine;
  if (!title || !description || !siteName || !Array.isArray(input.sections) || !["demo", "crawl4ai", "server-html-extractor"].includes(String(engine))) return null;

  let totalChars = title.length + description.length;
  const sections: ShareSection[] = [];
  for (const rawSection of input.sections.slice(0, 20)) {
    if (!rawSection || typeof rawSection !== "object") return null;
    const section = rawSection as Record<string, unknown>;
    const id = asText(section.id, 100);
    const eyebrow = asText(section.eyebrow, 120);
    const sectionTitle = asText(section.title, 300);
    if (!id || !eyebrow || !sectionTitle || !Array.isArray(section.paragraphs)) return null;
    const paragraphs = section.paragraphs.slice(0, 16).map((paragraph) => asText(paragraph, 3_000));
    if (!paragraphs.length || paragraphs.some((paragraph) => !paragraph)) return null;
    totalChars += eyebrow.length + sectionTitle.length + paragraphs.reduce((sum, paragraph) => sum + (paragraph?.length ?? 0), 0);
    if (totalChars > MAX_SHARE_DOCUMENT_CHARS) return null;
    sections.push({ id, eyebrow, title: sectionTitle, paragraphs: paragraphs as string[] });
  }
  if (!sections.length) return null;

  return {
    title,
    description,
    sourceUrl: typeof input.sourceUrl === "string" ? input.sourceUrl : "",
    siteName,
    fetchedAt: typeof input.fetchedAt === "string" ? input.fetchedAt : new Date().toISOString(),
    wordCount: typeof input.wordCount === "number" && Number.isFinite(input.wordCount) ? Math.max(0, Math.floor(input.wordCount)) : totalChars,
    engine: engine as SharedReaderDocument["engine"],
    sections,
  };
}

function token(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function getActiveShare(shareId: string): ShareRecord | null {
  const record = developmentShares.get(shareId);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    developmentShares.delete(shareId);
    return null;
  }
  return record;
}

export async function handleShareRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const identifier = url.pathname.match(/^\/api\/shares\/([a-z0-9]+)$/i)?.[1];

  if (request.method === "POST" && url.pathname === "/api/shares") {
    try {
      const body = await request.json<Record<string, unknown>>();
      const document = normalizeDocument(body.document);
      if (!document) return invalid("阅读内容不完整或超出分享大小限制。");
      const hours = typeof body.expires_in_hours === "number" ? body.expires_in_hours : 168;
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) return invalid("分享有效期需在 1 小时到 30 天之间。");
      const allowDownload = typeof body.allow_download === "boolean" ? body.allow_download : true;
      const id = token();
      const revokeToken = token();
      const expiresAt = Date.now() + hours * 60 * 60 * 1_000;
      developmentShares.set(id, { document, allowDownload, expiresAt, revokeToken });
      return json({
        id,
        share_url: `${url.origin}/share/${id}`,
        expires_at: new Date(expiresAt).toISOString(),
        allow_download: allowDownload,
        revoke_token: revokeToken,
      }, 201);
    } catch {
      return invalid("请求格式不正确。", 400);
    }
  }

  if (request.method === "GET" && identifier) {
    const record = getActiveShare(identifier);
    if (!record) return json({ error: "SHARE_NOT_FOUND", message: "分享链接不存在、已过期或已关闭。" }, 404);
    return json({
      reader: record.document,
      allow_download: record.allowDownload,
      expires_at: new Date(record.expiresAt).toISOString(),
    });
  }

  if (request.method === "DELETE" && identifier) {
    const record = getActiveShare(identifier);
    if (!record) return json({ error: "SHARE_NOT_FOUND", message: "分享链接不存在、已过期或已关闭。" }, 404);
    if (request.headers.get("x-share-revoke-token") !== record.revokeToken) {
      return json({ error: "SHARE_REVOKE_FORBIDDEN", message: "无权关闭该分享。" }, 403);
    }
    developmentShares.delete(identifier);
    return new Response(null, { status: 204 });
  }

  return json({ error: "METHOD_NOT_ALLOWED", message: "不支持该分享操作。" }, 405);
}
