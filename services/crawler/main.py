from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from urllib.parse import urlparse

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


class CrawlResponse(BaseModel):
    title: str
    description: str
    sourceUrl: str
    siteName: str
    fetchedAt: str
    wordCount: int
    engine: str = "crawl4ai"
    sections: list[ReaderSection]


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
    value = re.sub(r"[*_`>#|]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def markdown_to_sections(markdown: str, page_title: str) -> list[ReaderSection]:
    sections: list[tuple[str, list[str]]] = []
    current_title = "网页正文"
    current_paragraphs: list[str] = []
    seen: set[str] = set()

    def flush() -> None:
        nonlocal current_paragraphs
        if current_paragraphs:
            sections.append((current_title, current_paragraphs[:12]))
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

        text = clean_line(re.sub(r"^(?:[-+*]|\d+[.)])\s+", "", line))
        if len(text) < 2 or text in seen:
            continue
        if re.search(r"(?:function\s*\(|document\.|window\.|@media|font-family)", text, re.I):
            continue
        seen.add(text)
        current_paragraphs.append(text[:1200])
        if len(current_paragraphs) >= 12:
            flush()
            current_title = "网页正文"
        if sum(len(item) for _, values in sections for item in values) > 24_000:
            break
    flush()

    result: list[ReaderSection] = []
    for title, paragraphs in sections[:14]:
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
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        word_count_threshold=5,
        excluded_tags=["script", "style", "nav", "footer", "form", "noscript"],
        remove_overlay_elements=True,
        process_iframes=False,
        page_timeout=45_000,
    )

    async with app.state.capacity:
        result = await app.state.crawler.arun(url=target, config=run_config)
    if not result.success:
        raise HTTPException(status_code=422, detail=result.error_message or "Crawl4AI 抓取失败。")

    markdown_result = result.markdown
    markdown = (
        getattr(markdown_result, "fit_markdown", None)
        or getattr(markdown_result, "raw_markdown", None)
        or str(markdown_result)
    )
    metadata = result.metadata or {}
    title = clean_line(str(metadata.get("title") or "")) or urlparse(target).hostname or target
    description = clean_line(str(metadata.get("description") or ""))
    sections = markdown_to_sections(markdown, title)
    if not sections:
        raise HTTPException(status_code=422, detail="网页已打开，但未识别到可阅读正文。")

    source_url = str(getattr(result, "url", None) or target)
    word_count = sum(len(section.title) + sum(map(len, section.paragraphs)) for section in sections)
    return CrawlResponse(
        title=title,
        description=description or sections[0].paragraphs[0],
        sourceUrl=source_url,
        siteName=urlparse(source_url).hostname or "",
        fetchedAt=datetime.now(UTC).isoformat(),
        wordCount=word_count,
        sections=sections,
    )
