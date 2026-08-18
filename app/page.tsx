"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";

type View = "create" | "processing" | "reader" | "library" | "history" | "api";
type SourceType = "file" | "url";
type MobileEntryMode = "file" | "url" | "clipboard";
type LocalAuthMode = "signin" | "register";
type TtsPlaybackState = "idle" | "synthesizing" | "playing";

interface ReaderSection {
  id: string;
  eyebrow: string;
  title: string;
  paragraphs: string[];
}

interface ReaderDocument {
  documentId?: string;
  title: string;
  description: string;
  sourceUrl: string;
  siteName: string;
  fetchedAt: string;
  wordCount: number;
  engine: "demo" | "crawl4ai" | "server-html-extractor" | "document-processor";
  sections: ReaderSection[];
}

interface StoredDocument {
  id: string;
  title: string;
  source_type: "upload" | "url";
  source_url: string | null;
  filename: string | null;
  media_type: string | null;
  size_bytes: number | null;
  status: "queued" | "parsing" | "ready" | "failed" | "deleting";
  progress: number;
  word_count: number;
  updated_at: string;
  error_message: string | null;
}

interface SearchHit {
  document_id: string;
  document_title: string;
  chunk_id: string;
  text: string;
  heading_path: string[];
}

interface AuthUser {
  id: string;
  tenant_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  auth_mode: "platform" | "local";
}

interface PrivateTtsVoice {
  id: string;
  label: string;
  language: string;
}

interface MeloAudioSegment {
  offset: number;
  text: string;
  audioBuffer: AudioBuffer;
}

const supportedExtensions = ["DOCX", "MD", "TXT", "XLSX", "PDF"];
// CPU TTS returns a complete WAV rather than a stream. Start with the first
// complete short sentence, then prefetch semantically bounded medium segments.
const MELOTTS_INITIAL_TARGET_CHARS = 42;
const MELOTTS_INITIAL_MAX_CHARS = 86;
const MELOTTS_SEGMENT_TARGET_CHARS = 110;
const MELOTTS_SEGMENT_MAX_CHARS = 180;
const WEB_ADDRESS_PATTERN = /^(https?:\/\/)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

function isWebAddress(value: string): boolean {
  return WEB_ADDRESS_PATTERN.test(value.trim());
}

function findBoundary(text: string, from: number, to: number, punctuation: string, reverse = false): number | null {
  if (reverse) {
    for (let index = to - 1; index >= from; index -= 1) if (punctuation.includes(text[index])) return index + 1;
    return null;
  }
  for (let index = from; index < to; index += 1) if (punctuation.includes(text[index])) return index + 1;
  return null;
}

function nextMeloTextSegment(text: string, offset: number, preferFastStart: boolean): { offset: number; text: string } | null {
  if (offset >= text.length) return null;
  const target = preferFastStart ? MELOTTS_INITIAL_TARGET_CHARS : MELOTTS_SEGMENT_TARGET_CHARS;
  const max = preferFastStart ? MELOTTS_INITIAL_MAX_CHARS : MELOTTS_SEGMENT_MAX_CHARS;
  const maxEnd = Math.min(text.length, offset + max);
  const minEnd = Math.min(maxEnd, offset + 12);
  const targetEnd = Math.min(maxEnd, offset + target);
  const sentenceEnd = "。！？!?；;.";
  const clauseEnd = "，,、：:\n";
  let end: number | null = null;

  if (preferFastStart) {
    // The first complete phrase beats a larger batch: it minimizes the time
    // before the listener hears the private voice.
    end = findBoundary(text, minEnd, maxEnd, sentenceEnd) || findBoundary(text, minEnd, maxEnd, clauseEnd);
  } else {
    // Prefer a sentence ending after the target length. A long sentence falls
    // back to a clause break; a hard cut is only for unpunctuated OCR content.
    end = findBoundary(text, targetEnd, maxEnd, sentenceEnd)
      || findBoundary(text, targetEnd, maxEnd, clauseEnd)
      || findBoundary(text, minEnd, maxEnd, `${sentenceEnd}${clauseEnd}`, true);
  }
  return { offset, text: text.slice(offset, end || maxEnd) };
}

const demoDocument: ReaderDocument = {
  title: "智能阅读项目建设方案",
  description: "从内容导入、结构化处理到语音阅读与私有知识库，构建一套稳定、可扩展的企业级内容阅读平台。",
  sourceUrl: "",
  siteName: "声阅阅读示例",
  fetchedAt: "2026-08-14T00:00:00.000Z",
  wordCount: 628,
  engine: "demo",
  sections: [
  {
    id: "overview",
    eyebrow: "01 / 项目概述",
    title: "从静态文档到可听、可搜索的知识",
    paragraphs: [
      "企业中的知识往往分散在网页、PDF、演示文稿和电子表格里。声阅将这些不同的内容统一转换为结构化网页，保留标题、段落、表格与图片的阅读层次。",
      "转换完成后，用户可以像阅读杂志一样浏览，也可以一键连续收听。原文件与 H5 成品会作为同一份资料的两种交付形式。",
    ],
  },
  {
    id: "workflow",
    eyebrow: "02 / 处理流程",
    title: "一次导入，自动完成六步处理",
    paragraphs: [
      "系统先校验文件类型与安全性，再进行内容解析、版面归一化、语义分块和索引构建。网页链接由 Crawl4AI 抓取主体内容，文档则按各自的解析管线处理。",
      "所有任务都进入异步队列，因此即使在高并发时，上传接口也能快速返回任务编号。前端通过事件流接收实时进度，不需要频繁轮询。",
    ],
  },
  {
    id: "security",
    eyebrow: "03 / 数据隔离",
    title: "每个用户，都有独立的知识边界",
    paragraphs: [
      "资料、转换结果、分块和向量记录全部带有 tenant_id 与 user_id。查询必须在服务端强制注入租户条件，而不是依赖前端传参。",
      "对象存储使用租户级路径与短时签名链接，向量库使用强制 metadata filter。删除一份资料时，原文件、H5、分块、向量与音频缓存会被同步清理。",
    ],
  },
  ],
};

function Wordmark() {
  return (
    <div className="wordmark" aria-label="声阅">
      <span className="logo-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>声阅</span>
    </div>
  );
}

function AppIcon({ name }: { name: "plus" | "book" | "clock" | "code" | "arrow" | "upload" | "link" | "file" | "lock" | "download" | "play" | "pause" | "check" | "share" | "copy" | "close" }) {
  const map = {
    plus: "+", book: "▦", clock: "◷", code: "</>", arrow: "↗", upload: "↑", link: "∞", file: "▤", lock: "◈", download: "↓", play: "▶", pause: "Ⅱ", check: "✓", share: "↗", copy: "⧉", close: "×",
  };
  return <span className={`app-icon icon-${name}`} aria-hidden="true">{map[name]}</span>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}

export default function Home() {
  const [view, setView] = useState<View>("create");
  const [viewHistory, setViewHistory] = useState<View[]>([]);
  const [sourceType, setSourceType] = useState<SourceType>("file");
  const [mobileEntryMode, setMobileEntryMode] = useState<MobileEntryMode>("file");
  const [url, setUrl] = useState("");
  const [clipboardContent, setClipboardContent] = useState("");
  const [urlError, setUrlError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processingName, setProcessingName] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [privateTtsVoices, setPrivateTtsVoices] = useState<PrivateTtsVoice[]>([]);
  const [ttsProvider, setTtsProvider] = useState<"browser" | "melotts">("melotts");
  const [speaking, setSpeaking] = useState(false);
  const [ttsPlaybackState, setTtsPlaybackState] = useState<TtsPlaybackState>("idle");
  const [speechProgress, setSpeechProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [readerDocument, setReaderDocument] = useState<ReaderDocument>(demoDocument);
  const [isCrawling, setIsCrawling] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [processingError, setProcessingError] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [shareId, setShareId] = useState("");
  const [shareExpiresAt, setShareExpiresAt] = useState("");
  const [shareTtlHours, setShareTtlHours] = useState(168);
  const [shareAllowDownload, setShareAllowDownload] = useState(true);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [mobileReaderMenuOpen, setMobileReaderMenuOpen] = useState(false);
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const [phoneToBind, setPhoneToBind] = useState("");
  const [phoneBinding, setPhoneBinding] = useState(false);
  const [phoneBindingError, setPhoneBindingError] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [storedDocuments, setStoredDocuments] = useState<StoredDocument[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [localDevelopment, setLocalDevelopment] = useState(false);
  const [signInUrl, setSignInUrl] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [localAuthMode, setLocalAuthMode] = useState<LocalAuthMode>("signin");
  const [loginPhone, setLoginPhone] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPasswordConfirmation, setLoginPasswordConfirmation] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const privateProgressFrameRef = useRef<number | null>(null);
  const meloRequestControllersRef = useRef(new Set<AbortController>());
  const meloPrefetchRef = useRef<{ session: number; offset: number; promise: Promise<MeloAudioSegment | null> } | null>(null);
  const speechOffsetRef = useRef(0);
  const speechSessionRef = useRef(0);
  const crawlAbortRef = useRef<AbortController | null>(null);
  const processingSessionRef = useRef(0);

  const articleText = useMemo(
    () => [readerDocument.title, readerDocument.description, ...readerDocument.sections.flatMap((section) => [section.title, ...section.paragraphs])]
      .join("。")
      // Source links are useful to display but have no useful spoken form.
      .replace(/https?:\/\/[^\s<>]+/gi, "。")
      .replace(/\s+/g, " "),
    [readerDocument],
  );
  const isMeloSynthesizing = speaking && ttsProvider === "melotts" && ttsPlaybackState === "synthesizing";

  const cancelMeloRequests = () => {
    for (const controller of meloRequestControllersRef.current) controller.abort();
    meloRequestControllersRef.current.clear();
    meloPrefetchRef.current = null;
  };

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      const chineseFirst = [...available].sort((a, b) => Number(b.lang.startsWith("zh")) - Number(a.lang.startsWith("zh")));
      setVoices(chineseFirst);
      if (!voiceName && chineseFirst.length) setVoiceName(chineseFirst[0].name);
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [voiceName]);

  useEffect(() => {
    if (view !== "processing" || sourceType !== "url" || !isCrawling) return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        return Math.min(current + (current < 55 ? 7 : current < 78 ? 3 : 1), 88);
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [view, sourceType, isCrawling]);

  useEffect(() => () => {
    window.speechSynthesis?.cancel();
    cancelMeloRequests();
    audioSourceRef.current?.stop();
    audioContextRef.current?.close();
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/v1/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((result: { authenticated?: boolean; user?: AuthUser | null; local_development?: boolean; sign_in_url?: string | null }) => {
        if (!active) return;
        const authenticatedUser = result.authenticated && result.user ? result.user : null;
        setCurrentUser(authenticatedUser);
        setLibraryLoading(Boolean(authenticatedUser));
        setLibraryError("");
        setLocalDevelopment(Boolean(result.local_development));
        setSignInUrl(result.sign_in_url || "");
        setAuthReady(true);
      })
      .catch(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const ttsUserId = currentUser?.id;
    if (!ttsUserId) return;
    let active = true;
    fetch("/v1/tts/voices", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as { items?: PrivateTtsVoice[] } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok || !Array.isArray(result.items) || !result.items.length) {
          setTtsProvider("browser");
          return;
        }
        setPrivateTtsVoices(result.items);
        setTtsProvider("melotts");
      })
      .catch(() => { if (active) setTtsProvider("browser"); });
    return () => { active = false; };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;
    let active = true;
    fetch("/v1/documents", { cache: "no-store" })
      .then(async (response) => ({ response, result: await response.json() as { items?: StoredDocument[]; message?: string } }))
      .then(({ response, result }) => {
        if (!active) return;
        if (!response.ok || !Array.isArray(result.items)) throw new Error(result.message || "知识库加载失败。");
        setStoredDocuments(result.items);
      })
      .catch((error) => { if (active) setLibraryError(error instanceof Error ? error.message : "知识库加载失败。"); })
      .finally(() => { if (active) setLibraryLoading(false); });
    return () => { active = false; };
  }, [currentUser?.id]);

  const requireLogin = () => {
    if (currentUser) return true;
    setLocalAuthMode("signin");
    setLoginError("");
    setLoginOpen(true);
    return false;
  };

  const navigateTo = (nextView: View) => {
    if (view !== nextView) setViewHistory((history) => [...history, view]);
    setView(nextView);
  };

  const goBack = (fallback: View = "create") => {
    const previous = viewHistory.at(-1) || fallback;
    setViewHistory((history) => history.slice(0, -1));
    setView(previous);
  };

  const leaveProcessing = () => {
    processingSessionRef.current += 1;
    crawlAbortRef.current?.abort();
    crawlAbortRef.current = null;
    setIsCrawling(false);
    setIsUploading(false);
    setProcessingError("");
    goBack();
  };

  const signInLocal = async () => {
    if (loginSubmitting) return;
    setLoginSubmitting(true);
    setLoginError("");
    try {
      const response = await fetch("/v1/auth/local-signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: loginPhone, password: loginPassword }),
      });
      const result = await response.json() as { user?: AuthUser; message?: string };
      if (!response.ok || !result.user) throw new Error(result.message || "登录失败，请稍后重试。");
      setCurrentUser(result.user);
      setLibraryLoading(true);
      setLibraryError("");
      setLoginOpen(false);
      setLoginPassword("");
      setView("create");
      setNotice(`已进入 ${result.user.display_name} 的私有空间。`);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败，请稍后重试。");
    } finally {
      setLoginSubmitting(false);
    }
  };

  const registerLocal = async () => {
    if (loginSubmitting) return;
    if (loginPassword !== loginPasswordConfirmation) {
      setLoginError("两次输入的密码不一致。");
      return;
    }
    setLoginSubmitting(true);
    setLoginError("");
    try {
      const response = await fetch("/v1/auth/local-register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: loginPhone, display_name: loginName, password: loginPassword }),
      });
      const result = await response.json() as { user?: AuthUser; message?: string };
      if (!response.ok || !result.user) throw new Error(result.message || "注册失败，请稍后重试。");
      setCurrentUser(result.user);
      setLibraryLoading(true);
      setLibraryError("");
      setLoginOpen(false);
      setLoginPassword("");
      setLoginPasswordConfirmation("");
      setView("create");
      setNotice(`欢迎 ${result.user.display_name}，你的私有空间已创建。`);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "注册失败，请稍后重试。");
    } finally {
      setLoginSubmitting(false);
    }
  };

  const signOut = async () => {
    if (!currentUser) return;
    if (currentUser.auth_mode === "platform") {
      window.location.assign("/signout-with-chatgpt?return_to=/");
      return;
    }
    await fetch("/v1/auth/local-signout", { method: "POST" });
    stopSpeech(true);
    setCurrentUser(null);
    setPrivateTtsVoices([]);
    setTtsProvider("browser");
    setStoredDocuments([]);
    setLibraryLoading(false);
    setSearchHits([]);
    setView("create");
    setNotice("已退出本地体验账号。");
  };

  const bindCurrentAccountPhone = async () => {
    if (phoneBinding || !currentUser || currentUser.auth_mode !== "local") return;
    setPhoneBinding(true);
    setPhoneBindingError("");
    try {
      const response = await fetch("/v1/auth/local-bind-phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: phoneToBind }),
      });
      const result = await response.json() as { user?: AuthUser; message?: string };
      if (!response.ok || !result.user) throw new Error(result.message || "手机号绑定失败，请稍后重试。");
      setCurrentUser(result.user);
      setPhoneToBind("");
      setNotice("手机号已绑定，现有资料已保留在该账户下。");
    } catch (error) {
      setPhoneBindingError(error instanceof Error ? error.message : "手机号绑定失败，请稍后重试。");
    } finally {
      setPhoneBinding(false);
    }
  };

  const loadLibrary = async () => {
    if (!requireLogin()) return;
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const response = await fetch("/v1/documents");
      const result = await response.json() as { items?: StoredDocument[]; message?: string };
      if (!response.ok || !Array.isArray(result.items)) throw new Error(result.message || "知识库加载失败。");
      setStoredDocuments(result.items);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "知识库加载失败。");
    } finally {
      setLibraryLoading(false);
    }
  };

  const openLibrary = () => {
    if (!requireLogin()) return;
    navigateTo("library");
    void loadLibrary();
  };

  const openHistory = () => {
    if (!requireLogin()) return;
    navigateTo("history");
    void loadLibrary();
  };

  const startProcessing = async (fileToProcess = selectedFile) => {
    if (!fileToProcess || isUploading) return;
    if (!requireLogin()) return;
    const processingSession = processingSessionRef.current + 1;
    processingSessionRef.current = processingSession;
    crawlAbortRef.current?.abort();
    crawlAbortRef.current = null;
    setSourceType("file");
    setMobileEntryMode("file");
    setProcessingName(fileToProcess.name);
    setProcessingError("");
    setNotice("");
    setProgress(12);
    setIsUploading(true);
    setView("processing");
    try {
      const form = new FormData();
      form.append("file", fileToProcess);
      const response = await fetch("/v1/documents:upload", { method: "POST", body: form });
      const result = await response.json() as { document?: { id?: string; error_message?: string }; reader?: Omit<ReaderDocument, "documentId"> | null; message?: string };
      if (!response.ok || !result.document?.id || !result.reader) {
        throw new Error(result.document?.error_message || result.message || "文档转换失败。");
      }
      if (processingSessionRef.current !== processingSession) return;
      setReaderDocument({ ...result.reader, documentId: result.document.id });
      setProcessingName(result.reader.title);
      setProgress(100);
      void loadLibrary();
      window.setTimeout(() => { if (processingSessionRef.current === processingSession) setView("reader"); }, 450);
    } catch (error) {
      if (processingSessionRef.current !== processingSession) return;
      setProcessingError(error instanceof Error ? error.message : "文档上传或转换失败。");
      setProgress((current) => Math.min(current, 88));
    } finally {
      if (processingSessionRef.current === processingSession) setIsUploading(false);
    }
  };

  const submitUrl = async (urlToImport = url) => {
    if (isCrawling) return;
    if (!requireLogin()) return;
    let parsed: URL;
    try {
      const candidate = /^https?:\/\//i.test(urlToImport.trim()) ? urlToImport.trim() : `https://${urlToImport.trim()}`;
      parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("invalid");
      setUrl(parsed.toString());
      setUrlError("");
    } catch {
      setUrlError("请输入有效的网页地址，例如 www.beijing.gov.cn");
      return;
    }

    const processingSession = processingSessionRef.current + 1;
    processingSessionRef.current = processingSession;

    setSourceType("url");
    setMobileEntryMode("url");
    setProcessingName(parsed.hostname);
    setProgress(8);
    setProcessingError("");
    setNotice("");
    setIsCrawling(true);
    setView("processing");
    const controller = new AbortController();
    crawlAbortRef.current = controller;
    try {
      const response = await fetch("/v1/documents:import-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: parsed.toString() }),
        signal: controller.signal,
      });
      const result = await response.json() as { document?: { id?: string; error_message?: string }; reader?: Omit<ReaderDocument, "documentId"> | null; message?: string };
      if (!response.ok) throw new Error(result.document?.error_message || result.message || `抓取服务返回 ${response.status}`);
      if (!result.document?.id || !result.reader || !result.reader.title || !result.reader.description || !Array.isArray(result.reader.sections) || result.reader.sections.length === 0) {
        throw new Error("抓取成功，但结果中没有可阅读正文。");
      }
      if (processingSessionRef.current !== processingSession) return;
      const document = { ...result.reader, documentId: result.document.id } as ReaderDocument;
      setReaderDocument(document);
      setProcessingName(document.title);
      setProgress(100);
      void loadLibrary();
      window.setTimeout(() => { if (processingSessionRef.current === processingSession) setView("reader"); }, 450);
    } catch (error) {
      if (controller.signal.aborted || processingSessionRef.current !== processingSession) return;
      setProcessingError(error instanceof Error ? error.message : "网页抓取失败。");
      setProgress((current) => Math.min(current, 88));
    } finally {
      if (crawlAbortRef.current === controller) {
        crawlAbortRef.current = null;
        if (processingSessionRef.current === processingSession) setIsCrawling(false);
      }
    }
  };

  const acceptFile = (file?: File) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toUpperCase() || "";
    if (!supportedExtensions.includes(ext)) {
      setNotice("当前已接入 DOCX、PDF、XLSX、TXT 和 Markdown；DOC、PPT/PPTX 将在下一阶段接入。");
      return;
    }
    crawlAbortRef.current?.abort();
    crawlAbortRef.current = null;
    setSourceType("file");
    setMobileEntryMode("file");
    setIsCrawling(false);
    setSelectedFile(file);
    setNotice("");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const clearPrivateAudio = () => {
    if (privateProgressFrameRef.current !== null) window.cancelAnimationFrame(privateProgressFrameRef.current);
    privateProgressFrameRef.current = null;
    const source = audioSourceRef.current;
    audioSourceRef.current = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A finished AudioBufferSourceNode cannot be stopped again.
    }
    source.disconnect();
  };

  const preparePrivateAudio = () => {
    if (!("AudioContext" in window)) {
      setNotice("当前浏览器不支持私有音频播放，请切换到浏览器语音。");
      return null;
    }
    const context = audioContextRef.current || new AudioContext();
    audioContextRef.current = context;
    // Resume within the click handler so the finished private audio can play
    // without losing the browser's user-activation permission.
    if (context.state === "suspended") void context.resume().catch(() => setNotice("浏览器未允许音频播放，请再次点击朗读。"));
    return context;
  };

  const stopSpeech = (resetProgress = false) => {
    speechSessionRef.current += 1;
    cancelMeloRequests();
    clearPrivateAudio();
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    setSpeaking(false);
    setTtsPlaybackState("idle");
    if (resetProgress) {
      speechOffsetRef.current = 0;
      setSpeechProgress(0);
    }
  };

  const speakFromOffset = (requestedOffset: number, selectedVoice = voiceName) => {
    if (!("speechSynthesis" in window) || !articleText) {
      setNotice("当前浏览器不支持语音播放。");
      return;
    }
    const offset = requestedOffset >= articleText.length ? 0 : Math.max(0, requestedOffset);
    const session = speechSessionRef.current + 1;
    speechSessionRef.current = session;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(articleText.slice(offset));
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.voice = voices.find((voice) => voice.name === selectedVoice) || null;
    utterance.onboundary = (event) => {
      if (speechSessionRef.current !== session) return;
      const absoluteOffset = Math.min(articleText.length, offset + event.charIndex);
      speechOffsetRef.current = absoluteOffset;
      setSpeechProgress(Math.min(100, Math.round((absoluteOffset / articleText.length) * 100)));
    };
    utterance.onend = () => {
      if (speechSessionRef.current !== session) return;
      speechOffsetRef.current = articleText.length;
      setSpeaking(false);
      setTtsPlaybackState("idle");
      setSpeechProgress(100);
    };
    utterance.onerror = () => {
      if (speechSessionRef.current === session) {
        setSpeaking(false);
        setTtsPlaybackState("idle");
      }
    };
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
    setTtsPlaybackState("playing");
  };

  const fetchMeloSegment = async (offset: number, preferFastStart: boolean, selectedVoice: string, session: number, audioContext: AudioContext): Promise<MeloAudioSegment | null> => {
    const segment = nextMeloTextSegment(articleText, offset, preferFastStart);
    if (!segment?.text || speechSessionRef.current !== session) return null;
    const controller = new AbortController();
    meloRequestControllersRef.current.add(controller);
    try {
      const response = await fetch("/v1/tts/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: segment.text, voice_id: selectedVoice, speed: 1 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(result.message || "MeloTTS 合成失败。");
      }
      const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
      return speechSessionRef.current === session ? { offset, text: segment.text, audioBuffer } : null;
    } finally {
      meloRequestControllersRef.current.delete(controller);
    }
  };

  const prefetchMeloSegment = (offset: number, selectedVoice: string, session: number, audioContext: AudioContext) => {
    if (offset >= articleText.length || speechSessionRef.current !== session) return;
    const existing = meloPrefetchRef.current;
    if (existing?.session === session && existing.offset === offset) return;
    const promise = fetchMeloSegment(offset, false, selectedVoice, session, audioContext);
    // The promise is deliberately awaited at the segment boundary. Attach a
    // handler now so an aborted background request never becomes unhandled.
    void promise.catch(() => undefined);
    meloPrefetchRef.current = { session, offset, promise };
  };

  const playMeloSegment = async (offset: number, selectedVoice: string, session: number, audioContext: AudioContext, prepared?: MeloAudioSegment | null, preferFastStart = false) => {
    let nextSegment = prepared;
    try {
      if (!nextSegment) {
        setTtsPlaybackState("synthesizing");
        nextSegment = await fetchMeloSegment(
          offset,
          preferFastStart,
          selectedVoice,
          session,
          audioContext,
        );
      }
      if (!nextSegment || speechSessionRef.current !== session) return;
      clearPrivateAudio();
      const source = audioContext.createBufferSource();
      source.buffer = nextSegment.audioBuffer;
      source.connect(audioContext.destination);
      audioSourceRef.current = source;
      const startedAt = audioContext.currentTime;
      const followingOffset = offset + nextSegment.text.length;
      // Start the next CPU synthesis as soon as audio begins. It will normally
      // finish while the listener is hearing the current segment.
      prefetchMeloSegment(followingOffset, selectedVoice, session, audioContext);
      const updateProgress = () => {
        if (speechSessionRef.current !== session || audioSourceRef.current !== source || nextSegment.audioBuffer.duration <= 0) return;
        const elapsed = Math.min(nextSegment.audioBuffer.duration, Math.max(0, audioContext.currentTime - startedAt));
        const absoluteOffset = Math.min(articleText.length, offset + Math.round(nextSegment.text.length * (elapsed / nextSegment.audioBuffer.duration)));
        speechOffsetRef.current = absoluteOffset;
        setSpeechProgress(Math.min(100, Math.round((absoluteOffset / articleText.length) * 100)));
        if (elapsed < nextSegment.audioBuffer.duration) privateProgressFrameRef.current = window.requestAnimationFrame(updateProgress);
      };
      source.onended = () => {
        if (speechSessionRef.current !== session) return;
        if (privateProgressFrameRef.current !== null) window.cancelAnimationFrame(privateProgressFrameRef.current);
        privateProgressFrameRef.current = null;
        if (audioSourceRef.current === source) audioSourceRef.current = null;
        speechOffsetRef.current = Math.min(articleText.length, followingOffset);
        setSpeechProgress(Math.min(100, Math.round((speechOffsetRef.current / articleText.length) * 100)));
        if (followingOffset >= articleText.length) {
          setSpeaking(false);
          setTtsPlaybackState("idle");
          return;
        }
        const prefetched = meloPrefetchRef.current;
        meloPrefetchRef.current = null;
        if (prefetched?.session === session && prefetched.offset === followingOffset) {
          void prefetched.promise.then((audio) => playMeloSegment(followingOffset, selectedVoice, session, audioContext, audio)).catch(() => playMeloSegment(followingOffset, selectedVoice, session, audioContext));
          return;
        }
        void playMeloSegment(followingOffset, selectedVoice, session, audioContext);
      };
      source.start();
      setTtsPlaybackState("playing");
      updateProgress();
    } catch (error) {
      if (speechSessionRef.current !== session) return;
      setSpeaking(false);
      setTtsPlaybackState("idle");
      setNotice(error instanceof Error ? error.message : "MeloTTS 服务暂不可用。");
    }
  };

  const speakWithMeloTts = (requestedOffset: number, selectedVoice = privateTtsVoices[0]?.id || "") => {
    if (!articleText || !selectedVoice) {
      setNotice("MeloTTS 音色尚未就绪，请稍后再试。");
      return;
    }
    const audioContext = preparePrivateAudio();
    if (!audioContext) return;
    const offset = requestedOffset >= articleText.length ? 0 : Math.max(0, requestedOffset);
    const session = speechSessionRef.current + 1;
    speechSessionRef.current = session;
    cancelMeloRequests();
    clearPrivateAudio();
    window.speechSynthesis?.cancel();
    speechOffsetRef.current = offset;
    setSpeechProgress(Math.round((offset / articleText.length) * 100));
    setSpeaking(true);
    setTtsPlaybackState("synthesizing");
    void playMeloSegment(offset, selectedVoice, session, audioContext, undefined, true);
  };

  const playSpeech = () => {
    if (speaking) {
      stopSpeech(false);
      return;
    }
    if (ttsProvider === "melotts") {
      if (privateTtsVoices.length) {
        speakWithMeloTts(speechProgress >= 100 ? 0 : speechOffsetRef.current);
        return;
      }
      setNotice("MeloTTS 正在准备默认音色，请稍后再试。");
      return;
    }
    speakFromOffset(speechProgress >= 100 ? 0 : speechOffsetRef.current);
  };

  const handleReaderBack = () => {
    stopSpeech(false);
    goBack();
  };

  const downloadOriginal = () => {
    if (readerDocument.documentId && sourceType !== "url") {
      window.open(`/v1/documents/${readerDocument.documentId}/artifacts/original`, "_blank", "noopener,noreferrer");
      return;
    }
    if (sourceType === "url" && readerDocument.sourceUrl) {
      window.open(readerDocument.sourceUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!selectedFile) {
      setNotice("示例文档没有原始文件；上传你的文件后即可下载原件。");
      return;
    }
    const href = URL.createObjectURL(selectedFile);
    const link = document.createElement("a");
    link.href = href;
    link.download = selectedFile.name;
    link.click();
    URL.revokeObjectURL(href);
  };

  const exportH5 = () => {
    if (readerDocument.documentId) {
      window.open(`/v1/documents/${readerDocument.documentId}/artifacts/h5`, "_blank", "noopener,noreferrer");
      setNotice("正在下载已保存的 H5 阅读页。");
      return;
    }
    const sections = readerDocument.sections.map((section) => `<section><p class="eyebrow">${escapeHtml(section.eyebrow)}</p><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`).join("");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(readerDocument.title)}</title><style>body{margin:0;background:#f5f5f1;color:#20221d;font:17px/1.9 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:72px 24px 140px}h1{font-size:42px;line-height:1.2}h2{font-size:28px;line-height:1.35;margin-top:56px}.deck{color:#6f756b;font-size:19px}.eyebrow{color:#e25d3f;font-size:12px;font-weight:700;letter-spacing:.12em}.player{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:#20221d;color:white;padding:12px 18px;border-radius:18px;box-shadow:0 12px 40px #0003}.player button{border:0;border-radius:10px;padding:10px 14px}</style></head><body><main><p class="eyebrow">声阅 · 智能阅读</p><h1>${escapeHtml(readerDocument.title)}</h1><p class="deck">${escapeHtml(readerDocument.description)}</p>${sections}</main><div class="player"><button id="play">▶ 开始播放</button></div><script>const text=document.querySelector('main').innerText,b=document.querySelector('#play');b.onclick=()=>{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';speechSynthesis.speak(u);};</script></body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${readerDocument.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "声阅阅读页"}.html`;
    link.click();
    URL.revokeObjectURL(href);
    setNotice("H5 阅读页已导出，可直接在浏览器中打开。");
  };

  const copyToClipboard = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(successMessage);
    } catch {
      setNotice("浏览器未授予剪贴板权限，请手动复制链接。");
    }
  };

  const createShare = async () => {
    if (isSharing) return;
    if (!requireLogin()) return;
    if (!readerDocument.documentId) {
      setShareError("请先导入网址或文件后再创建持久化分享链接。");
      return;
    }
    setIsSharing(true);
    setShareError("");
    try {
      const response = await fetch(`/v1/documents/${readerDocument.documentId}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expires_in_hours: shareTtlHours,
          allow_download: shareAllowDownload,
        }),
      });
      const result = await response.json() as {
        id?: string; share_url?: string; expires_at?: string; message?: string;
      };
      if (!response.ok || !result.id || !result.share_url) {
        throw new Error(result.message || "分享链接生成失败。");
      }
      setShareId(result.id);
      setShareLink(result.share_url);
      setShareExpiresAt(result.expires_at || "");
      await copyToClipboard(result.share_url, "分享链接已复制，可直接转发给他人。");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "分享链接生成失败。");
    } finally {
      setIsSharing(false);
    }
  };

  const forwardShare = async () => {
    if (!shareLink) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: readerDocument.title, text: readerDocument.description, url: shareLink });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copyToClipboard(shareLink, "分享链接已复制，可粘贴到微信、邮件或工作群。");
  };

  const revokeShare = async () => {
    if (!shareId || !readerDocument.documentId) return;
    try {
      const response = await fetch(`/v1/documents/${readerDocument.documentId}/shares/${shareId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("关闭分享失败，请稍后重试。");
      setShareLink("");
      setShareId("");
      setShareExpiresAt("");
      setNotice("分享链接已关闭，访问者将无法继续打开。 ");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "关闭分享失败。");
    }
  };

  const openStoredDocument = async (item: StoredDocument) => {
    if (item.status !== "ready") {
      setLibraryError(item.error_message || "该文档仍在处理中，请稍后再试。");
      return;
    }
    try {
      const response = await fetch(`/v1/documents/${item.id}/reader`);
      const result = await response.json() as ({ document_id?: string } & Omit<ReaderDocument, "documentId"> & { message?: string });
      if (!response.ok || !result.document_id || !result.sections) throw new Error(result.message || "无法打开阅读页。");
      const { document_id, ...reader } = result;
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      setSpeechProgress(0);
      setReaderDocument({ ...reader, documentId: document_id });
      setSourceType(item.source_type === "upload" ? "file" : "url");
      setSelectedFile(null);
      setSearchHits([]);
      navigateTo("reader");
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "无法打开阅读页。");
    }
  };

  const searchLibrary = async () => {
    const query = libraryQuery.trim();
    if (!query) {
      setSearchHits([]);
      return;
    }
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const response = await fetch("/v1/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: 10 }),
      });
      const result = await response.json() as { items?: SearchHit[]; message?: string };
      if (!response.ok || !Array.isArray(result.items)) throw new Error(result.message || "知识库检索失败。");
      setSearchHits(result.items);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "知识库检索失败。");
    } finally {
      setLibraryLoading(false);
    }
  };

  const pasteFromClipboard = async () => {
    setMobileEntryMode("clipboard");
    setUrlError("");
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error("empty clipboard");
      setClipboardContent(value);
      setNotice(isWebAddress(value)
        ? "已识别为网页链接；确认后会抓取网页正文。"
        : "已识别为文字内容；确认后会按 TXT 文档导入。");
    } catch {
      setNotice("无法读取剪贴板，请在下方手动粘贴文字或网页链接。");
    }
  };

  const chooseMobileEntry = (mode: MobileEntryMode) => {
    setMobileEntryMode(mode);
    setSourceType(mode === "file" ? "file" : "url");
    setUrlError("");
  };

  const startMobileProcessing = () => {
    if (mobileEntryMode === "file") {
      if (selectedFile) void startProcessing();
      else document.getElementById("mobile-file-input")?.click();
      return;
    }
    if (mobileEntryMode === "clipboard") {
      const content = clipboardContent.trim();
      if (!content) {
        setUrlError("请先读取或粘贴剪贴板内容。");
        setNotice("支持网页链接或任意文字内容；文字会按 TXT 文档导入。");
        return;
      }
      if (isWebAddress(content)) {
        setUrl(content);
        void submitUrl(content);
        return;
      }
      const textFile = new File([content], "剪贴板内容.txt", { type: "text/plain;charset=utf-8" });
      setSelectedFile(textFile);
      void startProcessing(textFile);
      return;
    }
    if (!url.trim()) {
      setUrlError("请先粘贴有效的网页地址。");
      setNotice("网页链接不会自动猜测，请粘贴完整地址后再确认。");
      return;
    }
    void submitUrl();
  };

  const renderMobileCreate = () => {
    const materialItems = storedDocuments.slice(0, 3).map((item) => ({ id: item.id, type: item.source_type === "url" ? "网页" : item.filename?.split(".").pop()?.toUpperCase() || "文件", title: item.title, meta: item.status === "ready" ? `已完成 · 约 ${Math.max(1, Math.ceil(item.word_count / 350))} 分钟` : `处理中 · ${item.progress}%`, stored: item }));
    const clipboardIsWebAddress = isWebAddress(clipboardContent);
    const sourceReady = mobileEntryMode === "file"
      ? Boolean(selectedFile)
      : mobileEntryMode === "clipboard"
        ? Boolean(clipboardContent.trim())
        : Boolean(url.trim());
    const estimatedWords = selectedFile
      ? Math.max(1_000, Math.round(selectedFile.size / 7))
      : mobileEntryMode === "clipboard" && !clipboardIsWebAddress
        ? clipboardContent.trim().length
        : 0;
    const previewTitle = selectedFile
      ? selectedFile.name.replace(/\.[^.]+$/, "")
      : mobileEntryMode === "clipboard" && clipboardContent.trim()
        ? clipboardIsWebAddress ? "网页内容准备就绪" : "剪贴板文字内容"
        : mobileEntryMode === "url" && url.trim()
          ? "网页内容准备就绪"
          : "等待导入内容";
    const previewMinutes = estimatedWords ? Math.max(1, Math.ceil(estimatedWords / 350)) : 0;

    return <main className="mobile-station-page">
      <div className="mobile-phone-status"><strong>9:41</strong><button className="mobile-account-trigger" onClick={() => setMobileAccountOpen(true)} aria-label="打开账户设置">我的</button></div>
      <section className="mobile-station-hero">
        <div className="mobile-station-brand"><span className="station-mark">听</span><div><h1>听读电台</h1><p>上传即听 · 按量计费</p></div></div>
        <button className="credit-pill" onClick={openLibrary} aria-label="查看我的资料">⚡ <strong>1,250</strong></button>
      </section>

      <section className="mobile-import-card" aria-label="上传文档或网页">
        <input className="mobile-file-input" id="mobile-file-input" type="file" accept=".docx,.md,.txt,.xlsx,.pdf" onChange={(event) => acceptFile(event.target.files?.[0])} />
        {mobileEntryMode === "file" ? <div className={`mobile-drop-zone ${selectedFile ? "is-ready" : ""} ${dragging ? "dragging" : ""}`} role="button" tabIndex={0} aria-label="选择要上传的文档" onClick={() => document.getElementById("mobile-file-input")?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.getElementById("mobile-file-input")?.click(); } }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          {selectedFile ? <><span className="mobile-file-icon">{selectedFile.name.split(".").pop()?.toUpperCase()}</span><strong>{selectedFile.name}</strong><small>{(selectedFile.size / 1024 / 1024).toFixed(1)} MB · 已选择</small><span className="mobile-file-trigger">更换文件</span></> : <><span className="mobile-upload-icon">▯</span><strong>上传文档</strong><small>点击选择或拖入 DOCX、PDF、XLSX、MD、TXT</small></>}
        </div> : mobileEntryMode === "clipboard" ? <div className="mobile-clipboard-zone">
          <span className="mobile-upload-icon">▣</span><strong>从剪贴板导入</strong>
          <textarea aria-label="剪贴板内容" value={clipboardContent} onChange={(event) => { setClipboardContent(event.target.value); setUrlError(""); }} placeholder="点击读取剪贴板，或在这里粘贴文字 / 网页链接" />
          <div className="mobile-url-actions"><button className="mobile-clipboard-read" onClick={() => void pasteFromClipboard()}>读取剪贴板</button><button className="mobile-url-next" onClick={startMobileProcessing} disabled={isUploading || isCrawling}>{isUploading || isCrawling ? "正在处理…" : "下一步，开始收听 →"}</button></div>
          <small>{urlError || (!clipboardContent.trim() ? "支持网页链接或任意文字；文字将按 TXT 文档导入" : clipboardIsWebAddress ? "已识别为网页链接，将提取网页正文" : `已识别 ${clipboardContent.trim().length.toLocaleString()} 字，将按 TXT 文档导入`)}</small>
        </div> : <div className="mobile-url-zone"><span className="mobile-upload-icon">↗</span><strong>粘贴网页链接</strong><input value={url} onChange={(event) => { setUrl(event.target.value); setUrlError(""); }} onKeyDown={(event) => event.key === "Enter" && startMobileProcessing()} placeholder="https://example.com/article" /><div className="mobile-url-actions"><button className="mobile-url-next" onClick={startMobileProcessing} disabled={isCrawling}>{isCrawling ? "正在抓取…" : "下一步，开始收听 →"}</button></div><small>{urlError || "粘贴完成后点击下一步，生成可听阅读页"}</small></div>}
        <div className="mobile-source-switch" role="tablist">
          <button className={mobileEntryMode === "file" ? "active" : ""} onClick={() => chooseMobileEntry("file")} role="tab" aria-selected={mobileEntryMode === "file"}>▤ 文件</button>
          <button className={mobileEntryMode === "url" ? "active" : ""} onClick={() => chooseMobileEntry("url")} role="tab" aria-selected={mobileEntryMode === "url"}>⌁ 网页</button>
          <button className={mobileEntryMode === "clipboard" ? "active" : ""} onClick={() => { chooseMobileEntry("clipboard"); void pasteFromClipboard(); }} role="tab" aria-selected={mobileEntryMode === "clipboard"}>▣ 剪贴板</button>
        </div>
      </section>

      <section className="mobile-confirm-card">
        <p className="mobile-status">{sourceReady ? "内容已就绪 · 待确认" : "上传后自动解析 · 待确认"}</p>
        <div className="mobile-confirm-title"><span className="mobile-wave">▮▯▮</span><h2>{previewTitle}</h2></div>
        <p className="mobile-confirm-copy">{estimatedWords ? <>正文约 <b>{estimatedWords.toLocaleString()} 字</b> · 约 <b>{previewMinutes} 分钟</b></> : sourceReady ? "导入后将提取正文并计算时长" : "导入后自动识别字数与收听时长"} · 已跳过图表/参考文献</p>
        <div className="mobile-estimate"><div><span>预计消耗</span><strong>⚡200</strong></div><div className="mobile-balance"><span>余额</span><strong>1,250</strong><small>充足</small></div></div>
        <p className="mobile-refund">✓ 失败自动返还 · 合成后重听免费</p>
        <button className="mobile-confirm-button" onClick={startMobileProcessing} disabled={isUploading || isCrawling}>{isUploading || isCrawling ? "正在处理…" : "确认并开始收听"}</button>
      </section>

      <section className="mobile-materials"><div className="mobile-section-heading"><h2>我的资料</h2><button onClick={openLibrary}>全部 →</button></div><div className="mobile-material-list">{!authReady || libraryLoading ? <p className="mobile-material-placeholder">正在同步你的真实资料…</p> : libraryError ? <p className="mobile-material-placeholder" role="alert">资料加载失败，请点击“全部”后重试。</p> : materialItems.length ? materialItems.map((item) => <button key={item.id} className="mobile-material-item" onClick={() => void openStoredDocument(item.stored)}><span className={`mobile-type ${item.type.toLowerCase()}`}>{item.type}</span><span><strong>{item.title}</strong><small>{item.meta}</small></span><i>▶</i></button>) : <div className="mobile-material-empty"><strong>还没有资料</strong><small>完成一次文件、网页或剪贴板导入后，资料会显示在这里。</small></div>}</div></section>
      {renderMobileAccountSheet()}
      {notice && <div className="mobile-notice" role="status">{notice}</div>}
    </main>;
  };

  const renderMobileAccountSheet = () => {
    if (!mobileAccountOpen) return null;
    const phone = currentUser?.phone;
    const maskedPhone = phone ? `${phone.slice(0, 3)} **** ${phone.slice(-4)}` : "已通过平台账户登录";
    return <div className="mobile-sheet-backdrop" role="presentation"><section className="mobile-action-sheet mobile-account-sheet" role="dialog" aria-modal="true" aria-label="账户设置"><div className="mobile-sheet-handle" /><div className="mobile-account-summary"><strong>{currentUser?.display_name}</strong><small>{maskedPhone}</small><span>资料、索引与分享记录仅归属当前账户</span></div>{currentUser?.auth_mode === "local" && !phone && <div className="mobile-phone-bind"><label>绑定手机号<input type="tel" value={phoneToBind} onChange={(event) => { setPhoneToBind(event.target.value); setPhoneBindingError(""); }} inputMode="tel" autoComplete="tel-national" placeholder="请输入中国大陆手机号" /></label><button onClick={() => void bindCurrentAccountPhone()} disabled={phoneBinding}>{phoneBinding ? "正在绑定…" : "绑定并保留现有资料"}</button>{phoneBindingError && <small role="alert">{phoneBindingError}</small>}</div>}<button onClick={() => { setMobileAccountOpen(false); void signOut(); }}><span>⇥</span>退出登录</button><button className="mobile-action-cancel" onClick={() => setMobileAccountOpen(false)}>取消</button></section></div>;
  };

  const renderMobileShareSheet = () => {
    if (!sharePanelOpen) return null;
    return <div className="mobile-sheet-backdrop" role="presentation">
      <section className="mobile-share-sheet" role="dialog" aria-modal="true" aria-label="转发阅读页">
        <div className="mobile-sheet-handle" />
        <header><div><p>转发阅读页</p><small>链接仅供阅读，可随时关闭</small></div><button onClick={() => setSharePanelOpen(false)} aria-label="关闭分享面板">×</button></header>
        {shareLink ? <>
          <div className="mobile-share-link"><input readOnly value={shareLink} aria-label="分享链接" /><button onClick={() => void copyToClipboard(shareLink, "分享链接已复制。")}><AppIcon name="copy" />复制</button></div>
          <p className="mobile-share-expiry">有效至 {shareExpiresAt ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(shareExpiresAt)) : "--"}</p>
          <button className="mobile-sheet-primary" onClick={() => void forwardShare()}>转发链接 <span>↗</span></button>
          <button className="mobile-sheet-danger" onClick={() => void revokeShare()}>关闭此分享链接</button>
        </> : <>
          <div className="mobile-share-options"><label>有效期<select value={shareTtlHours} onChange={(event) => setShareTtlHours(Number(event.target.value))}><option value={24}>24 小时</option><option value={168}>7 天</option><option value={720}>30 天</option></select></label><label className="mobile-share-toggle"><input type="checkbox" checked={shareAllowDownload} onChange={(event) => setShareAllowDownload(event.target.checked)} /><span />允许下载 H5</label></div>
          <button className="mobile-sheet-primary" onClick={() => void createShare()} disabled={isSharing}>{isSharing ? "正在生成…" : "生成并复制链接"}<span>↗</span></button>
        </>}
        {shareError && <p className="mobile-sheet-error" role="alert">{shareError}</p>}
      </section>
    </div>;
  };

  const renderMobileReader = () => {
    const documentType = selectedFile?.name.split(".").pop()?.toUpperCase() || (readerDocument.sourceUrl ? "网页" : "资料");
    const duration = Math.max(1, Math.ceil(readerDocument.wordCount / 350));
    const ttsLabel = ttsProvider === "melotts" ? privateTtsVoices.length ? "MeloTTS · 中文自然女声" : "MeloTTS 正在准备" : "浏览器语音 · 自动回退";
    return <main className="mobile-route-page mobile-reader-screen">
      <header className="mobile-route-header"><button onClick={handleReaderBack} aria-label="返回上一页">‹</button><strong>听读</strong><button onClick={() => setMobileReaderMenuOpen(true)} aria-label="更多操作">•••</button></header>
      <div className="mobile-reader-summary"><span className={`mobile-reader-type ${documentType.toLowerCase()}`}>{documentType}</span><div><strong>{readerDocument.title}</strong><small>{readerDocument.sections.length} 章 · 约 {duration} 分钟 · 已保存</small></div></div>
      <article className="mobile-reader-article">
        <p className="mobile-reader-eyebrow">{readerDocument.siteName} · {readerDocument.engine === "demo" ? "阅读示例" : "已生成阅读页"}</p>
        <h1>{readerDocument.title}</h1>
        <p className="mobile-reader-deck">{readerDocument.description}</p>
        {readerDocument.sections.map((section, index) => <section key={section.id} id={section.id}><p className="mobile-reader-section-index">{String(index + 1).padStart(2, "0")} / 文档内容</p><h2>{section.title}</h2>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={`${section.id}-${paragraphIndex}`}>{paragraph}</p>)}</section>)}
        <p className="mobile-reader-end">— 已读完全文 —</p>
      </article>
      <div className="mobile-reader-dock"><button className="mobile-play-button" onClick={playSpeech} aria-label={speaking ? "暂停播放" : "开始播放"}>{speaking ? "Ⅱ" : "▶"}</button><div><strong>{speaking ? "正在朗读" : "准备收听"}</strong><small>{ttsLabel} · {Math.round(speechProgress)}%</small></div><button className="mobile-dock-menu" onClick={() => setMobileReaderMenuOpen(true)} aria-label="打开操作菜单">⋯</button></div>
      {mobileReaderMenuOpen && <div className="mobile-sheet-backdrop" role="presentation"><section className="mobile-action-sheet" role="dialog" aria-modal="true" aria-label="阅读操作"><div className="mobile-sheet-handle" /><button onClick={() => { setMobileReaderMenuOpen(false); downloadOriginal(); }}><span>↓</span>{readerDocument.sourceUrl ? "打开原网页" : "下载原文件"}</button><button onClick={() => { setMobileReaderMenuOpen(false); exportH5(); }}><span>⇩</span>一键下载 H5</button><button onClick={() => { setMobileReaderMenuOpen(false); setShareError(""); setSharePanelOpen(true); }}><span>↗</span>生成分享链接</button><button className="mobile-action-cancel" onClick={() => setMobileReaderMenuOpen(false)}>取消</button></section></div>}
      {renderMobileShareSheet()}
      {notice && <button className="mobile-inline-notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
    </main>;
  };

  const renderMobileLibrary = () => <main className="mobile-route-page mobile-library-screen">
    <header className="mobile-route-header"><button onClick={() => goBack()} aria-label="返回上一页">‹</button><strong>我的资料</strong><button onClick={openHistory} aria-label="查看处理记录">◷</button></header>
    <section className="mobile-library-hero"><p>个人知识库</p><h1>我的资料</h1><span>{storedDocuments.length} 份资料 · 仅自己可见</span></section>
    <div className="mobile-search"><span>⌕</span><input aria-label="搜索知识库" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchLibrary()} placeholder="搜索资料正文…" /><button onClick={() => void searchLibrary()}>搜索</button></div>
    {libraryError && <p className="mobile-page-error" role="alert">{libraryError}</p>}
    {searchHits.length > 0 && <section className="mobile-search-results" aria-label="检索结果">{searchHits.map((hit) => <button key={hit.chunk_id} onClick={() => { const item = storedDocuments.find((document) => document.id === hit.document_id); if (item) void openStoredDocument(item); }}><strong>{hit.document_title}</strong><small>{hit.text}</small></button>)}</section>}
    <section className="mobile-library-list" aria-label="资料列表">{libraryLoading ? <p className="mobile-empty-state">正在读取资料…</p> : storedDocuments.length ? storedDocuments.map((item) => { const type = item.filename?.split(".").pop()?.toUpperCase() || (item.source_type === "url" ? "网页" : "文件"); return <button key={item.id} onClick={() => void openStoredDocument(item)}><span className={`mobile-library-type ${type.toLowerCase()}`}>{type}</span><span><strong>{item.title}</strong><small>{item.status === "ready" ? `已完成 · ${item.word_count.toLocaleString()} 字` : `处理中 · ${item.progress}%`}</small></span><i>›</i></button>; }) : <div className="mobile-empty-state"><strong>还没有资料</strong><p>导入文件或网页后，会自动保存在这里。</p><button onClick={() => setView("create")}>去导入</button></div>}</section>
    <nav className="mobile-bottom-nav" aria-label="移动端导航"><button onClick={() => setView("create")}>⌂<span>首页</span></button><button className="active">▦<span>资料</span></button><button onClick={openHistory}>◷<span>记录</span></button></nav>
  </main>;

  const renderMobileHistory = () => <main className="mobile-route-page mobile-library-screen">
    <header className="mobile-route-header"><button onClick={() => goBack()} aria-label="返回上一页">‹</button><strong>处理记录</strong><button onClick={openLibrary} aria-label="查看我的资料">▦</button></header>
    <section className="mobile-library-hero"><p>处理中心</p><h1>导入记录</h1><span>文件与网页的转换状态</span></section>
    {libraryError && <p className="mobile-page-error" role="alert">{libraryError}</p>}
    <section className="mobile-history-list" aria-label="处理记录列表">{libraryLoading ? <p className="mobile-empty-state">正在读取记录…</p> : storedDocuments.length ? storedDocuments.map((item) => { const type = item.filename?.split(".").pop()?.toUpperCase() || (item.source_type === "url" ? "网页" : "文件"); const status = item.status === "ready" ? "已完成" : item.status === "failed" ? "失败" : "处理中"; return <button key={item.id} onClick={() => item.status === "ready" && void openStoredDocument(item)}><span className={`mobile-history-status ${item.status}`}>{status}</span><span><strong>{item.title}</strong><small>{type} · {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.updated_at))}</small></span><i>{item.status === "ready" ? "›" : ""}</i></button>; }) : <div className="mobile-empty-state"><strong>暂时没有处理记录</strong><p>完成一次导入后，会在这里看到处理状态。</p></div>}</section>
    <nav className="mobile-bottom-nav" aria-label="移动端导航"><button onClick={() => setView("create")}>⌂<span>首页</span></button><button onClick={openLibrary}>▦<span>资料</span></button><button className="active">◷<span>记录</span></button></nav>
  </main>;

  const renderMobileProcessing = () => {
    const isUrlImport = sourceType === "url";
    const steps = isUrlImport ? ["校验链接", "抓取正文", "整理内容", "生成阅读页"] : ["保存文件", "解析内容", "整理版式", "生成阅读页"];
    return <main className="mobile-route-page mobile-processing-screen"><header className="mobile-route-header"><button onClick={leaveProcessing} aria-label="取消处理并返回上一页">‹</button><strong>正在处理</strong><span /></header><section className="mobile-processing-card"><div className="mobile-processing-icon">{isUrlImport ? "⌁" : "▤"}</div><p>{isUrlImport ? "正在导入网页" : "正在导入文件"}</p><h1>{processingName || "正在准备资料"}</h1>{processingError ? <div className="mobile-processing-failure" role="alert"><strong>{isUrlImport ? "网页抓取失败" : "文档解析失败"}</strong><span>{processingError}</span><button onClick={leaveProcessing}>返回重新导入</button></div> : <><div className="mobile-processing-progress"><span style={{ width: `${progress}%` }} /></div><div className="mobile-processing-percent"><strong>{progress}%</strong><span>{progress === 100 ? "马上打开阅读页" : "正在整理为可朗读内容"}</span></div><ol>{steps.map((step, index) => <li key={step} className={progress >= (index + 1) * 24 ? "done" : ""}><i>{progress >= (index + 1) * 24 ? "✓" : index + 1}</i>{step}</li>)}</ol></>}</section></main>;
  };

  const renderMobileApi = () => <main className="mobile-route-page mobile-library-screen"><header className="mobile-route-header"><button onClick={() => goBack()} aria-label="返回上一页">‹</button><strong>接口文档</strong><span /></header><section className="mobile-library-hero"><p>开发者</p><h1>API 文档</h1><span>用于前后端联调的接口契约</span></section><a className="mobile-api-download" href="/openapi.yaml" download>下载 OpenAPI 3.1 <span>↓</span></a><p className="mobile-api-note">上传、网页抓取、资料读取、分享与知识检索均遵循同一份接口契约。</p></main>;

  const renderMobileRoute = () => {
    if (view === "processing") return renderMobileProcessing();
    if (view === "reader") return renderMobileReader();
    if (view === "library") return renderMobileLibrary();
    if (view === "history") return renderMobileHistory();
    if (view === "api") return renderMobileApi();
    return null;
  };

  const renderCreate = () => (
    <main className="create-page">
      <section className="hero-copy">
        <div className="signal-pill"><span /> 内容正在变得更好听</div>
        <h1>把任何资料，<br />变成会朗读的网页。</h1>
        <p>导入网页或文档，自动生成排版清晰的 H5 阅读页，<br className="desktop-break" />一边阅读，一边立即收听。</p>
      </section>

      <section className="import-card" aria-label="导入资料">
        <div className="source-tabs" role="tablist">
          <button className={sourceType === "file" ? "active" : ""} onClick={() => setSourceType("file")} role="tab" aria-selected={sourceType === "file"}><AppIcon name="file" />上传文件</button>
          <button className={sourceType === "url" ? "active" : ""} onClick={() => setSourceType("url")} role="tab" aria-selected={sourceType === "url"}><AppIcon name="link" />网页链接</button>
        </div>

        {sourceType === "file" ? (
          <div className={`drop-zone ${dragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
            <input ref={fileInput} type="file" accept=".docx,.md,.txt,.xlsx,.pdf" onChange={(event) => acceptFile(event.target.files?.[0])} />
            {selectedFile ? (
              <>
                <div className="file-ready"><span className="file-badge">{selectedFile.name.split(".").pop()?.toUpperCase()}</span><div><strong>{selectedFile.name}</strong><small>{(selectedFile.size / 1024 / 1024).toFixed(1)} MB · 已就绪</small></div><AppIcon name="check" /></div>
                <div className="ready-actions"><button className="text-button" onClick={() => fileInput.current?.click()}>更换文件</button><button className="primary-button" onClick={() => void startProcessing()} disabled={isUploading}>开始转换 <span>→</span></button></div>
              </>
            ) : (
              <>
                <button className="upload-orb" onClick={() => fileInput.current?.click()} aria-label="选择文件"><AppIcon name="upload" /></button>
                <h2>拖放文件到这里</h2>
                <p>或 <button className="inline-link" onClick={() => fileInput.current?.click()}>从电脑中选择</button></p>
                <div className="format-list">{supportedExtensions.map((format) => <span key={format}>{format}</span>)}</div>
                <small>单文件最大 200 MB，内容仅对你可见</small>
              </>
            )}
          </div>
        ) : (
          <div className="url-zone">
            <label htmlFor="page-url">粘贴要阅读的网页地址</label>
            <div className={`url-field ${urlError ? "error" : ""}`}><AppIcon name="link" /><input id="page-url" value={url} onChange={(event) => { setUrl(event.target.value); setUrlError(""); }} onKeyDown={(event) => event.key === "Enter" && void submitUrl()} placeholder="www.beijing.gov.cn" /><button onClick={() => void submitUrl()} disabled={isCrawling}>{isCrawling ? "正在抓取…" : "抓取并转换"} <span>→</span></button></div>
            {urlError ? <p className="field-error">{urlError}</p> : <p className="url-help">服务端将提取真实标题与正文；抓取失败时不会用示例内容替代</p>}
            <div className="url-example"><span>没有链接？</span><button onClick={() => { setUrl("https://www.beijing.gov.cn/"); setUrlError(""); }}>使用北京市政府首页</button></div>
          </div>
        )}
        {notice && <div className="notice" role="status">{notice}</div>}
      </section>

      <section className="trust-row" aria-label="核心优势">
        <div><AppIcon name="lock" /><span><strong>私有存储</strong><small>用户级知识库隔离</small></span></div>
        <div><span className="mini-wave"><i /><i /><i /></span><span><strong>即时 TTS</strong><small>默认系统语音，即点即听</small></span></div>
        <div><AppIcon name="download" /><span><strong>双份导出</strong><small>H5 阅读页 + 原文件</small></span></div>
      </section>
    </main>
  );

  const renderProcessing = () => {
    const isUrlImport = sourceType === "url";
    const steps = isUrlImport
      ? [{ label: "网址校验", at: 8 }, { label: "服务端抓取", at: 24 }, { label: "正文提取", at: 48 }, { label: "结构化", at: 68 }, { label: "生成阅读页", at: 82 }, { label: "完成", at: 96 }]
      : [{ label: "文件校验", at: 8 }, { label: "安全保存", at: 24 }, { label: "文档解析", at: 48 }, { label: "结构化", at: 68 }, { label: "生成 H5", at: 82 }, { label: "完成", at: 96 }];
    return (
      <main className="processing-page">
        <button className="back-link" onClick={leaveProcessing}>← 返回导入</button>
        <section className="processing-card">
          <div className="processing-animation"><span className="doc-sheet"><i /><i /><i /></span><span className="pulse-ring ring-one" /><span className="pulse-ring ring-two" /></div>
          <p className="overline">正在转换</p>
          <h1>{processingName}</h1>
          <p>{processingError ? "未生成任何替代内容" : isUrlImport ? "正在读取目标网站并提取真实正文" : "正在解析上传文件并生成可朗读 H5"}</p>
          {processingError ? (
            <div className="processing-error" role="alert"><strong>{isUrlImport ? "网页抓取失败" : "文档解析失败"}</strong><p>{processingError}</p><button className="primary-button" onClick={leaveProcessing}>{isUrlImport ? "返回修改网址" : "返回重新选择文件"}</button></div>
          ) : <>
            <div className="big-progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="progress-meta"><strong>{progress}%</strong><span>{progress === 100 ? "正在打开阅读页" : isUrlImport ? "正在等待目标网站响应" : "正在提取文档文字与结构"}</span></div>
            <div className="pipeline-steps">{steps.map((step) => <div key={step.label} className={progress >= step.at ? "done" : progress + 16 >= step.at ? "current" : ""}><span>{progress >= step.at ? "✓" : ""}</span><small>{step.label}</small></div>)}</div>
          </>}
        </section>
        <p className="processing-tip">阅读页、TTS、H5、知识索引与分享链接将共用同一份结构化内容</p>
      </main>
    );
  };

  const renderReader = () => (
    <main className="reader-page">
      <aside className="reader-outline">
        <button className="back-link" onClick={handleReaderBack}>← 返回</button>
        <div className="outline-file"><span className="pdf-tile">{selectedFile?.name.split(".").pop()?.toUpperCase() || (readerDocument.sourceUrl ? "URL" : "DEMO")}</span><div><strong>{readerDocument.title}</strong><small>{readerDocument.sections.length} 章 · 约 {Math.max(1, Math.ceil(readerDocument.wordCount / 350))} 分钟</small></div></div>
        <p className="outline-title">文章目录</p>
        <nav>{readerDocument.sections.map((section, index) => <a key={section.id} href={`#${section.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{section.title}</a>)}</nav>
        <div className="private-note"><AppIcon name={readerDocument.engine === "demo" ? "book" : "check"} /><span><strong>{readerDocument.engine === "demo" ? "明确标记的阅读示例" : "已保存到个人知识库"}</strong><small>{readerDocument.engine === "crawl4ai" ? "Crawl4AI 处理" : readerDocument.engine === "document-processor" ? "DOCX / PDF / XLSX / MD / TXT 解析" : readerDocument.engine === "demo" ? "不代表用户文件或网页" : "服务端 HTML 正文提取"}</small></span></div>
      </aside>
      <article className="reader-article">
        <div className="article-meta"><span>{readerDocument.siteName}</span><span>·</span><span>{readerDocument.engine === "demo" ? "阅读示例" : readerDocument.engine === "document-processor" ? "已解析上传文件" : "实时网页抓取"}</span>{readerDocument.sourceUrl && <><span>·</span><a href={readerDocument.sourceUrl} target="_blank" rel="noreferrer">查看原网页 ↗</a></>}</div>
        <h1>{readerDocument.title}</h1>
        <p className="article-deck">{readerDocument.description}</p>
        <div className="article-rule" />
        {readerDocument.sections.map((section) => <section key={section.id} id={section.id}><p className="section-eyebrow">{section.eyebrow}</p><h2>{section.title}</h2>{section.paragraphs.map((paragraph, index) => <p key={`${section.id}-${index}`}>{paragraph}</p>)}</section>)}
        <div className="article-end"><span /> 文章结束 <span /></div>
      </article>
      <div className="reader-actions">
        <button className="secondary-action" onClick={downloadOriginal}><AppIcon name={readerDocument.sourceUrl ? "link" : "download"} />{readerDocument.sourceUrl ? "打开原网页" : "下载原文件"}</button>
        <button className="share-action" onClick={() => { setShareError(""); setSharePanelOpen((open) => !open); }} aria-expanded={sharePanelOpen} aria-controls="share-panel"><AppIcon name="share" />生成分享链接</button>
        <button className="export-action" onClick={exportH5}><AppIcon name="download" />一键下载 H5</button>
        {sharePanelOpen && <section className="share-panel" id="share-panel" aria-label="分享阅读页">
          <div className="share-panel-heading"><div><p>转发阅读页</p><small>链接默认只读，可随时关闭</small></div>{shareLink && <button className="icon-button" onClick={revokeShare} aria-label="关闭分享"><AppIcon name="close" /></button>}</div>
          {shareLink ? (
            <>
              <div className="share-link-field"><input readOnly value={shareLink} aria-label="分享链接" /><button onClick={() => void copyToClipboard(shareLink, "分享链接已复制。")} aria-label="复制分享链接"><AppIcon name="copy" />复制</button></div>
              <div className="share-panel-meta"><span>有效至 {shareExpiresAt ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(shareExpiresAt)) : "--"}</span><button onClick={() => void forwardShare()}>转发 ↗</button></div>
            </>
          ) : (
            <>
              <div className="share-options"><label>有效期<select value={shareTtlHours} onChange={(event) => setShareTtlHours(Number(event.target.value))}><option value={24}>24 小时</option><option value={168}>7 天</option><option value={720}>30 天</option></select></label><label className="toggle-option"><input type="checkbox" checked={shareAllowDownload} onChange={(event) => setShareAllowDownload(event.target.checked)} /><span />允许下载 H5</label></div>
              <button className="share-create-button" onClick={() => void createShare()} disabled={isSharing}>{isSharing ? "正在生成…" : "生成并复制链接"}<AppIcon name="arrow" /></button>
            </>
          )}
          {shareError && <p className="share-error" role="alert">{shareError}</p>}
          <p className="share-hint">分享记录与文档绑定保存，链接可按有效期、下载权限随时撤销。</p>
        </section>}
      </div>
      <div className="tts-player">
        <button className="play-button" onClick={playSpeech} aria-label={speaking ? (isMeloSynthesizing ? "取消生成" : "暂停播放") : "开始播放"}><AppIcon name={speaking ? "pause" : "play"} /></button>
        <div className="track-info"><div><strong>{isMeloSynthesizing ? "正在生成音频 · " : speaking ? "正在朗读 · " : "准备就绪 · "}{ttsProvider === "melotts" ? "MeloTTS" : "浏览器语音"}</strong><span>{isMeloSynthesizing ? "MeloTTS 正在合成音频，点击暂停可取消" : readerDocument.sections[0]?.title || readerDocument.title}</span></div><div className={`audio-progress${isMeloSynthesizing ? " is-synthesizing" : ""}`}><span style={{ width: `${speechProgress}%` }} /></div></div>
        <div className="voice-select" aria-label="朗读方式"><span className="voice-label">朗读方式</span><span>系统默认语音</span></div>
        <span className="speed-pill">1.0×</span>
      </div>
      {notice && <button className="toast" onClick={() => setNotice("")} aria-label="关闭提示">{notice}<span>×</span></button>}
    </main>
  );

  const renderLibrary = () => (
    <main className="library-page">
      <div className="page-heading"><div><p className="overline">个人空间</p><h1>我的知识库</h1><p>你导入的每份资料，都会自动在这里建立私有索引。</p></div><button className="primary-button" onClick={() => setView("create")}><AppIcon name="plus" />导入新资料</button></div>
      <div className="library-stats"><div><small>已收录资料</small><strong>{storedDocuments.length}</strong><span>仅当前用户可见</span></div><div><small>可检索知识块</small><strong>{storedDocuments.filter((item) => item.status === "ready").length}</strong><span>资料已建立索引</span></div><div><small>处理状态</small><strong>{storedDocuments.filter((item) => item.status === "ready").length}/{storedDocuments.length}</strong><span>已完成转换</span></div></div>
      <div className="library-toolbar"><div className="search-box"><span>⌕</span><input aria-label="搜索知识库" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void searchLibrary()} placeholder="搜索文件名或资料正文…" /></div><button onClick={() => void searchLibrary()}>检索</button><button onClick={() => { setLibraryQuery(""); setSearchHits([]); void loadLibrary(); }}>刷新</button></div>
      {libraryError && <p className="field-error library-error" role="alert">{libraryError}</p>}
      {searchHits.length > 0 && <section className="search-results" aria-label="知识检索结果"><p>找到 {searchHits.length} 条相关内容</p>{searchHits.map((hit) => <button key={hit.chunk_id} onClick={() => { const item = storedDocuments.find((document) => document.id === hit.document_id); if (item) void openStoredDocument(item); }}><strong>{hit.document_title}</strong><span>{hit.heading_path.join(" / ")}</span><small>{hit.text}</small></button>)}</section>}
      <div className="library-grid">{storedDocuments.map((item, index) => {
        const type = item.filename?.split(".").pop()?.toUpperCase() || (item.source_type === "url" ? "URL" : "DOC");
        const color = ["coral", "blue", "green", "amber"][index % 4];
        const size = item.size_bytes ? `${(item.size_bytes / 1024 / 1024).toFixed(1)} MB` : "网页导入";
        return <button className="library-card" key={item.id} onClick={() => void openStoredDocument(item)}><div className={`library-cover ${color}`}><span>{type}</span><i /><i /><i /></div><div className="library-card-body"><span className="indexed"><i /> {item.status === "ready" ? "已完成索引" : item.status === "failed" ? "转换失败" : "正在处理"}</span><h2>{item.title}</h2><p>{type} · {size} · {item.word_count.toLocaleString()} 字</p><div><span>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.updated_at))}</span><span>{item.status === "ready" ? "打开阅读页 →" : "查看状态"}</span></div></div></button>;
      })}</div>
      {!libraryLoading && !storedDocuments.length && <div className="library-empty"><strong>还没有已保存的资料</strong><p>从网址或 DOCX、MD、TXT、PDF、XLSX 导入后，它会在这里形成个人知识索引。</p><button className="primary-button" onClick={() => setView("create")}>开始导入</button></div>}
      <div className="tenant-banner"><AppIcon name="lock" /><div><strong>你的知识，只属于你</strong><p>平台在数据库、对象存储和检索服务三层强制执行用户与租户隔离。</p></div><span>当前用户 · 私有</span></div>
    </main>
  );

  const renderHistory = () => (
    <main className="library-page history-page">
      <div className="page-heading"><div><p className="overline">处理中心</p><h1>处理记录</h1><p>查看每次网址抓取或文档解析的状态；已完成的资料可直接打开阅读。</p></div><button className="primary-button" onClick={() => setView("create")}><AppIcon name="plus" />导入新资料</button></div>
      {libraryError && <p className="field-error library-error" role="alert">{libraryError}</p>}
      {libraryLoading ? <div className="history-empty">正在读取处理记录…</div> : storedDocuments.length ? <section className="history-list" aria-label="处理记录列表">{storedDocuments.map((item) => {
        const type = item.filename?.split(".").pop()?.toUpperCase() || (item.source_type === "url" ? "URL" : "DOC");
        const statusText = item.status === "ready" ? "已完成" : item.status === "failed" ? "处理失败" : item.status === "parsing" ? "正在解析" : "等待处理";
        return <button key={item.id} className="history-item" onClick={() => void openStoredDocument(item)}><span className={`history-status ${item.status}`}>{statusText}</span><div><strong>{item.title}</strong><small>{type} · {item.source_type === "url" ? item.source_url : item.filename || "上传文件"}</small></div><span>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.updated_at))}</span><b>{item.status === "ready" ? "打开阅读页 →" : "查看详情"}</b></button>;
      })}</section> : <div className="history-empty"><strong>暂时没有处理记录</strong><p>导入 DOCX、PDF、XLSX、TXT、Markdown 或网页链接后，状态会显示在这里。</p><button className="primary-button" onClick={() => setView("create")}>开始导入</button></div>}
      <div className="tenant-banner"><AppIcon name="lock" /><div><strong>记录和资料均为私有</strong><p>当前列表只返回属于当前用户与租户的处理任务。</p></div><span>当前用户 · 私有</span></div>
    </main>
  );

  const renderApi = () => (
    <main className="api-page">
      <div className="api-intro"><p className="overline">前后端联调契约</p><h1>一套可版本化的 API，<br />覆盖完整处理链路。</h1><p>上传、网页抓取、任务进度、阅读页、TTS 与知识检索全部使用统一错误结构和幂等机制。</p><a href="/openapi.yaml" download>下载 OpenAPI 3.1 契约 <span>↓</span></a></div>
      <div className="endpoint-list">
        {[
          ["GET", "/v1/auth/me", "获取当前登录身份与隔离边界"],
          ["POST", "/v1/auth/local-register", "本地体验账号注册（仅 localhost）"],
          ["POST", "/v1/auth/local-signin", "本地体验账号登录（仅 localhost）"],
          ["POST", "/v1/auth/local-bind-phone", "为旧本机账号绑定手机号并保留资料"],
          ["POST", "/v1/auth/local-signout", "退出当前本地体验账号"],
          ["POST", "/v1/assets/uploads", "创建文件上传会话"],
          ["POST", "/v1/documents:import-url", "提交 Crawl4AI 抓取任务"],
          ["POST", "/v1/documents", "完成上传并创建处理任务"],
          ["GET", "/v1/jobs/{job_id}/events", "SSE 订阅实时进度"],
          ["GET", "/v1/documents/{document_id}", "获取文档与产物状态"],
          ["GET", "/v1/documents/{document_id}/reader", "获取结构化阅读模型"],
          ["POST", "/v1/documents/{document_id}/shares", "生成可撤销的阅读分享链接"],
          ["GET", "/v1/public/shares/{share_token}", "匿名打开已授权的分享阅读页"],
          ["POST", "/v1/tts/synthesize", "使用私有 MeloTTS 合成音频"],
          ["POST", "/v1/knowledge/search", "在当前用户知识库检索"],
        ].map(([method, path, desc]) => <div className="endpoint" key={path}><span className={`method ${method.toLowerCase()}`}>{method}</span><code>{path}</code><p>{desc}</p><button aria-label={`查看 ${path}`}>↗</button></div>)}
      </div>
      <section className="api-principles"><div><span>01</span><h2>异步优先</h2><p>耗时任务立即返回 202 与 job_id，进度通过 SSE 推送。</p></div><div><span>02</span><h2>安全直传</h2><p>大文件使用预签名 URL 直传对象存储，避免经过 API 服务器。</p></div><div><span>03</span><h2>天然隔离</h2><p>tenant_id 和 user_id 从身份令牌中解析，业务请求无权覆盖。</p></div></section>
    </main>
  );

  const renderAuthCard = (required = false) => (
    <section className={`auth-dialog${required ? " auth-dialog-required" : ""}`} role="dialog" aria-modal={!required} aria-labelledby="login-title">
      {!required && <button className="auth-close" onClick={() => setLoginOpen(false)} aria-label="关闭登录窗口">×</button>}
      <p className="overline">私有空间</p>
      <h2 id="login-title">{localDevelopment && localAuthMode === "register" ? "创建你的私有空间" : "登录后管理你的资料"}</h2>
      <p>文档、H5、知识检索与分享记录均按登录用户在服务端隔离。</p>
      {localDevelopment ? <>
        <div className="auth-mode-tabs" role="tablist" aria-label="账号操作">
          <button className={localAuthMode === "signin" ? "active" : ""} onClick={() => { setLocalAuthMode("signin"); setLoginError(""); }} role="tab" aria-selected={localAuthMode === "signin"}>登录</button>
          <button className={localAuthMode === "register" ? "active" : ""} onClick={() => { setLocalAuthMode("register"); setLoginError(""); }} role="tab" aria-selected={localAuthMode === "register"}>注册</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void (localAuthMode === "register" ? registerLocal() : signInLocal()); }}>
          {localAuthMode === "register" && <label>显示名称<input value={loginName} onChange={(event) => setLoginName(event.target.value)} maxLength={80} autoComplete="name" required /></label>}
          <label>手机号<input type="tel" value={loginPhone} onChange={(event) => setLoginPhone(event.target.value)} inputMode="tel" maxLength={20} autoComplete="tel-national" placeholder="请输入中国大陆手机号" required /></label>
          <label>密码<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} minLength={8} maxLength={128} autoComplete={localAuthMode === "register" ? "new-password" : "current-password"} required /></label>
          {localAuthMode === "register" && <label>确认密码<input type="password" value={loginPasswordConfirmation} onChange={(event) => setLoginPasswordConfirmation(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /></label>}
          {loginError && <small className="auth-error" role="alert">{loginError}</small>}
          <button className="primary-button" disabled={loginSubmitting}>{loginSubmitting ? "正在处理…" : localAuthMode === "register" ? "注册并进入私有空间" : "登录私有空间"}</button>
        </form>
        <p className="auth-switch">{localAuthMode === "register" ? "已有账号？" : "还没有账号？"}<button onClick={() => { setLocalAuthMode(localAuthMode === "register" ? "signin" : "register"); setLoginError(""); }}>{localAuthMode === "register" ? "去登录" : "立即注册"}</button></p>
        <small className="auth-hint">手机号是本机账号的唯一标识；资料、索引、原文件与分享记录均只归属该手机号对应的用户。密码经不可逆派生后存储。</small>
      </> : <>
        <button className="primary-button" onClick={() => { if (signInUrl) window.location.assign(signInUrl); }} disabled={!signInUrl}>使用 ChatGPT 登录</button>
        <small className="auth-hint">平台会验证身份，应用不会保存你的登录密码。</small>
      </>}
    </section>
  );

  if (!authReady) {
    return <div className="app-shell auth-gate-shell"><main className="auth-loading" aria-live="polite"><Wordmark /><p>正在验证登录状态…</p></main></div>;
  }

  if (!currentUser) {
    return <div className="app-shell auth-gate-shell">
      <header className="auth-gate-header"><Wordmark /><span>私有知识库 · 安全阅读</span></header>
      <main className="auth-gate">
        <section className="auth-gate-copy"><p className="overline">声阅 · 私有内容工作台</p><h1>先登录，再让资料<br />成为会朗读的网页。</h1><p>上传、网页抓取、知识库、下载和分享都仅在身份验证后可用。每份资料都会归入你的私有空间。</p><div><span>用户级隔离</span><span>私有文件存储</span><span>可撤销分享</span></div></section>
        {renderAuthCard(true)}
      </main>
    </div>;
  }

  const mobileCreateView = renderMobileCreate();

  return (
    <div className={`app-shell view-${view}`}>
      <header className="app-header">
        <button className="brand-button" onClick={() => setView("create")}><Wordmark /></button>
        <nav aria-label="主导航">
          <button className={view === "create" || view === "processing" || view === "reader" ? "active" : ""} onClick={() => setView("create")}><AppIcon name="plus" />创建阅读</button>
          <button className={view === "library" ? "active" : ""} onClick={openLibrary}><AppIcon name="book" />我的知识库</button>
          <button className={view === "history" ? "active" : ""} onClick={openHistory}><AppIcon name="clock" />处理记录</button>
          <button className={view === "api" ? "active" : ""} onClick={() => setView("api")}><AppIcon name="code" />API 文档</button>
        </nav>
        <div className="header-actions"><button className="demo-link" onClick={() => { if (!requireLogin()) return; setReaderDocument(demoDocument); setSourceType("file"); setSelectedFile(null); setProcessingName(demoDocument.title); setView("reader"); }}>体验阅读示例 <span>→</span></button><div className="account-summary"><span className="avatar" aria-hidden="true">{currentUser.display_name.slice(0, 2).toUpperCase()}<i /></span><span className="account-name" title={currentUser.phone || currentUser.email || currentUser.display_name}>{currentUser.display_name}</span><button className="logout-button" onClick={() => void signOut()}>退出登录</button></div></div>
      </header>
      {view === "create" && <><div className="desktop-create-view">{renderCreate()}</div>{mobileCreateView}</>}
      <div className="desktop-route-view">
        {view === "processing" && renderProcessing()}
        {view === "reader" && renderReader()}
        {view === "library" && renderLibrary()}
        {view === "history" && renderHistory()}
        {view === "api" && renderApi()}
      </div>
      {view !== "create" && <div className="mobile-route-view">{renderMobileRoute()}</div>}
      {view === "create" && <footer><span>© 2026 声阅</span><span>隐私保护 · 数据安全 · 服务状态</span><span><i /> 全部系统正常</span></footer>}
      {loginOpen && <div className="auth-backdrop" role="presentation">{renderAuthCard()}</div>}
    </div>
  );
}
