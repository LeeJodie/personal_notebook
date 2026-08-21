import type { ReaderDocument } from "./reader";

export type CrawlDocument = ReaderDocument;

interface CrawlEnv {
  CUSTOMER_HTTP_CRAWLER?: Fetcher;
  // Local-only bridge to the real Crawl4AI service. Hosted deployments must
  // use the private binding above rather than exposing this URL publicly.
  LOCAL_CRAWLER_URL?: string;
}

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 24_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", hellip: "…", ldquo: "“", lt: "<",
    nbsp: " ", ndash: "–", quot: '"', rdquo: "”", middot: "·", bull: "•",
  };
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function plainText(value: string): string {
  const normalized = decodeHtml(
    value
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const duplicated = normalized.match(/^(.{2,80})\s+\1$/u);
  return duplicated?.[1] ?? normalized;
}

function metaContent(html: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return plainText(match[1]);
    }
  }
  return "";
}

function elementContents(html: string, openingTag: RegExp): string | null {
  const opening = openingTag.exec(html);
  if (!opening || opening.index === undefined) return null;
  const openEnd = html.indexOf(">", opening.index);
  if (openEnd < 0) return null;

  // A non-greedy regexp stops at the first nested </div>, which is exactly
  // what makes the Beijing policy body appear truncated. Walk matching div
  // tags so nested editor markup remains part of the selected root.
  const divTags = /<\/?div\b[^>]*>/gi;
  divTags.lastIndex = openEnd + 1;
  let depth = 1;
  for (let tag = divTags.exec(html); tag; tag = divTags.exec(html)) {
    if (/^<\/div\b/i.test(tag[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(openEnd + 1, tag.index);
  }
  return null;
}

function extractBeijingPolicyBody(html: string, sourceUrl: string): string | null {
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  if (hostname !== "www.beijing.gov.cn" && !hostname.endsWith(".beijing.gov.cn")) return null;

  const mainText = elementContents(html, /<div\b[^>]*\bid=["']mainText["'][^>]*>/i);
  if (!mainText) return null;
  const view = elementContents(mainText, /<div\b[^>]*\bclass=["'][^"']*\bview\b[^"']*["'][^>]*>/i);
  // Short notices are valid articles too. Falling back solely because a view
  // has fewer than 300 characters pulls page-level controls into TTS.
  return view || mainText;
}

function chooseContentRoot(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (article && plainText(article).length > 300) return article;
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main && plainText(main).length > 300) return main;
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

function isUsefulLine(line: string): boolean {
  if (line.length < 2 || line.length > 900) return false;
  if (/^(?:首页|登录|注册|退出|返回顶部|回到顶部|关闭|打开|更多(?:>{1,2})?|查看(?:更多|详情)|搜索|菜单|网站地图|联系我们|网站声明|无障碍|适老版|政府门户网站|公报\s*PDF|PDF\s*格式下载|收藏|取消收藏|打印|字号：?\s*大\s*中\s*小)$/.test(line)) return false;
  if (/[{}]{2,}|(?:function|document\.|window\.|var\s+\w+\s*=|@media|font-family|display\s*:)/i.test(line)) return false;
  if ((line.match(/[|_=>]/g) ?? []).length > Math.max(8, line.length / 5)) return false;
  return true;
}

function isStructuralHeading(line: string): boolean {
  // Some sites wrap an entire numbered policy sentence in <strong>.  It must
  // remain a spoken paragraph, not become a heading with no body and vanish
  // during section normalization.
  const text = plainText(line);
  if (!text || text.length > 80 || /[，,。！？；;：:]/.test(text)) return false;
  return /^(?:第[一二三四五六七八九十百零〇\d]+[章节]|[一二三四五六七八九十百零〇\d]+、)/.test(text)
    || text.length <= 48;
}

function isRedundantDescription(description: string, sections: Array<{ paragraphs: string[] }>): boolean {
  const compactDescription = description.replace(/\s+/g, "");
  if (compactDescription.length < 12) return false;
  const compactBody = sections.flatMap((section) => section.paragraphs).join("").replace(/\s+/g, "");
  return compactBody.includes(compactDescription.replace(/[。！？，；,.!?]+$/g, ""));
}

function uniqueId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return slug || `section-${index + 1}`;
}

export function extractDocumentFromHtml(html: string, sourceUrl: string): CrawlDocument {
  const title = metaContent(html, ["ArticleTitle", "article:title", "og:title"])
    || plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    || new URL(sourceUrl).hostname;
  const description = metaContent(html, ["description", "og:description"]);
  const siteName = metaContent(html, ["SiteName", "og:site_name"]) || new URL(sourceUrl).hostname;
  const scopedPolicyBody = extractBeijingPolicyBody(html, sourceUrl);
  let content = (scopedPolicyBody || chooseContentRoot(html))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|form|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag: string, inner: string) => `\n@@H${tag.slice(1)}@@ ${plainText(inner)}\n`)
    .replace(/<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi, (_, inner: string) => {
      const text = plainText(inner);
      return isStructuralHeading(text) ? `\n@@H2@@ ${text}\n` : `\n${text}\n`;
    })
    .replace(/<(p|li|dt|dd|blockquote|figcaption|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => `\n${plainText(inner)}\n`)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  content = decodeHtml(content);
  const rawLines = content
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(isUsefulLine);

  const seenHeadings = new Set<string>();
  const seenParagraphs = new Set<string>();
  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  // A site-specific body root is already free of menus and controls, so it
  // does not need a semantic h1 before body paragraphs can be retained.
  let current: { title: string; paragraphs: string[] } | null = scopedPolicyBody ? { title: "网页正文", paragraphs: [] } : null;
  let totalChars = 0;

  const pushCurrent = () => {
    if (!current || current.paragraphs.length === 0) return;
    if (sections.length < 50) sections.push(current);
  };

  for (const rawLine of rawLines) {
    const headingMatch = rawLine.match(/^@@H([1-3])@@\s*(.+)$/);
    if (headingMatch) {
      const heading = plainText(headingMatch[2]).slice(0, 120);
      if (!isUsefulLine(heading) || seenHeadings.has(heading) || heading === title) continue;
      pushCurrent();
      seenHeadings.add(heading);
      current = { title: heading, paragraphs: [] };
      continue;
    }

    // Drop menus and banners before the first semantic heading. The meta
    // description is a more faithful summary than navigation text.
    if (!current) continue;
    const line = plainText(rawLine);
    if (!isUsefulLine(line) || seenParagraphs.has(line) || line === current.title) continue;
    if (totalChars + line.length > MAX_OUTPUT_CHARS) break;
    seenParagraphs.add(line);
    current.paragraphs.push(line);
    totalChars += line.length;
    if (current.paragraphs.length >= 50) {
      pushCurrent();
      current = { title: "网页正文", paragraphs: [] };
    }
  }
  pushCurrent();

  if (sections.length === 0) {
    const fallback = rawLines
      .filter((line) => !line.startsWith("@@H"))
      .map(plainText)
      .filter((line) => isUsefulLine(line) && line !== title)
      .filter((line, index, all) => all.indexOf(line) === index)
      .slice(0, 100);
    if (fallback.length) sections.push({ title: "网页正文", paragraphs: fallback });
  }

  const normalizedSections = sections
    .filter((section) => section.paragraphs.some((paragraph) => paragraph.length >= 4))
    .map((section, index) => ({
      id: uniqueId(section.title, index),
      eyebrow: `${String(index + 1).padStart(2, "0")} / 网页内容`,
      title: section.title,
      paragraphs: section.paragraphs,
    }));

  if (normalizedSections.length === 0) {
    throw new Error("页面已返回 HTML，但未识别到可阅读的正文。");
  }

  const wordCount = normalizedSections.reduce(
    (sum, section) => sum + section.title.length + section.paragraphs.join("").length,
    0,
  );
  return {
    title,
    // Meta description is a portal-generated summary, not source prose. Keep
    // the reader faithful to the extracted article paragraphs only.
    description: "",
    sourceUrl,
    siteName,
    fetchedAt: new Date().toISOString(),
    wordCount,
    engine: "server-html-extractor",
    sections: normalizedSections,
  };
}

function normalizeUrl(input: unknown): URL {
  if (typeof input !== "string" || !input.trim()) throw new Error("请输入网页地址。");
  const candidate = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  const url = new URL(candidate);
  if (!/^https?:$/.test(url.protocol)) throw new Error("仅支持 HTTP 或 HTTPS 网页。");
  if (url.username || url.password) throw new Error("不支持包含账号信息的网址。");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const unsafe = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    host === "::1" || host === "0.0.0.0" || host === "169.254.169.254" ||
    /^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
  if (unsafe) throw new Error("该地址不允许抓取。");
  return url;
}

async function fetchPublicHtml(initialUrl: URL): Promise<{ html: string; finalUrl: string }> {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    current = normalizeUrl(current.toString());
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.5",
        "user-agent": "Mozilla/5.0 (compatible; ShengYueReader/1.0; +https://chatgpt.site)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("目标网站返回了无效重定向。");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`目标网站返回 ${response.status}。`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("该地址返回的不是 HTML 网页。");
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error("页面过大，超出抓取限制。");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) throw new Error("页面过大，超出抓取限制。");
    return { html: new TextDecoder().decode(buffer), finalUrl: current.toString() };
  }
  throw new Error("目标网站重定向次数过多。");
}

export async function handleCrawlRequest(request: Request, env: CrawlEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED", message: "仅支持 POST。" }, 405);
  try {
    const body = await request.json<{ url?: string }>();
    const document = await crawlUrl(body.url, env);
    return json(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : "抓取失败。";
    return json({ error: "CRAWL_FAILED", message }, 422);
  }
}

export async function crawlUrl(value: unknown, env: CrawlEnv): Promise<CrawlDocument> {
  const target = normalizeUrl(value);
  // Production path: a private HTTP binding points to the containerized
  // Crawl4AI service in services/crawler. Local development uses the same
  // service through a loopback URL. Do not silently substitute the simpler
  // extractor once Crawl4AI has been configured: a partial result is worse
  // than a clear service error for a saved reader document.
  if (env.CUSTOMER_HTTP_CRAWLER) {
    const upstream = await env.CUSTOMER_HTTP_CRAWLER.fetch("http://crawler.internal/v1/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target.toString() }),
    });
    if (!upstream.ok) throw new Error(`Crawl4AI 服务返回 ${upstream.status}。`);
    const data = await upstream.json<Record<string, unknown>>();
    return { ...data, engine: "crawl4ai" } as CrawlDocument;
  }
  if (env.LOCAL_CRAWLER_URL) {
    const endpoint = new URL("/v1/crawl", env.LOCAL_CRAWLER_URL).toString();
    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target.toString() }),
      });
    } catch {
      throw new Error("本地 Crawl4AI 服务不可用。请先运行 npm run dev:crawler。");
    }
    if (!upstream.ok) {
      const failure = await upstream.json<{ detail?: string }>().catch(() => null);
      throw new Error(failure?.detail || `本地 Crawl4AI 服务返回 ${upstream.status}。`);
    }
    const data = await upstream.json<Record<string, unknown>>();
    return { ...data, engine: "crawl4ai" } as CrawlDocument;
  }
  const { html, finalUrl } = await fetchPublicHtml(target);
  return extractDocumentFromHtml(html, finalUrl);
}
