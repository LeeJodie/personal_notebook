from __future__ import annotations

import asyncio
import html
import ipaddress
import re
import socket
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from crawl4ai import AsyncWebCrawler
from crawl4ai.async_configs import BrowserConfig, CacheMode, CrawlerRunConfig
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl


class CrawlRequest(BaseModel):
    url: HttpUrl


class ReaderSection(BaseModel):
    id: str
    eyebrow: str
    title: str
    paragraphs: list[str]


class DisplayMetadataItem(BaseModel):
    """Source facts that are visible in the reader but excluded from TTS."""

    label: str
    value: str
    href: str | None = None


class CrawlResponse(BaseModel):
    title: str
    description: str
    sourceUrl: str
    siteName: str
    fetchedAt: str
    wordCount: int
    engine: str = "crawl4ai"
    sections: list[ReaderSection]
    displayMetadata: list[DisplayMetadataItem] = []


def assert_public_url(raw_url: str) -> None:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=422, detail="仅支持公开 HTTP/HTTPS 网页。")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=422, detail="网址不能包含账号信息。")

    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=422, detail="目标域名无法解析。") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=422, detail="不允许抓取内网或本机地址。")


def clean_line(value: str) -> str:
    value = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"[*_`>#|]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def is_page_chrome(text: str) -> bool:
    """Exclude reader controls and download links from spoken article text."""
    normalized = re.sub(r"\s+", "", text)
    return normalized in {
        "政府门户网站",
        "公报PDF",
        "PDF格式下载",
        "收藏",
        "取消收藏",
        "打印",
        "字号：大中小",
        "字号:大中小",
    }


def is_redundant_description(description: str, sections: list[ReaderSection]) -> bool:
    """Do not show a page meta summary again when it is already body text."""
    compact_description = re.sub(r"\s+", "", description)
    if len(compact_description) < 12:
        return False
    compact_body = re.sub(
        r"\s+", "",
        "".join(paragraph for section in sections for paragraph in section.paragraphs),
    )
    # Beijing pages often truncate the next paragraph in meta description and
    # append a full stop. Compare the useful prefix, not that artificial end.
    description_prefix = compact_description.rstrip("。！？，；,.!?")
    return description_prefix in compact_body


def content_selector_for(url: str) -> str | None:
    """Use a known article body when a public site exposes one reliably."""
    hostname = (urlparse(url).hostname or "").lower()
    if hostname == "www.beijing.gov.cn" or hostname.endswith(".beijing.gov.cn"):
        # The page wrapper includes breadcrumb, font-size controls, sharing and
        # related links. The policy body itself is always published here.
        return "#mainText .view"
    return None


def crawler_run_config(css_selector: str | None = None) -> CrawlerRunConfig:
    return CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        # Crawl4AI counts words by whitespace. A Chinese paragraph often has
        # no spaces at all, so the default-like threshold of 5 silently drops
        # short policy notices such as meeting announcements.
        word_count_threshold=1,
        excluded_tags=["script", "style", "nav", "footer", "form", "noscript"],
        remove_overlay_elements=True,
        process_iframes=False,
        page_timeout=45_000,
        css_selector=css_selector,
    )


class NoRedirect(HTTPRedirectHandler):
    """Do not let a compatibility fetch escape the URL already validated above."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def is_wechat_verification_page(page_html: str, source_url: str) -> bool:
    hostname = (urlparse(source_url).hostname or "").lower()
    return hostname == "mp.weixin.qq.com" and "当前环境异常" in page_html and "去验证" in page_html


def fetch_wechat_article_html(source_url: str) -> str:
    """Fetch a public WeChat article when its headless-browser view is a challenge.

    Crawl4AI remains the primary renderer. This narrow fallback is deliberately
    limited to the already-validated WeChat host, does not follow redirects,
    and only restores a publicly returned HTML article. A real verification
    page is still rejected by the caller rather than saved as document text.
    """
    parsed = urlparse(source_url)
    if parsed.hostname != "mp.weixin.qq.com":
        return ""
    request = Request(
        source_url,
        headers={
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",
        },
    )
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            content_type = response.headers.get_content_type()
            if content_type not in {"text/html", "application/xhtml+xml"}:
                return ""
            payload = response.read(5 * 1024 * 1024 + 1)
            if len(payload) > 5 * 1024 * 1024:
                return ""
            return payload.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError, OSError):
        return ""


def html_meta_content(page_html: str, names: list[str]) -> str:
    for name in names:
        escaped_name = re.escape(name)
        patterns = [
            rf'<meta\b[^>]*\bname=["\']{escaped_name}["\'][^>]*\bcontent=["\']([^"\']*)["\'][^>]*>',
            rf'<meta\b[^>]*\bcontent=["\']([^"\']*)["\'][^>]*\bname=["\']{escaped_name}["\'][^>]*>',
        ]
        for pattern in patterns:
            match = re.search(pattern, page_html, re.I)
            if match and clean_line(match.group(1)):
                return clean_line(match.group(1))
    return ""


def extract_display_metadata(page_html: str, source_url: str) -> list[DisplayMetadataItem]:
    """Keep source metadata out of the narration stream while retaining it for readers."""
    items: list[DisplayMetadataItem] = []
    seen: set[tuple[str, str, str | None]] = set()

    def add(label: str, value: str, href: str | None = None) -> None:
        cleaned_label = clean_line(label).strip("[]")[:80]
        cleaned_value = clean_line(value)[:500]
        if cleaned_value != "----":
            cleaned_value = re.sub(r"(?:^|\s)----(?:\s|$)", " ", cleaned_value)
            cleaned_value = re.sub(r"\s+", " ", cleaned_value).strip()
        if cleaned_label == "有效性" and cleaned_value in {"是", "有效", "现行"}:
            cleaned_value = "现行有效"
        if not cleaned_label or not cleaned_value:
            return
        resolved_href = urljoin(source_url, html.unescape(href)) if href else None
        if resolved_href and urlparse(resolved_href).scheme not in {"http", "https"}:
            resolved_href = None
        key = (cleaned_label, cleaned_value, resolved_href)
        if key not in seen:
            seen.add(key)
            items.append(DisplayMetadataItem(label=cleaned_label, value=cleaned_value, href=resolved_href))

    # Beijing government policy pages expose their publication facts here. This
    # is intentionally optional: sites without this schema still get clean body
    # extraction without a site-specific dependency.
    info_block = re.search(
        r'<ol\b[^>]*\bclass=["\'][^"\']*\bdoc-info\b[^"\']*["\'][^>]*>([\s\S]*?)</ol>',
        page_html,
        re.I,
    )
    if info_block:
        for list_item in re.findall(r"<li\b[^>]*>([\s\S]*?)</li>", info_block.group(1), re.I):
            text = clean_line(list_item)
            match = re.match(r"^\[([^\]]+)]\s*(.*)$", text)
            if not match:
                continue
            anchor = re.search(r'<a\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*>', list_item, re.I)
            add(match.group(1), match.group(2), anchor.group(1) if anchor else None)

    # A PDF is useful source material, but neither its label nor URL belongs in
    # body paragraphs or text-to-speech.
    for href, text in re.findall(r'<a\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', page_html, re.I):
        if ".pdf" in href.lower() or "pdf" in clean_line(text).lower():
            add("PDF 格式下载", "查看 PDF 原件", href)
            break

    return items[:16]


def is_section_heading(raw_line: str) -> str | None:
    line = raw_line.strip()
    bold = re.fullmatch(r"\*\*\s*(.+?)\s*\*\*", line)
    candidate = clean_line(bold.group(1) if bold else line)
    if not candidate or len(candidate) > 120:
        return None
    # A Beijing policy body often numbers every paragraph with ``一、`` / ``二、``.
    # Those are sentences, not chapter headings: promoting them to a heading can
    # leave an empty section which is then discarded by ``flush``.  This was the
    # reason the complete third paragraph of some notices disappeared.  A real
    # chapter title is short and does not contain sentence punctuation.
    is_compact_label = len(candidate) <= 80 and not re.search(r"[，,。！？；;：:]", candidate)
    if bold and is_compact_label:
        return candidate
    # Government documents frequently represent chapter titles as bold <p>
    # rather than h2 elements. Crawl4AI faithfully keeps the text but not that
    # semantic tag, so restore the chapter boundary from the numbering.
    if is_compact_label and re.match(
        r"^(?:第[一二三四五六七八九十百零〇\d]+[章节]|[一二三四五六七八九十百零〇\d]+、)",
        candidate,
    ):
        return candidate
    return None


def markdown_to_sections(markdown: str, page_title: str) -> list[ReaderSection]:
    sections: list[tuple[str, list[str]]] = []
    current_title = "网页正文"
    current_paragraphs: list[str] = []
    seen: set[str] = set()

    def flush() -> None:
        nonlocal current_paragraphs
        if current_paragraphs:
            sections.append((current_title, current_paragraphs))
            current_paragraphs = []

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        heading = re.match(r"^#{1,3}\s+(.+)$", line)
        if heading:
            title = clean_line(heading.group(1))[:120]
            if title and title != page_title:
                flush()
                current_title = title
            continue

        section_heading = is_section_heading(line)
        if section_heading and section_heading != page_title:
            flush()
            current_title = section_heading
            continue

        text = clean_line(re.sub(r"^(?:[-+*]|\d+[.)])\s+", "", line))
        if len(text) < 2 or text in seen or is_page_chrome(text):
            continue
        if re.search(r"(?:function\s*\(|document\.|window\.|@media|font-family)", text, re.I):
            continue
        seen.add(text)
        current_paragraphs.append(text[:1200])
        if len(current_paragraphs) >= 100:
            flush()
            current_title = "网页正文"
        if sum(len(item) for _, values in sections for item in values) > 24_000:
            break
    flush()

    result: list[ReaderSection] = []
    for title, paragraphs in sections[:100]:
        if not paragraphs:
            continue
        index = len(result) + 1
        result.append(
            ReaderSection(
                id=f"section-{index}",
                eyebrow=f"{index:02d} / 网页内容",
                title=title,
                paragraphs=paragraphs,
            )
        )
    return result


def matching_div_contents(page_html: str, opening_tag: re.Pattern[str]) -> str | None:
    """Return a div body without truncating at nested editor divs."""
    opening = opening_tag.search(page_html)
    if not opening:
        return None
    open_end = page_html.find(">", opening.start())
    if open_end < 0:
        return None

    div_tags = re.compile(r"</?div\b[^>]*>", re.I)
    depth = 1
    for tag in div_tags.finditer(page_html, open_end + 1):
        depth += -1 if tag.group(0).lower().startswith("</div") else 1
        if depth == 0:
            return page_html[open_end + 1:tag.start()]
    return None


def beijing_policy_body_html(page_html: str, source_url: str) -> str | None:
    hostname = (urlparse(source_url).hostname or "").lower()
    if hostname != "www.beijing.gov.cn" and not hostname.endswith(".beijing.gov.cn"):
        return None
    main_text = matching_div_contents(page_html, re.compile(r'<div\b[^>]*\bid=["\']mainText["\'][^>]*>', re.I))
    if not main_text:
        return None
    view = matching_div_contents(main_text, re.compile(r'<div\b[^>]*\bclass=["\'][^"\']*\bview\b[^"\']*["\'][^>]*>', re.I))
    return view or main_text


def article_body_html(page_html: str, source_url: str) -> str | None:
    hostname = (urlparse(source_url).hostname or "").lower()
    if hostname == "mp.weixin.qq.com":
        return matching_div_contents(page_html, re.compile(r'<div\b[^>]*\bid=["\']js_content["\'][^>]*>', re.I))
    return beijing_policy_body_html(page_html, source_url)


def html_body_to_markdown(page_html: str, source_url: str) -> str:
    """Normalize a known public article body returned by the fetcher.

    Crawl4AI remains responsible for the primary rendering path. This only
    scopes known public-page HTML to the visible article body before sectioning.
    """
    body = article_body_html(page_html, source_url)
    if not body:
        return ""
    body = re.sub(r"<!--[\s\S]*?-->", " ", body)
    body = re.sub(r"<(script|style|noscript|template|svg|canvas|form)\b[^>]*>[\s\S]*?</\1>", " ", body, flags=re.I)
    if (urlparse(source_url).hostname or "").lower() == "mp.weixin.qq.com":
        # WeChat articles are frequently built from deeply nested <section>
        # nodes instead of paragraphs. Preserve those visual blocks before
        # stripping markup; otherwise an entire long article becomes one line
        # and is capped to a single 1,200-character reader paragraph.
        body = re.sub(r"</?(?:section|article|h[1-6])\b[^>]*>", "\n", body, flags=re.I)
    body = re.sub(r"<(?:p|li|dt|dd|blockquote|figcaption|tr)\b[^>]*>([\s\S]*?)</(?:p|li|dt|dd|blockquote|figcaption|tr)>", r"\n\1\n", body, flags=re.I)
    body = re.sub(r"<br\s*/?\s*>", "\n", body, flags=re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    body = html.unescape(body)
    return re.sub(r"\n[\t ]+", "\n", body)


@asynccontextmanager
async def lifespan(app: FastAPI):
    crawler = AsyncWebCrawler(
        config=BrowserConfig(
            headless=True,
            verbose=False,
            extra_args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
    )
    await crawler.start()
    app.state.crawler = crawler
    app.state.capacity = asyncio.Semaphore(20)
    yield
    await crawler.close()


app = FastAPI(title="ShengYue Crawl4AI Service", version="1.0.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/crawl", response_model=CrawlResponse)
async def crawl(payload: CrawlRequest) -> CrawlResponse:
    target = str(payload.url)
    assert_public_url(target)
    content_selector = content_selector_for(target)
    run_config = crawler_run_config(content_selector)

    async with app.state.capacity:
        result = await app.state.crawler.arun(url=target, config=run_config)
        # Crawl4AI scopes result.html to css_selector. Make a second Crawl4AI
        # request only for the small amount of source metadata that lives
        # outside the article body, keeping it visible but out of narration.
        metadata_result = None
        if content_selector:
            metadata_result = await app.state.crawler.arun(url=target, config=crawler_run_config())
    if not result.success:
        raise HTTPException(status_code=422, detail=result.error_message or "Crawl4AI 抓取失败。")

    markdown_result = result.markdown
    markdown = (
        # fit_markdown is deliberately more aggressive and can remove later
        # sections from long policy notices. raw_markdown is already scoped by
        # css_selector for known sites and is the lossless Crawl4AI output.
        getattr(markdown_result, "raw_markdown", None)
        or getattr(markdown_result, "fit_markdown", None)
        or str(markdown_result)
    )
    source_url = str(getattr(result, "url", None) or target)
    metadata_html = str(getattr(metadata_result, "html", None) or "") if metadata_result and metadata_result.success else str(getattr(result, "html", None) or "")
    if is_wechat_verification_page(metadata_html, source_url):
        # WeChat can serve a browser-fingerprint challenge to headless
        # Chromium while returning the public article to a normal HTTP client.
        # Do not persist the challenge as a readable document.
        compatible_html = await asyncio.to_thread(fetch_wechat_article_html, source_url)
        if not compatible_html or is_wechat_verification_page(compatible_html, source_url):
            raise HTTPException(status_code=422, detail="微信公众号返回访问验证，暂无法取得文章正文。请在微信中打开后复制正文再导入。")
        metadata_html = compatible_html
    metadata = (metadata_result.metadata if metadata_result and metadata_result.success else result.metadata) or {}
    wechat_title = ""
    if (urlparse(source_url).hostname or "").lower() == "mp.weixin.qq.com":
        title_match = re.search(r'<h1\b[^>]*\bid=["\']activity-name["\'][^>]*>([\s\S]*?)</h1>', metadata_html, re.I)
        wechat_title = clean_line(title_match.group(1)) if title_match else ""
    title = wechat_title or html_meta_content(metadata_html, ["ArticleTitle", "article:title", "og:title"]) or clean_line(str(metadata.get("title") or "")) or urlparse(target).hostname or target
    description = html_meta_content(metadata_html, ["Description", "description", "og:description"]) or clean_line(str(metadata.get("description") or ""))
    # Crawl4AI retrieves and renders the page, but the Markdown conversion can
    # retain utility links that sit beside the article. For known Beijing
    # policy pages, its full rendered HTML lets us deterministically keep only
    # the published `#mainText .view` body before sectioning and TTS.
    beijing_policy_markdown = html_body_to_markdown(metadata_html, source_url)
    if beijing_policy_markdown:
        markdown = beijing_policy_markdown
    sections = markdown_to_sections(markdown, title)
    if not sections and content_selector:
        # When a site's per-block word filter removes all short CJK paragraphs,
        # preserve the selected policy body from Crawl4AI's own rendered HTML.
        sections = markdown_to_sections(html_body_to_markdown(metadata_html, source_url), title)
    if not sections:
        raise HTTPException(status_code=422, detail="网页已打开，但未识别到可阅读正文。")

    display_metadata = extract_display_metadata(metadata_html, source_url)
    word_count = sum(len(section.title) + sum(map(len, section.paragraphs)) for section in sections)
    # 页面 meta description 通常是门户站自动拼出的摘要，会截断、合并
    # 原文段落，不能作为阅读内容展示或朗读。阅读页只使用正文 sections。
    reader_description = ""
    return CrawlResponse(
        title=title,
        description=reader_description,
        sourceUrl=source_url,
        siteName=urlparse(source_url).hostname or "",
        fetchedAt=datetime.now(UTC).isoformat(),
        wordCount=word_count,
        sections=sections,
        displayMetadata=display_metadata,
    )
