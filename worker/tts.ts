import { ensureDocumentStore, getAuthenticatedActor, type DocumentEnv } from "./documents";

export interface TtsEnv extends Pick<DocumentEnv, "DB"> {
  CUSTOMER_HTTP_TTS?: Fetcher;
  LOCAL_TTS_URL?: string;
}

export interface MeloTtsVoice {
  id: string;
  label: string;
  language: string;
}

export type TtsMode = "local" | "online";

export const MIN_MELOTTS_SPEED = 0.5;
export const MAX_MELOTTS_SPEED = 2;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function problem(message: string, status: number, code: string): Response {
  return json({ error: code, message }, status);
}

function localTtsUrl(env: TtsEnv): string | null {
  return env.LOCAL_TTS_URL?.replace(/\/$/, "") || null;
}

async function callTts(env: Pick<TtsEnv, "CUSTOMER_HTTP_TTS" | "LOCAL_TTS_URL">, pathname: string, init: RequestInit): Promise<Response> {
  if (env.CUSTOMER_HTTP_TTS) return env.CUSTOMER_HTTP_TTS.fetch(`http://tts.internal${pathname}`, init);
  const localUrl = localTtsUrl(env);
  if (localUrl) return fetch(`${localUrl}${pathname}`, init);
  throw new Error("私有 TTS 服务尚未配置。请启动 MeloTTS，或在部署环境配置 CUSTOMER_HTTP_TTS 私有绑定。");
}

export function passAudio(response: Response): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") || "audio/wav",
    "x-tts-provider": response.headers.get("x-tts-provider") || "MeloTTS",
  });
  const model = response.headers.get("x-tts-model");
  if (model) headers.set("x-tts-model", model);
  return new Response(response.body, { status: response.status, headers });
}

function readTtsMode(value: unknown): TtsMode {
  return value === "online" ? "online" : "local";
}

export async function listMeloTtsVoices(env: Pick<TtsEnv, "CUSTOMER_HTTP_TTS" | "LOCAL_TTS_URL">, headers = new Headers(), mode: TtsMode = "local"): Promise<{ provider: string; model: string | null; items: MeloTtsVoice[] }> {
  const response = await callTts(env, `/v1/voices?mode=${mode}`, { headers });
  if (!response.ok) throw new Error((await response.json<{ detail?: string; message?: string }>().catch(() => ({}))).detail || "MeloTTS 音色服务不可用。");
  const data = await response.json<{ provider?: string; model?: string; items?: MeloTtsVoice[] }>();
  if (!Array.isArray(data.items)) throw new Error("MeloTTS 未返回可用音色。");
  return { provider: data.provider || "melotts", model: data.model || null, items: data.items };
}

export async function synthesizeMeloTts(env: Pick<TtsEnv, "CUSTOMER_HTTP_TTS" | "LOCAL_TTS_URL">, payload: { text: string; voiceId: string; speed: number; mode?: TtsMode }, headers = new Headers(), signal?: AbortSignal): Promise<Response> {
  const { text, voiceId, speed } = payload;
  const mode = readTtsMode(payload.mode);
  if (!text || text.length > 1_500 || !voiceId || voiceId.length > 120 || speed < MIN_MELOTTS_SPEED || speed > MAX_MELOTTS_SPEED) {
    throw new Error("TTS 请求参数无效。");
  }
  headers.set("content-type", "application/json");
  const response = await callTts(env, "/v1/synthesize", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, voice_id: voiceId, speed, mode }),
    signal,
  });
  if (!response.ok) throw new Error((await response.json<{ detail?: string; message?: string }>().catch(() => ({}))).detail || "MeloTTS 合成失败。");
  return passAudio(response);
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
      return json(await listMeloTtsVoices(env, headers, readTtsMode(url.searchParams.get("mode"))));
    } catch (error) {
      return problem(error instanceof Error ? error.message : "私有 TTS 服务不可用。", 503, "TTS_UNAVAILABLE");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/tts/synthesize") {
    const body = await request.json<{ text?: string; voice_id?: string; speed?: number; mode?: unknown }>().catch(() => null);
    const text = body?.text?.trim() || "";
    const voiceId = body?.voice_id?.trim() || "";
    const speed = Number(body?.speed) || 1;
    if (!text || text.length > 1_500 || !voiceId || voiceId.length > 120 || speed < MIN_MELOTTS_SPEED || speed > MAX_MELOTTS_SPEED) {
      return problem("TTS 请求参数无效。", 422, "INVALID_TTS_REQUEST");
    }
    try {
      return await synthesizeMeloTts(env, { text, voiceId, speed, mode: readTtsMode(body?.mode) }, headers, request.signal);
    } catch (error) {
      return problem(error instanceof Error ? error.message : "私有 TTS 服务不可用。", 503, "TTS_UNAVAILABLE");
    }
  }

  return problem("未知的 TTS 接口。", 404, "NOT_FOUND");
}
