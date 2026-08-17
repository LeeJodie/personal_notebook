import { ensureDocumentStore, getAuthenticatedActor, hashOpaqueToken, isLocalDevelopmentRequest, type DocumentEnv } from "./documents";

const LOCAL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOCAL_PASSWORD_MIN_LENGTH = 8;
const LOCAL_PASSWORD_MAX_LENGTH = 128;
const PBKDF2_ITERATIONS = 120_000;

interface LocalUserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  password_salt: string | null;
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

function normalizeIdentity(body: { email?: string; display_name?: string }) {
  const email = body.email?.trim().toLowerCase() || "";
  const displayName = body.display_name?.trim().replace(/\s+/g, " ").slice(0, 80) || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "请输入有效的邮箱地址。" } as const;
  if (!displayName) return { error: "请输入显示名称。" } as const;
  return { email, displayName } as const;
}

function normalizePassword(value: unknown): string | null {
  if (typeof value !== "string" || value.length < LOCAL_PASSWORD_MIN_LENGTH || value.length > LOCAL_PASSWORD_MAX_LENGTH) return null;
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createPasswordSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function derivePasswordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toBase64Url(new Uint8Array(bits));
}

function timingSafeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

async function createLocalSession(request: Request, env: Pick<DocumentEnv, "DB">, user: LocalUserRow, status = 200): Promise<Response> {
  const token = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LOCAL_SESSION_MAX_AGE_SECONDS * 1_000).toISOString();
  await env.DB.prepare("INSERT INTO local_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), user.id, await hashOpaqueToken(token), expiresAt, createdAt).run();
  const actor = await getAuthenticatedActor(new Request(request.url, { headers: { cookie: `shengyue_local_session=${token}` } }), env);
  return json({ authenticated: true, user: actor ? serializeActor(actor) : null, local_development: true, sign_in_url: null }, status, { "set-cookie": sessionCookie(token, LOCAL_SESSION_MAX_AGE_SECONDS) });
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

  if (request.method === "POST" && url.pathname === "/api/auth/local-register") {
    if (!isLocalDevelopmentRequest(request)) return error("本地体验登录只允许在 localhost 使用。", 403, "LOCAL_AUTH_FORBIDDEN");
    const body = await request.json<{ email?: string; display_name?: string; password?: string }>();
    const identity = normalizeIdentity(body);
    if ("error" in identity) return error(identity.error, 422, "INVALID_IDENTITY");
    const password = normalizePassword(body.password);
    if (!password) return error(`密码长度需为 ${LOCAL_PASSWORD_MIN_LENGTH}-${LOCAL_PASSWORD_MAX_LENGTH} 位。`, 422, "INVALID_PASSWORD");
    const createdAt = new Date().toISOString();
    const salt = createPasswordSalt();
    const passwordHash = await derivePasswordHash(password, salt);
    let user = await env.DB.prepare("SELECT id, email, display_name, password_hash, password_salt FROM local_users WHERE email = ?").bind(identity.email).first<LocalUserRow>();
    if (!user) {
      // This compatibility id owns the material already imported in localhost
      // before the local sign-in experience was introduced.
      const id = identity.email === "local@shengyue.test" ? "local-developer" : crypto.randomUUID();
      await env.DB.prepare("INSERT INTO local_users (id, email, display_name, password_hash, password_salt, password_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, identity.email, identity.displayName, passwordHash, salt, createdAt, createdAt).run();
      user = { id, email: identity.email, display_name: identity.displayName, password_hash: passwordHash, password_salt: salt };
    } else if (user.password_hash || user.password_salt) {
      return error("该邮箱已注册，请直接登录。", 409, "EMAIL_ALREADY_REGISTERED");
    } else {
      // Older localhost accounts did not have credentials. Let the owner set
      // one through registration, while preserving their existing documents.
      await env.DB.prepare("UPDATE local_users SET display_name = ?, password_hash = ?, password_salt = ?, password_updated_at = ? WHERE id = ?")
        .bind(identity.displayName, passwordHash, salt, createdAt, user.id).run();
      user = { ...user, display_name: identity.displayName, password_hash: passwordHash, password_salt: salt };
    }
    return createLocalSession(request, env, user, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/local-signin") {
    if (!isLocalDevelopmentRequest(request)) return error("本地体验登录只允许在 localhost 使用。", 403, "LOCAL_AUTH_FORBIDDEN");
    const body = await request.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase() || "";
    const password = normalizePassword(body.password);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) return error("邮箱或密码错误。", 401, "INVALID_CREDENTIALS");
    const user = await env.DB.prepare("SELECT id, email, display_name, password_hash, password_salt FROM local_users WHERE email = ?").bind(email).first<LocalUserRow>();
    if (!user?.password_hash || !user.password_salt) return error("邮箱或密码错误。", 401, "INVALID_CREDENTIALS");
    const passwordHash = await derivePasswordHash(password, user.password_salt);
    if (!timingSafeEqual(passwordHash, user.password_hash)) return error("邮箱或密码错误。", 401, "INVALID_CREDENTIALS");
    return createLocalSession(request, env, user);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/local-signout") {
    if (!isLocalDevelopmentRequest(request)) return error("请使用 ChatGPT 的退出登录入口。", 405, "PLATFORM_SIGNOUT_REQUIRED");
    const token = readCookie(request, "shengyue_local_session");
    if (token) await env.DB.prepare("DELETE FROM local_sessions WHERE token_hash = ?").bind(await hashOpaqueToken(token)).run();
    return json({ authenticated: false }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  return error("未知的认证接口。", 404, "NOT_FOUND");
}
