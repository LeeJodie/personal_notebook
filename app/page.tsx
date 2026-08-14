"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";

type View = "create" | "processing" | "reader" | "library" | "api";
type SourceType = "file" | "url";

const supportedExtensions = ["DOCX", "DOC", "MD", "XLSX", "XLS", "PPTX", "PPT", "PDF"];

const sampleSections = [
  {
    id: "overview",
    eyebrow: "01 / 项目概述",
    title: "从静态文档到可听、可搜索的知识",
    paragraphs: [
      "企业中的知识往往分散在网页、PDF、演示文稿和电子表格里。声阅将这些不同的内容统一转换为结构化网页，保留标题、段落、表格与图片的阅读层次。",
      "转换完成后，用户可以像阅读杂志一样浏览，也可以选择音色连续收听。原文件与 H5 成品会作为同一份资料的两种交付形式。",
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
];

const libraryItems = [
  { name: "2026 年产品战略与路线图", type: "PPTX", size: "18.6 MB", chunks: 126, time: "8 分钟前", color: "coral" },
  { name: "智能阅读项目建设方案", type: "PDF", size: "4.2 MB", chunks: 84, time: "昨天 16:42", color: "blue" },
  { name: "客户访谈洞察整理", type: "DOCX", size: "2.8 MB", chunks: 51, time: "8 月 12 日", color: "green" },
  { name: "运营核心指标追踪", type: "XLSX", size: "7.1 MB", chunks: 38, time: "8 月 10 日", color: "amber" },
];

function Wordmark() {
  return (
    <div className="wordmark" aria-label="声阅">
      <span className="logo-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>声阅</span>
    </div>
  );
}

function AppIcon({ name }: { name: "plus" | "book" | "clock" | "code" | "arrow" | "upload" | "link" | "file" | "lock" | "download" | "play" | "pause" | "check" }) {
  const map = {
    plus: "+", book: "▦", clock: "◷", code: "</>", arrow: "↗", upload: "↑", link: "∞", file: "▤", lock: "◈", download: "↓", play: "▶", pause: "Ⅱ", check: "✓",
  };
  return <span className={`app-icon icon-${name}`} aria-hidden="true">{map[name]}</span>;
}

export default function Home() {
  const [view, setView] = useState<View>("create");
  const [sourceType, setSourceType] = useState<SourceType>("file");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processingName, setProcessingName] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [speechProgress, setSpeechProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const articleText = useMemo(
    () => sampleSections.flatMap((section) => [section.title, ...section.paragraphs]).join("。"),
    [],
  );

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
    if (view !== "processing") return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(current + (current < 55 ? 9 : current < 85 ? 4 : 2), 100);
        if (next === 100) {
          window.clearInterval(timer);
          window.setTimeout(() => setView("reader"), 450);
        }
        return next;
      });
    }, 320);
    return () => window.clearInterval(timer);
  }, [view]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const startProcessing = (name: string) => {
    setProcessingName(name);
    setProgress(6);
    setView("processing");
    setNotice("");
  };

  const submitUrl = () => {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("invalid");
      setUrlError("");
      startProcessing(parsed.hostname);
    } catch {
      setUrlError("请输入完整的 http:// 或 https:// 链接");
    }
  };

  const acceptFile = (file?: File) => {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toUpperCase() || "";
    if (!supportedExtensions.includes(ext)) {
      setNotice("暂不支持该文件类型，请上传 DOCX、PDF、PPTX、Excel 或 Markdown。");
      return;
    }
    setSelectedFile(file);
    setNotice("");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const playSpeech = () => {
    if (!("speechSynthesis" in window)) {
      setNotice("当前浏览器不支持语音播放。");
      return;
    }
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(articleText);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.voice = voices.find((voice) => voice.name === voiceName) || null;
    utterance.onboundary = (event) => setSpeechProgress(Math.min(100, Math.round((event.charIndex / articleText.length) * 100)));
    utterance.onend = () => { setSpeaking(false); setSpeechProgress(100); };
    utterance.onerror = () => setSpeaking(false);
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  const downloadOriginal = () => {
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
    const sections = sampleSections.map((section) => `<section><p class="eyebrow">${section.eyebrow}</p><h2>${section.title}</h2>${section.paragraphs.map((p) => `<p>${p}</p>`).join("")}</section>`).join("");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>声阅导出阅读页</title><style>body{margin:0;background:#f5f5f1;color:#20221d;font:17px/1.9 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:72px 24px 140px}h1{font-size:42px;line-height:1.2}h2{font-size:28px;line-height:1.35;margin-top:56px}.eyebrow{color:#e25d3f;font-size:12px;font-weight:700;letter-spacing:.12em}.player{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:#20221d;color:white;padding:12px 18px;border-radius:18px;box-shadow:0 12px 40px #0003}.player button,.player select{border:0;border-radius:10px;padding:10px 14px}</style></head><body><main><p class="eyebrow">声阅 · 智能阅读</p><h1>${processingName || "智能阅读项目建设方案"}</h1>${sections}</main><div class="player"><button id="play">▶ 开始播放</button><select id="voices" aria-label="选择音色"></select></div><script>const text=document.querySelector('main').innerText,v=document.querySelector('#voices'),b=document.querySelector('#play');function load(){const a=speechSynthesis.getVoices();v.innerHTML=a.map((x,i)=>'<option value="'+i+'">'+x.name+' · '+x.lang+'</option>').join('');}load();speechSynthesis.onvoiceschanged=load;b.onclick=()=>{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text),a=speechSynthesis.getVoices();u.voice=a[v.value]||null;u.lang='zh-CN';speechSynthesis.speak(u);};</script></body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${processingName || "声阅阅读页"}.html`;
    link.click();
    URL.revokeObjectURL(href);
    setNotice("H5 阅读页已导出，可直接在浏览器中打开。");
  };

  const renderCreate = () => (
    <main className="create-page">
      <section className="hero-copy">
        <div className="signal-pill"><span /> 内容正在变得更好听</div>
        <h1>把任何资料，<br />变成会朗读的网页。</h1>
        <p>导入网页或文档，自动生成排版清晰的 H5 阅读页，<br className="desktop-break" />一边阅读，一边选择喜欢的声音收听。</p>
      </section>

      <section className="import-card" aria-label="导入资料">
        <div className="source-tabs" role="tablist">
          <button className={sourceType === "file" ? "active" : ""} onClick={() => setSourceType("file")} role="tab" aria-selected={sourceType === "file"}><AppIcon name="file" />上传文件</button>
          <button className={sourceType === "url" ? "active" : ""} onClick={() => setSourceType("url")} role="tab" aria-selected={sourceType === "url"}><AppIcon name="link" />网页链接</button>
        </div>

        {sourceType === "file" ? (
          <div className={`drop-zone ${dragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
            <input ref={fileInput} type="file" accept=".doc,.docx,.md,.xls,.xlsx,.ppt,.pptx,.pdf" onChange={(event) => acceptFile(event.target.files?.[0])} />
            {selectedFile ? (
              <>
                <div className="file-ready"><span className="file-badge">{selectedFile.name.split(".").pop()?.toUpperCase()}</span><div><strong>{selectedFile.name}</strong><small>{(selectedFile.size / 1024 / 1024).toFixed(1)} MB · 已就绪</small></div><AppIcon name="check" /></div>
                <div className="ready-actions"><button className="text-button" onClick={() => fileInput.current?.click()}>更换文件</button><button className="primary-button" onClick={() => startProcessing(selectedFile.name)}>开始转换 <span>→</span></button></div>
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
            <div className={`url-field ${urlError ? "error" : ""}`}><AppIcon name="link" /><input id="page-url" value={url} onChange={(event) => { setUrl(event.target.value); setUrlError(""); }} onKeyDown={(event) => event.key === "Enter" && submitUrl()} placeholder="https://example.com/article" /><button onClick={submitUrl}>抓取并转换 <span>→</span></button></div>
            {urlError ? <p className="field-error">{urlError}</p> : <p className="url-help">Crawl4AI 将自动识别正文、标题、图片与表格结构</p>}
            <div className="url-example"><span>没有链接？</span><button onClick={() => { setUrl("https://docs.example.com/ai-reading"); setUrlError(""); }}>使用示例链接</button></div>
          </div>
        )}
        {notice && <div className="notice" role="status">{notice}</div>}
      </section>

      <section className="trust-row" aria-label="核心优势">
        <div><AppIcon name="lock" /><span><strong>私有存储</strong><small>用户级知识库隔离</small></span></div>
        <div><span className="mini-wave"><i /><i /><i /></span><span><strong>多音色 TTS</strong><small>语速、音色随时切换</small></span></div>
        <div><AppIcon name="download" /><span><strong>双份导出</strong><small>H5 阅读页 + 原文件</small></span></div>
      </section>
    </main>
  );

  const renderProcessing = () => {
    const steps = [
      { label: "资源校验", at: 8 }, { label: sourceType === "url" ? "Crawl4AI 抓取" : "内容解析", at: 24 }, { label: "版面归一化", at: 48 }, { label: "生成 H5", at: 68 }, { label: "知识切分", at: 82 }, { label: "构建索引", at: 96 },
    ];
    return (
      <main className="processing-page">
        <button className="back-link" onClick={() => setView("create")}>← 返回导入</button>
        <section className="processing-card">
          <div className="processing-animation"><span className="doc-sheet"><i /><i /><i /></span><span className="pulse-ring ring-one" /><span className="pulse-ring ring-two" /></div>
          <p className="overline">正在转换</p>
          <h1>{processingName}</h1>
          <p>内容很快就会变成可阅读、可朗读的网页</p>
          <div className="big-progress"><span style={{ width: `${progress}%` }} /></div>
          <div className="progress-meta"><strong>{progress}%</strong><span>预计剩余 {Math.max(1, Math.round((100 - progress) / 18))} 秒</span></div>
          <div className="pipeline-steps">{steps.map((step) => <div key={step.label} className={progress >= step.at ? "done" : progress + 16 >= step.at ? "current" : ""}><span>{progress >= step.at ? "✓" : ""}</span><small>{step.label}</small></div>)}</div>
        </section>
        <p className="processing-tip">你可以离开此页，转换会在后台继续</p>
      </main>
    );
  };

  const renderReader = () => (
    <main className="reader-page">
      <aside className="reader-outline">
        <button className="back-link" onClick={() => { window.speechSynthesis?.cancel(); setSpeaking(false); setView("create"); }}>← 返回</button>
        <div className="outline-file"><span className="pdf-tile">{selectedFile?.name.split(".").pop()?.toUpperCase() || (sourceType === "url" ? "URL" : "PDF")}</span><div><strong>{processingName || "智能阅读项目建设方案"}</strong><small>3 章 · 约 6 分钟</small></div></div>
        <p className="outline-title">文章目录</p>
        <nav>{sampleSections.map((section, index) => <a key={section.id} href={`#${section.id}`}><span>0{index + 1}</span>{section.title}</a>)}</nav>
        <div className="private-note"><AppIcon name="lock" /><span><strong>已存入私有知识库</strong><small>仅你可检索这份资料</small></span></div>
      </aside>
      <article className="reader-article">
        <div className="article-meta"><span>声阅智能排版</span><span>·</span><span>2026 年 8 月 14 日</span></div>
        <h1>{processingName || "智能阅读项目建设方案"}</h1>
        <p className="article-deck">从内容导入、结构化处理到语音阅读与私有知识库，构建一套稳定、可扩展的企业级内容阅读平台。</p>
        <div className="article-rule" />
        {sampleSections.map((section) => <section key={section.id} id={section.id}><p className="section-eyebrow">{section.eyebrow}</p><h2>{section.title}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>)}
        <div className="article-end"><span /> 文章结束 <span /></div>
      </article>
      <div className="reader-actions">
        <button className="secondary-action" onClick={downloadOriginal}><AppIcon name="download" />原文件</button>
        <button className="export-action" onClick={exportH5}><AppIcon name="arrow" />导出 H5</button>
      </div>
      <div className="tts-player">
        <button className="play-button" onClick={playSpeech} aria-label={speaking ? "暂停播放" : "开始播放"}><AppIcon name={speaking ? "pause" : "play"} /></button>
        <div className="track-info"><div><strong>{speaking ? "正在朗读 · " : "准备就绪 · "}01</strong><span>{sampleSections[0].title}</span></div><div className="audio-progress"><span style={{ width: `${speechProgress}%` }} /></div></div>
        <div className="voice-select"><label htmlFor="voice">音色</label><select id="voice" value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>{voices.length ? voices.slice(0, 12).map((voice) => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} · {voice.lang}</option>) : <option>系统默认音色</option>}</select></div>
        <span className="speed-pill">1.0×</span>
      </div>
      {notice && <button className="toast" onClick={() => setNotice("")} aria-label="关闭提示">{notice}<span>×</span></button>}
    </main>
  );

  const renderLibrary = () => (
    <main className="library-page">
      <div className="page-heading"><div><p className="overline">个人空间</p><h1>我的知识库</h1><p>你导入的每份资料，都会自动在这里建立私有索引。</p></div><button className="primary-button" onClick={() => setView("create")}><AppIcon name="plus" />导入新资料</button></div>
      <div className="library-stats"><div><small>已收录资料</small><strong>24</strong><span>本月 +7</span></div><div><small>可检索知识块</small><strong>1,284</strong><span>100% 已索引</span></div><div><small>已转换阅读时长</small><strong>6.8h</strong><span>约节省 4.1h</span></div></div>
      <div className="library-toolbar"><div className="search-box"><span>⌕</span><input aria-label="搜索知识库" placeholder="搜索文件名、类型或内容…" /></div><button>全部类型 ⌄</button><button>最近更新 ⌄</button></div>
      <div className="library-grid">{libraryItems.map((item) => <button className="library-card" key={item.name} onClick={() => { setProcessingName(item.name); setView("reader"); }}><div className={`library-cover ${item.color}`}><span>{item.type}</span><i /><i /><i /></div><div className="library-card-body"><span className="indexed"><i /> 已完成索引</span><h2>{item.name}</h2><p>{item.type} · {item.size} · {item.chunks} 个知识块</p><div><span>{item.time}</span><span>打开阅读 →</span></div></div></button>)}</div>
      <div className="tenant-banner"><AppIcon name="lock" /><div><strong>你的知识，只属于你</strong><p>平台在数据库、对象存储和向量检索三层强制执行用户与租户隔离。</p></div><span>tenant_8f3a · 私有</span></div>
    </main>
  );

  const renderApi = () => (
    <main className="api-page">
      <div className="api-intro"><p className="overline">前后端联调契约</p><h1>一套可版本化的 API，<br />覆盖完整处理链路。</h1><p>上传、网页抓取、任务进度、阅读页、TTS 与知识检索全部使用统一错误结构和幂等机制。</p><a href="/openapi.yaml" download>下载 OpenAPI 3.1 契约 <span>↓</span></a></div>
      <div className="endpoint-list">
        {[
          ["POST", "/v1/assets/uploads", "创建文件上传会话"],
          ["POST", "/v1/documents:import-url", "提交 Crawl4AI 抓取任务"],
          ["POST", "/v1/documents", "完成上传并创建处理任务"],
          ["GET", "/v1/jobs/{job_id}/events", "SSE 订阅实时进度"],
          ["GET", "/v1/documents/{document_id}", "获取文档与产物状态"],
          ["GET", "/v1/documents/{document_id}/reader", "获取结构化阅读模型"],
          ["POST", "/v1/tts/sessions", "创建 TTS 流式会话"],
          ["POST", "/v1/knowledge/search", "在当前用户知识库检索"],
        ].map(([method, path, desc]) => <div className="endpoint" key={path}><span className={`method ${method.toLowerCase()}`}>{method}</span><code>{path}</code><p>{desc}</p><button aria-label={`查看 ${path}`}>↗</button></div>)}
      </div>
      <section className="api-principles"><div><span>01</span><h2>异步优先</h2><p>耗时任务立即返回 202 与 job_id，进度通过 SSE 推送。</p></div><div><span>02</span><h2>安全直传</h2><p>大文件使用预签名 URL 直传对象存储，避免经过 API 服务器。</p></div><div><span>03</span><h2>天然隔离</h2><p>tenant_id 和 user_id 从身份令牌中解析，业务请求无权覆盖。</p></div></section>
    </main>
  );

  return (
    <div className={`app-shell view-${view}`}>
      <header className="app-header">
        <button className="brand-button" onClick={() => setView("create")}><Wordmark /></button>
        <nav aria-label="主导航">
          <button className={view === "create" || view === "processing" || view === "reader" ? "active" : ""} onClick={() => setView("create")}><AppIcon name="plus" />创建阅读</button>
          <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}><AppIcon name="book" />我的知识库</button>
          <button onClick={() => setView("library")}><AppIcon name="clock" />处理记录</button>
          <button className={view === "api" ? "active" : ""} onClick={() => setView("api")}><AppIcon name="code" />API 文档</button>
        </nav>
        <div className="header-actions"><button className="demo-link" onClick={() => { setProcessingName("智能阅读项目建设方案"); setView("reader"); }}>体验阅读示例 <span>→</span></button><button className="avatar" aria-label="用户菜单">MK<span /></button></div>
      </header>
      {view === "create" && renderCreate()}
      {view === "processing" && renderProcessing()}
      {view === "reader" && renderReader()}
      {view === "library" && renderLibrary()}
      {view === "api" && renderApi()}
      {view === "create" && <footer><span>© 2026 声阅</span><span>隐私保护 · 数据安全 · 服务状态</span><span><i /> 全部系统正常</span></footer>}
    </div>
  );
}
