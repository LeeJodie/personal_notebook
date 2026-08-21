const TTS_AUDIO_CACHE_NAME = "shengyue-tts-audio-v1";
const TTS_AUDIO_CACHE_LIMIT = 80;

export interface TtsAudioCacheInput {
  scope: string;
  mode: "local" | "online";
  voiceId: string;
  speed: number;
  text: string;
}

function fallbackHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

export async function ttsAudioCacheRequest(input: TtsAudioCacheInput): Promise<Request> {
  const value = [input.scope, input.mode, input.voiceId, input.speed, input.text].join("\u0000");
  let key = fallbackHash(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const origin = globalThis.location?.origin || "https://shengyue.local";
  return new Request(new URL(`/__shengyue_tts_audio_cache__/${key}`, origin).toString());
}

export async function readTtsAudioCache(request: Request): Promise<ArrayBuffer | null> {
  if (!("caches" in globalThis)) return null;
  try {
    const cached = await globalThis.caches.open(TTS_AUDIO_CACHE_NAME).then((cache) => cache.match(request));
    return cached ? await cached.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function writeTtsAudioCache(request: Request, audio: ArrayBuffer, contentType: string): Promise<void> {
  if (!("caches" in globalThis)) return;
  try {
    const cache = await globalThis.caches.open(TTS_AUDIO_CACHE_NAME);
    await cache.put(request, new Response(audio, { headers: { "content-type": contentType, "x-shengyue-cached-at": String(Date.now()) } }));
    const keys = await cache.keys();
    if (keys.length > TTS_AUDIO_CACHE_LIMIT) await Promise.all(keys.slice(0, keys.length - TTS_AUDIO_CACHE_LIMIT).map((key) => cache.delete(key)));
  } catch {
    // Cache failures (private mode, quota pressure) must never block playback.
  }
}
