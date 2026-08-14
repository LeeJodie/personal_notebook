"use client";

import { useEffect, useMemo, useState } from "react";

interface ReaderSection {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: string[];
}

interface SharedReaderDocument {
  title: string;
  description: string;
  sourceUrl: string;
  siteName: string;
  fetchedAt: string;
  wordCount: number;
  engine: "demo" | "crawl4ai" | "server-html-extractor";
  sections: ReaderSection[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}

export default function SharedReader({ shareId }: { shareId: string }) {
  const [document, setDocument] = useState<SharedReaderDocument | null>(null);
  const [allowDownload, setAllowDownload] = useState(false);
  const [error, setError] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);

  const articleText = useMemo(
    () => document ? [document.title, document.description, ...document.sections.flatMap((section) => [section.title, ...section.paragraphs])].join("。") : "",
    [document],
  );

  useEffect(() => {
    const loadShare = async () => {
      try {
        const response = await fetch(`/api/shares/${encodeURIComponent(shareId)}`);
        const result = await response.json() as { reader?: SharedReaderDocument; allow_download?: boolean; message?: string };
        if (!response.ok || !result.reader) throw new Error(result.message || "无法打开这份分享。");
        setDocument(result.reader);
        setAllowDownload(Boolean(result.allow_download));
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "无法打开这份分享。");
      }
    };
    void loadShare();
  }, [shareId]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const loadVoices = () => {
      const available = [...window.speechSynthesis.getVoices()].sort((a, b) => Number(b.lang.startsWith("zh")) - Number(a.lang.startsWith("zh")));
      setVoices(available);
      if (!voiceName && available.length) setVoiceName(available[0].name);
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [voiceName]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const playSpeech = () => {
    if (!("speechSynthesis" in window) || !articleText) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(articleText);
    utterance.lang = "zh-CN";
    utterance.voice = voices.find((voice) => voice.name === voiceName) || null;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  const downloadH5 = () => {
    if (!document) return;
    const sections = document.sections.map((section) => `<section><p class="eyebrow">${escapeHtml(section.eyebrow)}</p><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`).join("");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title)}</title><style>body{margin:0;background:#f5f5f1;color:#20221d;font:17px/1.9 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:72px 24px 120px}h1{font-size:42px;line-height:1.2}h2{font-size:28px;line-height:1.35;margin-top:56px}.deck{color:#6f756b;font-size:19px}.eyebrow{color:#e25d3f;font-size:12px;font-weight:700;letter-spacing:.12em}</style></head><body><main><p class="eyebrow">声阅 · 分享阅读</p><h1>${escapeHtml(document.title)}</h1><p class="deck">${escapeHtml(document.description)}</p>${sections}</main></body></html>`;
    const href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = window.document.createElement("a");
    link.href = href;
    link.download = `${document.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "声阅阅读页"}.html`;
    link.click();
    URL.revokeObjectURL(href);
  };

  if (error) return <main className="share-status-page"><p className="share-brand">声阅</p><h1>这份分享无法打开</h1><p>{error}</p></main>;
  if (!document) return <main className="share-status-page"><p className="share-brand">声阅</p><h1>正在打开阅读页…</h1></main>;

  return (
    <main className="shared-reader-page">
      <header className="shared-reader-header"><a href="/" className="share-brand">声阅</a><span>分享阅读页 · 仅供阅读</span></header>
      <article className="shared-reader-article">
        <p className="shared-reader-meta">{document.siteName} · 由声阅转换</p>
        <h1>{document.title}</h1>
        <p className="shared-reader-deck">{document.description}</p>
        {document.sections.map((section) => <section key={section.id}><p className="shared-section-eyebrow">{section.eyebrow}</p><h2>{section.title}</h2>{section.paragraphs.map((paragraph, index) => <p key={`${section.id}-${index}`}>{paragraph}</p>)}</section>)}
      </article>
      <div className="shared-reader-player"><button onClick={playSpeech}>{speaking ? "Ⅱ 停止朗读" : "▶ 开始朗读"}</button><label>音色<select value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>{voices.length ? voices.slice(0, 12).map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>) : <option>系统默认音色</option>}</select></label>{allowDownload && <button className="shared-download" onClick={downloadH5}>↓ 下载 H5</button>}</div>
    </main>
  );
}
