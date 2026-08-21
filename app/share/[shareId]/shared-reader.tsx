"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

interface ReaderSection { id: string; eyebrow: string; title: string; paragraphs: string[]; }
interface ReaderDisplayMetadataItem { label: string; value: string; href?: string | null; }
interface SharedReaderDocument {
  title: string; description: string; sourceUrl: string; siteName: string; fetchedAt: string; wordCount: number;
  engine: "crawl4ai" | "server-html-extractor" | "document-processor"; sections: ReaderSection[]; displayMetadata?: ReaderDisplayMetadataItem[];
}
interface PrivateTtsVoice { id: string; label: string; language: string; }
interface MeloAudioSegment { offset: number; text: string; url: string; }

const MELOTTS_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const SEGMENT_TARGET_CHARS = 110;
const SEGMENT_MAX_CHARS = 180;

function findBoundary(text: string, from: number, to: number, punctuation: string, reverse = false): number | null {
  if (reverse) { for (let index = to - 1; index >= from; index -= 1) if (punctuation.includes(text[index])) return index + 1; return null; }
  for (let index = from; index < to; index += 1) if (punctuation.includes(text[index])) return index + 1;
  return null;
}

function nextMeloTextSegment(text: string, offset: number): { offset: number; text: string } | null {
  if (offset >= text.length) return null;
  const maxEnd = Math.min(text.length, offset + SEGMENT_MAX_CHARS);
  const targetEnd = Math.min(maxEnd, offset + SEGMENT_TARGET_CHARS);
  const minEnd = Math.min(maxEnd, offset + 12);
  const sentenceEnd = "。！？!?；;.";
  const clauseEnd = "，,、：:\n";
  const end = findBoundary(text, targetEnd, maxEnd, sentenceEnd)
    || findBoundary(text, targetEnd, maxEnd, clauseEnd)
    || findBoundary(text, minEnd, maxEnd, `${sentenceEnd}${clauseEnd}`, true);
  return { offset, text: text.slice(offset, end || maxEnd) };
}

export default function SharedReader({ shareId }: { shareId: string }) {
  const [document, setDocument] = useState<SharedReaderDocument | null>(null);
  const [allowDownload, setAllowDownload] = useState(false);
  const [error, setError] = useState("");
  const [ttsError, setTtsError] = useState("");
  const [voices, setVoices] = useState<PrivateTtsVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState("");
  const [speed, setSpeed] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const speechOffsetRef = useRef(0);
  const speechSessionRef = useRef(0);
  const activeAudioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const requestControllersRef = useRef(new Set<AbortController>());
  const prefetchRef = useRef<{ session: number; offset: number; voiceId: string; speed: number; promise: Promise<MeloAudioSegment | null> } | null>(null);

  const articleText = useMemo(
    () => document ? [document.title, ...document.sections.flatMap((section) => [section.title, ...section.paragraphs])].join("。").replace(/https?:\/\/[^\s<>]+/gi, "。") : "",
    [document],
  );
  const selectedVoiceLabel = voices.find((voice) => voice.id === selectedVoice)?.label || "MeloTTS 音色准备中";

  const cancelRequests = () => {
    for (const controller of requestControllersRef.current) controller.abort();
    requestControllersRef.current.clear();
    const prefetched = prefetchRef.current;
    prefetchRef.current = null;
    if (prefetched) void prefetched.promise.then((segment) => { if (segment) URL.revokeObjectURL(segment.url); }).catch(() => undefined);
  };
  const clearAudio = () => {
    const active = activeAudioRef.current;
    activeAudioRef.current = null;
    if (!active) return;
    active.audio.onended = null; active.audio.onerror = null; active.audio.pause(); active.audio.removeAttribute("src"); active.audio.load();
    URL.revokeObjectURL(active.url);
  };
  const stopSpeech = () => { speechSessionRef.current += 1; cancelRequests(); clearAudio(); setSpeaking(false); setSynthesizing(false); };

  useEffect(() => {
    const loadShare = async () => {
      try {
        const response = await fetch(`/v1/public/shares/${encodeURIComponent(shareId)}`, { cache: "no-store" });
        const result = await response.json() as { reader?: SharedReaderDocument; allow_download?: boolean; message?: string };
        if (!response.ok || !result.reader) throw new Error(result.message || "无法打开这份分享。");
        setDocument(result.reader); setAllowDownload(Boolean(result.allow_download));
      } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "无法打开这份分享。"); }
    };
    void loadShare();
  }, [shareId]);

  useEffect(() => {
    if (!document) return;
    let active = true;
    fetch(`/v1/public/shares/${encodeURIComponent(shareId)}/tts/voices`, { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as { items?: PrivateTtsVoice[]; message?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok || !Array.isArray(result.items) || !result.items.length) throw new Error(result.message || "私有 MeloTTS 暂不可用。");
        setVoices(result.items); setSelectedVoice((current) => result.items?.some((voice) => voice.id === current) ? current : result.items?.[0]?.id || ""); setTtsError("");
      })
      .catch((reason) => { if (active) setTtsError(reason instanceof Error ? reason.message : "私有 MeloTTS 暂不可用。"); });
    return () => { active = false; };
  }, [document, shareId]);
  useEffect(() => () => { stopSpeech(); }, []);

  const fetchMeloSegment = async (offset: number, voiceId: string, playbackSpeed: number, session: number): Promise<MeloAudioSegment | null> => {
    const segment = nextMeloTextSegment(articleText, offset);
    if (!segment?.text || session !== speechSessionRef.current) return null;
    const controller = new AbortController(); requestControllersRef.current.add(controller);
    try {
      const response = await fetch(`/v1/public/shares/${encodeURIComponent(shareId)}/tts/synthesize`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: segment.text, voice_id: voiceId, speed: playbackSpeed }), signal: controller.signal,
      });
      if (!response.ok) { const result = await response.json().catch(() => ({})) as { message?: string }; throw new Error(result.message || "MeloTTS 合成失败。"); }
      const url = URL.createObjectURL(await response.blob());
      return session === speechSessionRef.current ? { ...segment, url } : (URL.revokeObjectURL(url), null);
    } finally { requestControllersRef.current.delete(controller); }
  };
  const prefetchNextSegment = (offset: number, voiceId: string, playbackSpeed: number, session: number) => {
    if (offset >= articleText.length || session !== speechSessionRef.current) return;
    const current = prefetchRef.current;
    if (current?.session === session && current.offset === offset && current.voiceId === voiceId && current.speed === playbackSpeed) return;
    const promise = fetchMeloSegment(offset, voiceId, playbackSpeed, session); void promise.catch(() => undefined);
    prefetchRef.current = { session, offset, voiceId, speed: playbackSpeed, promise };
  };
  const playMeloSegment = async (offset: number, voiceId: string, playbackSpeed: number, session: number, prepared?: MeloAudioSegment | null) => {
    try {
      setSynthesizing(!prepared);
      const segment = prepared || await fetchMeloSegment(offset, voiceId, playbackSpeed, session);
      if (!segment || session !== speechSessionRef.current) return;
      setSynthesizing(false); clearAudio();
      const audio = new Audio(segment.url); activeAudioRef.current = { audio, url: segment.url };
      const nextOffset = Math.min(articleText.length, offset + segment.text.length);
      prefetchNextSegment(nextOffset, voiceId, playbackSpeed, session);
      audio.onended = () => {
        if (session !== speechSessionRef.current) return;
        if (activeAudioRef.current?.audio === audio) activeAudioRef.current = null;
        URL.revokeObjectURL(segment.url); speechOffsetRef.current = nextOffset;
        if (nextOffset >= articleText.length) { setSpeaking(false); setSynthesizing(false); return; }
        const prefetched = prefetchRef.current; prefetchRef.current = null;
        if (prefetched?.session === session && prefetched.offset === nextOffset && prefetched.voiceId === voiceId && prefetched.speed === playbackSpeed) {
          void prefetched.promise.then((next) => playMeloSegment(nextOffset, voiceId, playbackSpeed, session, next)).catch(() => playMeloSegment(nextOffset, voiceId, playbackSpeed, session));
        } else void playMeloSegment(nextOffset, voiceId, playbackSpeed, session);
      };
      audio.onerror = () => { if (session === speechSessionRef.current) { setSpeaking(false); setSynthesizing(false); setTtsError("音频播放失败，请重新开始朗读。"); } };
      await audio.play();
    } catch (reason) {
      if (session !== speechSessionRef.current) return;
      setSpeaking(false); setSynthesizing(false); setTtsError(reason instanceof Error ? reason.message : "MeloTTS 暂不可用。");
    }
  };
  const startSpeech = (requestedOffset: number, voiceId = selectedVoice, playbackSpeed = speed) => {
    if (!articleText || !voiceId) { setTtsError("MeloTTS 音色尚未就绪，请稍后再试。"); return; }
    const offset = requestedOffset >= articleText.length ? 0 : Math.max(0, requestedOffset);
    stopSpeech(); const session = speechSessionRef.current + 1; speechSessionRef.current = session; speechOffsetRef.current = offset;
    setTtsError(""); setSpeaking(true); setSynthesizing(true); void playMeloSegment(offset, voiceId, playbackSpeed, session);
  };
  const changeVoice = (voiceId: string) => { if (!voiceId || voiceId === selectedVoice) return; const offset = speechOffsetRef.current; const resume = speaking; setSelectedVoice(voiceId); if (resume) startSpeech(offset, voiceId, speed); };
  const changeSpeed = (nextSpeed: number) => { if (nextSpeed === speed) return; const offset = speechOffsetRef.current; const resume = speaking; setSpeed(nextSpeed); if (resume) startSpeech(offset, selectedVoice, nextSpeed); };
  const playSpeech = () => speaking ? stopSpeech() : startSpeech(speechOffsetRef.current);
  const downloadH5 = () => window.location.assign(`/v1/public/shares/${encodeURIComponent(shareId)}/artifacts/h5`);
  const goBack = () => { if (window.history.length > 1) window.history.back(); else window.location.assign("/"); };

  if (error) return <main className="share-status-page"><button className="shared-status-back" onClick={goBack}>‹ 返回</button><p className="share-brand">声阅</p><h1>这份分享无法打开</h1><p>{error}</p></main>;
  if (!document) return <main className="share-status-page"><button className="shared-status-back" onClick={goBack}>‹ 返回</button><p className="share-brand">声阅</p><h1>正在打开阅读页…</h1></main>;
  return <main className="shared-reader-page">
    <header className="shared-reader-header"><button className="shared-back-button" onClick={goBack} aria-label="返回上一页">‹</button><Link href="/" className="share-brand">声阅</Link><span>分享阅读页 · 仅供阅读</span></header>
    <article className="shared-reader-article"><p className="shared-reader-meta">{document.siteName} · 由声阅转换</p><h1>{document.title}</h1><p className="shared-reader-deck">{document.description}</p>{document.displayMetadata?.length ? <dl className="source-metadata" aria-label="来源文件信息">{document.displayMetadata.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd>{item.href ? <a href={item.href} target="_blank" rel="noreferrer">{item.value}</a> : item.value}</dd></div>)}</dl> : null}{document.sections.map((section) => <section key={section.id}><h2>{section.title}</h2>{section.paragraphs.map((paragraph, index) => <p key={`${section.id}-${index}`}>{paragraph}</p>)}</section>)}</article>
    <div className="shared-reader-player"><button onClick={playSpeech} disabled={!voices.length}>{speaking ? "Ⅱ 停止" : synthesizing ? "正在准备…" : "▶ 朗读"}</button><label><span>音色</span><select value={selectedVoice} onChange={(event) => changeVoice(event.target.value)} disabled={!voices.length}>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label><label className="shared-speed-select"><span>倍速</span><select value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}>{MELOTTS_SPEED_OPTIONS.map((option) => <option key={option} value={option}>{option.toFixed(option % 1 ? 2 : 1)}×</option>)}</select></label>{allowDownload && <button className="shared-download" onClick={downloadH5}>↓ H5</button>}{ttsError && <span className="shared-tts-error" role="alert">{ttsError}</span>}<span className="shared-voice-status">{voices.length ? `MeloTTS · ${selectedVoiceLabel}` : "正在连接私有 MeloTTS"}</span></div>
  </main>;
}
