from __future__ import annotations

import asyncio
import html
import ipaddress
import re
import socket
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from urllib.parse import urljoin, urlparse

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
        word_count_threshold=5,
        excluded_tags=["script", "style", "nav", "footer", "form", "noscript"],
        remove_overlay_elements=True,
        process_iframes=False,
        page_timeout=45_000,
        css_selector=css_selector,
    )


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
    if bold:
        return candidate
    # Government documents frequently represent chapter titles as bold <p>
    # rather than h2 elements. Crawl4AI faithfully keeps the text but not that
    # semantic tag, so restore the chapter boundary from the numbering.
    if re.match(r"^(?:第[一二三四五六七八九十百零〇\d]+[章节]|[一二三四五六七八九十百零〇\d]+、)", candidate):
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
        if len(text) < 2 or text in seen:
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
    metadata = (metadata_result.metadata if metadata_result and metadata_result.success else result.metadata) or {}
    title = html_meta_content(metadata_html, ["ArticleTitle", "article:title", "og:title"]) or clean_line(str(metadata.get("title") or "")) or urlparse(target).hostname or target
    description = html_meta_content(metadata_html, ["Description", "description", "og:description"]) or clean_line(str(metadata.get("description") or ""))
    sections = markdown_to_sections(markdown, title)
    if not sections:
        raise HTTPException(status_code=422, detail="网页已打开，但未识别到可阅读正文。")

    display_metadata = extract_display_metadata(metadata_html, source_url)
    word_count = sum(len(section.title) + sum(map(len, section.paragraphs)) for section in sections)
    return CrawlResponse(
        title=title,
        description=description or sections[0].paragraphs[0],
        sourceUrl=source_url,
        siteName=urlparse(source_url).hostname or "",
        fetchedAt=datetime.now(UTC).isoformat(),
        wordCount=word_count,
        sections=sections,
        displayMetadata=display_metadata,
    )
