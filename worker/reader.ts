export type ReaderEngine = "crawl4ai" | "server-html-extractor" | "document-processor";

export interface ReaderSection {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: string[];
}

export interface ReaderDisplayMetadataItem {
  label: string;
  value: string;
  href?: string | null;
}

export interface ReaderDocument {
  title: string;
  description: string;
  sourceUrl: string;
  siteName: string;
  fetchedAt: string;
  wordCount: number;
  engine: ReaderEngine;
  sections: ReaderSection[];
  // Publication facts and source downloads are displayed separately from the
  // article, and are never included in the narration payload.
  displayMetadata?: ReaderDisplayMetadataItem[];
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}

export function createH5(document: ReaderDocument): string {
  const sections = document.sections.map((section) => `<section><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`).join("");
  const displayMetadata = (document.displayMetadata || []).map((item) => {
    const value = item.href ? `<a href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">${escapeHtml(item.value)}</a>` : escapeHtml(item.value);
    return `<div><dt>${escapeHtml(item.label)}</dt><dd>${value}</dd></div>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title)}</title><style>body{margin:0;background:#f5f5f1;color:#20221d;font:17px/1.9 system-ui,-apple-system,sans-serif}main{max-width:780px;margin:auto;padding:72px 24px 140px}h1{font-size:42px;line-height:1.2}h2{font-size:28px;line-height:1.35;margin-top:56px}.deck{color:#6f756b;font-size:19px}.eyebrow{color:#e25d3f;font-size:12px;font-weight:700;letter-spacing:.12em}.source-metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:28px 0;padding:16px;border:1px solid #e1e2dc;border-radius:12px;background:#fafaf7}.source-metadata div{min-width:0}.source-metadata dt{color:#737970;font-size:12px}.source-metadata dd{margin:2px 0 0;color:#30342e;font-size:14px;word-break:break-word}.source-metadata a{color:#b54732}.player{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:#20221d;color:white;padding:12px 18px;border-radius:18px;box-shadow:0 12px 40px #0003}.player button,.player select{border:0;border-radius:10px;padding:10px 14px}</style></head><body><main><p class="eyebrow">声阅 · 智能阅读</p>${displayMetadata ? `<dl class="source-metadata" aria-label="文件信息">${displayMetadata}</dl>` : ""}<div data-speech-content><h1>${escapeHtml(document.title)}</h1><p class="deck">${escapeHtml(document.description)}</p>${sections}</div></main><div class="player"><button id="play">▶ 开始播放</button><select id="voices" aria-label="选择音色"></select></div><script>const text=document.querySelector('[data-speech-content]').innerText,v=document.querySelector('#voices'),b=document.querySelector('#play');function load(){const a=speechSynthesis.getVoices();v.innerHTML=a.map((x,i)=>'<option value="'+i+'">'+x.name+' · '+x.lang+'</option>').join('');}load();speechSynthesis.onvoiceschanged=load;b.onclick=()=>{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text),a=speechSynthesis.getVoices();u.voice=a[v.value]||null;u.lang='zh-CN';speechSynthesis.speak(u);};</script></body></html>`;
}

export function createMarkdownReader(markdown: string, title: string, sourceUrl = "", uploadedSiteName = "上传的 Markdown 文档"): ReaderDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  let current: { title: string; paragraphs: string[] } = { title: "正文", paragraphs: [] };
  let buffer: string[] = [];
  const flushParagraph = () => {
    const paragraph = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (paragraph) current.paragraphs.push(paragraph);
    buffer = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.paragraphs.length) sections.push(current);
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flushSection();
      current = { title: heading[1].replace(/[*_`]/g, "").trim(), paragraphs: [] };
      continue;
    }
    if (!line) {
      flushParagraph();
      continue;
    }
    buffer.push(line.replace(/^[-*+]\s+/, "• ").replace(/[*_`]/g, ""));
  }
  flushSection();
  const usable = sections.filter((section) => section.title || section.paragraphs.length).slice(0, 100);
  if (!usable.length) usable.push({ title: "正文", paragraphs: ["未能从该 Markdown 文件中提取到正文。"] });
  const normalized = usable.map((section, index) => ({
    id: `section-${index + 1}`,
    eyebrow: `${String(index + 1).padStart(2, "0")} / 文档内容`,
    title: section.title || `第 ${index + 1} 节`,
    paragraphs: section.paragraphs,
  }));
  const wordCount = normalized.reduce((sum, section) => sum + section.title.length + section.paragraphs.join("").length, 0);
  return {
    title,
    description: normalized[0]?.paragraphs[0]?.slice(0, 240) || "Markdown 文档阅读页",
    sourceUrl,
    siteName: sourceUrl ? new URL(sourceUrl).hostname : uploadedSiteName,
    fetchedAt: new Date().toISOString(),
    wordCount,
    engine: "document-processor",
    sections: normalized,
  };
}

export function isReaderDocument(value: unknown): value is ReaderDocument {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.title === "string" && typeof input.description === "string" && typeof input.siteName === "string" &&
    typeof input.wordCount === "number" && typeof input.engine === "string" && Array.isArray(input.sections) && input.sections.length > 0;
}
