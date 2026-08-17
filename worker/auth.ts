import { ensureDocumentStore, getAuthenticatedActor, hashOpaqueToken, isLocalDevelopmentRequest, type DocumentEnv } from "./documents";

const LOCAL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface LocalUserRow {
  id: string;
  email: string;
  display_name: string;
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

function error(message: string, status: number, code: string): Response {
  return json({ error: code, message }, status);
}

function readCookie(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

function serializeActor(actor: NonNullable<Awaited<ReturnType<typeof getAuthenticatedActor>>>) {
  return { id: actor.userId, tenant_id: actor.tenantId, display_name: actor.displayName, email: actor.email, auth_mode: actor.authMode };
}

function sessionCookie(token: string, maxAge: number): string {
  return `shengyue_local_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function handleAuthRequest(request: Request, env: Pick<DocumentEnv, "DB">): Promise<Response> {
  await ensureDocumentStore(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const actor = await getAuthenticatedActor(request, env);
    return json({
      authenticated: Boolean(actor),
      user: actor ? serializeActor(actor) : null,
      local_development: isLocalDevelopmentRequest(request),
      sign_in_url: isLocalDevelopmentRequest(request) ? null : "/signin-with-chatgpt?return_to=/",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/local-signin") {
    if (!isLocalDevelopmentRequest(request)) return error("本地体验登录只允许在 localhost 使用。", 403, "LOCAL_AUTH_FORBIDDEN");
    const body = await request.json<{ email?: string; display_name?: string }>();
    const email = body.email?.trim().toLowerCase() || "";
    const displayName = body.display_name?.trim().replace(/\s+/g, " ").slice(0, 80) || "本地体验用户";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return error("请输入有效的邮箱地址。", 422, "INVALID_EMAIL");
    let user = await env.DB.prepare("SELECT id, email, display_name FROM local_users WHERE email = ?").bind(email).first<LocalUserRow>();
    const createdAt = new Date().toISOString();
    if (!user) {
      // This compatibility id owns the material already imported in localhost
      // before the local sign-in experience was introduced.
      const id = email === "local@shengyue.test" ? "local-developer" : crypto.randomUUID();
      await env.DB.prepare("INSERT INTO local_users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, email, displayName, createdAt).run();
      user = { id, email, display_name: displayName };
    } else if (user.display_name !== displayName) {
      await env.DB.prepare("UPDATE local_users SET display_name = ? WHERE id = ?").bind(displayName, user.id).run();
      user.display_name = displayName;
    }
    const token = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = new Date(Date.now() + LOCAL_SESSION_MAX_AGE_SECONDS * 1_000).toISOString();
    await env.DB.prepare("INSERT INTO local_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, await hashOpaqueToken(token), expiresAt, createdAt).run();
    const actor = await getAuthenticatedActor(new Request(request.url, { headers: { cookie: `shengyue_local_session=${token}` } }), env);
    return json({ authenticated: true, user: actor ? serializeActor(actor) : null, local_development: true, sign_in_url: null }, 201, { "set-cookie": sessionCookie(token, LOCAL_SESSION_MAX_AGE_SECONDS) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/local-signout") {
    if (!isLocalDevelopmentRequest(request)) return error("请使用 ChatGPT 的退出登录入口。", 405, "PLATFORM_SIGNOUT_REQUIRED");
    const token = readCookie(request, "shengyue_local_session");
    if (token) await env.DB.prepare("DELETE FROM local_sessions WHERE token_hash = ?").bind(await hashOpaqueToken(token)).run();
    return json({ authenticated: false }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  return error("未知的认证接口。", 404, "NOT_FOUND");
}
