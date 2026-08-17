import { ensureDocumentStore, getAuthenticatedActor, type DocumentEnv } from "./documents";

export interface TtsEnv extends Pick<DocumentEnv, "DB"> {
  CUSTOMER_HTTP_TTS?: Fetcher;
  LOCAL_TTS_URL?: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function problem(message: string, status: number, code: string): Response {
  return json({ error: code, message }, status);
}

function localTtsUrl(env: TtsEnv): string | null {
  return env.LOCAL_TTS_URL?.replace(/\/$/, "") || null;
}

async function callTts(env: TtsEnv, pathname: string, init: RequestInit): Promise<Response> {
  if (env.CUSTOMER_HTTP_TTS) return env.CUSTOMER_HTTP_TTS.fetch(`http://tts.internal${pathname}`, init);
  const localUrl = localTtsUrl(env);
  if (localUrl) return fetch(`${localUrl}${pathname}`, init);
  throw new Error("私有 TTS 服务尚未配置。请启动 CosyVoice，或在部署环境配置 CUSTOMER_HTTP_TTS 私有绑定。");
}

function passAudio(response: Response): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") || "audio/wav",
    "x-tts-provider": response.headers.get("x-tts-provider") || "CosyVoice",
  });
  const model = response.headers.get("x-tts-model");
  if (model) headers.set("x-tts-model", model);
  return new Response(response.body, { status: response.status, headers });
}

async function upstreamProblem(response: Response): Promise<Response> {
  const body = await response.json<{ detail?: string; message?: string }>().catch(() => ({}));
  return problem(body.detail || body.message || "CosyVoice 合成失败。", response.status >= 500 ? 503 : response.status, "TTS_UPSTREAM_ERROR");
}

export async function handleTtsRequest(request: Request, env: TtsEnv): Promise<Response> {
  await ensureDocumentStore(env);
  const actor = await getAuthenticatedActor(request, env);
  if (!actor) return problem("请先登录后再使用私有 TTS。", 401, "UNAUTHENTICATED");
  const url = new URL(request.url);
  const headers = new Headers({
    "x-tenant-id": actor.tenantId,
    "x-owner-user-id": actor.userId,
  });

  if (request.method === "GET" && url.pathname === "/api/tts/voices") {
    try {
      const response = await callTts(env, "/v1/voices", { headers });
      if (!response.ok) return upstreamProblem(response);
      const data = await response.json<{ provider?: string; model?: string; items?: unknown[] }>();
      if (!Array.isArray(data.items)) return problem("CosyVoice 未返回可用音色。", 503, "TTS_INVALID_RESPONSE");
      return json({ provider: data.provider || "cosyvoice", model: data.model || null, items: data.items });
    } catch (error) {
      return problem(error instanceof Error ? error.message : "私有 TTS 服务不可用。", 503, "TTS_UNAVAILABLE");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/tts/synthesize") {
    const body = await request.json<{ text?: string; voice_id?: string; speed?: number }>().catch(() => null);
    const text = body?.text?.trim() || "";
    const voiceId = body?.voice_id?.trim() || "";
    const speed = Number(body?.speed) || 1;
    if (!text || text.length > 1_500 || !voiceId || voiceId.length > 120 || speed < 0.75 || speed > 1.25) {
      return problem("TTS 请求参数无效。", 422, "INVALID_TTS_REQUEST");
    }
    try {
      headers.set("content-type", "application/json");
      const response = await callTts(env, "/v1/synthesize", {
        method: "POST",
        headers,
        body: JSON.stringify({ text, voice_id: voiceId, speed }),
        signal: request.signal,
      });
      if (!response.ok) return upstreamProblem(response);
      return passAudio(response);
    } catch (error) {
      return problem(error instanceof Error ? error.message : "私有 TTS 服务不可用。", 503, "TTS_UNAVAILABLE");
    }
  }

  return problem("未知的 TTS 接口。", 404, "NOT_FOUND");
}
