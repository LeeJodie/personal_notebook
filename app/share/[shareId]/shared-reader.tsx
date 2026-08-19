"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

interface ReaderSection {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: string[];
}

interface ReaderDisplayMetadataItem {
  label: string;
  value: string;
  href?: string | null;
}

interface SharedReaderDocument {
  title: string;
  description: string;
  sourceUrl: string;
  siteName: string;
  fetchedAt: string;
  wordCount: number;
  engine: "crawl4ai" | "server-html-extractor" | "document-processor";
  sections: ReaderSection[];
  displayMetadata?: ReaderDisplayMetadataItem[];
}

export default function SharedReader({ shareId }: { shareId: string }) {
  const [document, setDocument] = useState<SharedReaderDocument | null>(null);
  const [allowDownload, setAllowDownload] = useState(false);
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const speechOffsetRef = useRef(0);
  const speechSessionRef = useRef(0);

  const articleText = useMemo(
    () => document ? [document.title, ...document.sections.flatMap((section) => [section.title, ...section.paragraphs])].join("。") : "",
    [document],
  );

  useEffect(() => {
    const loadShare = async () => {
      try {
        const response = await fetch(`/v1/public/shares/${encodeURIComponent(shareId)}`, { cache: "no-store" });
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

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const speakFromOffset = (requestedOffset: number) => {
    if (!("speechSynthesis" in window) || !articleText) return;
    const offset = requestedOffset >= articleText.length ? 0 : Math.max(0, requestedOffset);
    const session = speechSessionRef.current + 1;
    speechSessionRef.current = session;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(articleText.slice(offset));
    utterance.lang = "zh-CN";
    utterance.onboundary = (event) => { if (speechSessionRef.current === session) speechOffsetRef.current = Math.min(articleText.length, offset + event.charIndex); };
    utterance.onend = () => { if (speechSessionRef.current === session) { speechOffsetRef.current = articleText.length; setSpeaking(false); } };
    utterance.onerror = () => { if (speechSessionRef.current === session) setSpeaking(false); };
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  const playSpeech = () => {
    if (speaking) {
      speechSessionRef.current += 1;
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    speakFromOffset(speechOffsetRef.current);
  };

  const downloadH5 = () => window.location.assign(`/v1/public/shares/${encodeURIComponent(shareId)}/artifacts/h5`);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.assign("/");
  };

  if (error) return <main className="share-status-page"><button className="shared-status-back" onClick={goBack}>‹ 返回</button><p className="share-brand">声阅</p><h1>这份分享无法打开</h1><p>{error}</p></main>;
  if (!document) return <main className="share-status-page"><button className="shared-status-back" onClick={goBack}>‹ 返回</button><p className="share-brand">声阅</p><h1>正在打开阅读页…</h1></main>;

  return (
    <main className="shared-reader-page">
      <header className="shared-reader-header"><button className="shared-back-button" onClick={goBack} aria-label="返回上一页">‹</button><Link href="/" className="share-brand">声阅</Link><span>分享阅读页 · 仅供阅读</span></header>
      <article className="shared-reader-article">
        <p className="shared-reader-meta">{document.siteName} · 由声阅转换</p>
        <h1>{document.title}</h1>
        <p className="shared-reader-deck">{document.description}</p>
        {document.displayMetadata?.length ? <dl className="source-metadata" aria-label="来源文件信息">{document.displayMetadata.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd>{item.href ? <a href={item.href} target="_blank" rel="noreferrer">{item.value}</a> : item.value}</dd></div>)}</dl> : null}
        {document.sections.map((section) => <section key={section.id}><p className="shared-section-eyebrow">{section.eyebrow}</p><h2>{section.title}</h2>{section.paragraphs.map((paragraph, index) => <p key={`${section.id}-${index}`}>{paragraph}</p>)}</section>)}
      </article>
      <div className="shared-reader-player"><button onClick={playSpeech}>{speaking ? "Ⅱ 停止朗读" : "▶ 开始朗读"}</button><span className="shared-default-voice">系统默认语音</span>{allowDownload && <button className="shared-download" onClick={downloadH5}>↓ 下载 H5</button>}</div>
    </main>
  );
}
