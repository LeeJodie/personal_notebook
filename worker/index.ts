/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleCrawlRequest } from "./crawl";
import { handleAuthRequest } from "./auth";
import { handleDocumentRequest } from "./documents";
import { handleShareRequest } from "./share";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  CUSTOMER_HTTP_CRAWLER?: Fetcher;
  CUSTOMER_HTTP_DOCUMENT_PROCESSOR?: Fetcher;
  CUSTOMER_HTTP_KNOWLEDGE_INDEX?: Fetcher;
  LOCAL_DOCUMENT_PROCESSOR_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function withPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // `/api/*` powers the in-repository experience. `/v1/*` is the stable
    // integration surface described in OpenAPI; both paths use exactly the
    // same ownership, D1 and R2 code paths.
    if (url.pathname === "/v1/documents:upload") {
      return handleDocumentRequest(withPath(request, "/api/documents/upload"), env);
    }
    if (url.pathname === "/v1/auth/me" || url.pathname === "/v1/auth/local-register" || url.pathname === "/v1/auth/local-signin" || url.pathname === "/v1/auth/local-signout") {
      return handleAuthRequest(withPath(request, url.pathname.replace(/^\/v1/, "/api")), env);
    }
    if (url.pathname === "/v1/documents:import-url") {
      return handleDocumentRequest(withPath(request, "/api/documents/import-url"), env);
    }
    if (url.pathname === "/v1/documents" || url.pathname.startsWith("/v1/documents/") || url.pathname === "/v1/knowledge/search") {
      const internalPath = url.pathname.replace(/^\/v1/, "/api");
      if (internalPath.includes("/shares")) return handleShareRequest(withPath(request, internalPath), env);
      return handleDocumentRequest(withPath(request, internalPath), env);
    }
    if (/^\/v1\/public\/shares\/[a-f0-9]{32,128}(?:\/artifacts\/h5)?$/i.test(url.pathname)) {
      return handleShareRequest(withPath(request, url.pathname.replace("/v1/public", "/api")), env);
    }

    if (url.pathname === "/api/crawl") {
      return handleCrawlRequest(request, env);
    }

    if (url.pathname === "/api/auth/me" || url.pathname === "/api/auth/local-register" || url.pathname === "/api/auth/local-signin" || url.pathname === "/api/auth/local-signout") {
      return handleAuthRequest(request, env);
    }

    if (url.pathname === "/api/shares" || url.pathname.startsWith("/api/shares/") || url.pathname.includes("/shares")) {
      return handleShareRequest(request, env);
    }

    if (url.pathname === "/api/documents" || url.pathname.startsWith("/api/documents/") || url.pathname === "/api/knowledge/search") {
      return handleDocumentRequest(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
