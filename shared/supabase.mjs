const ACCESS_TOKEN_COOKIE = "uw_sb_access_token";
const REFRESH_TOKEN_COOKIE = "uw_sb_refresh_token";

function cleanEnv(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeBaseUrl(value) {
  const text = cleanEnv(value);
  return text ? text.replace(/\/+$/, "") : null;
}

function getCookieAttributes(request, maxAge = null) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(request.headers.host || ""));
  const isSecure = forwardedProto === "https" || (!isLocalHost && request.socket?.encrypted);
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function getSupabaseConfig() {
  return {
    url: normalizeBaseUrl(process.env.SUPABASE_URL),
    anonKey: cleanEnv(process.env.SUPABASE_ANON_KEY),
    serviceRoleKey: cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

export function isSupabaseConfigured() {
  const config = getSupabaseConfig();
  return Boolean(config.url && config.anonKey && config.serviceRoleKey);
}

function parseJsonSafely(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function supabaseFetch(path, { method = "GET", apiKey, accessToken, body, headers = {} } = {}) {
  const { url } = getSupabaseConfig();
  if (!url) {
    throw new Error("SUPABASE_URL is not configured.");
  }

  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: apiKey,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  return { response, data, text };
}

export async function signInWithPassword(email, password) {
  const { anonKey } = getSupabaseConfig();
  const { response, data, text } = await supabaseFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    apiKey: anonKey,
    body: { email, password },
  });

  if (!response.ok) {
    throw new Error(data?.msg || data?.error_description || data?.error || text || "Sign-in failed.");
  }
  return data;
}

export async function signUpWithPassword(email, password) {
  const { anonKey } = getSupabaseConfig();
  const { response, data, text } = await supabaseFetch("/auth/v1/signup", {
    method: "POST",
    apiKey: anonKey,
    body: { email, password },
  });

  if (!response.ok) {
    throw new Error(data?.msg || data?.error_description || data?.error || text || "Sign-up failed.");
  }
  return data;
}

export async function refreshSession(refreshToken) {
  const { anonKey } = getSupabaseConfig();
  const { response, data, text } = await supabaseFetch("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    apiKey: anonKey,
    body: { refresh_token: refreshToken },
  });

  if (!response.ok) {
    throw new Error(data?.msg || data?.error_description || data?.error || text || "Session refresh failed.");
  }
  return data;
}

export async function fetchUser(accessToken) {
  const { anonKey } = getSupabaseConfig();
  const { response, data, text } = await supabaseFetch("/auth/v1/user", {
    method: "GET",
    apiKey: anonKey,
    accessToken,
  });

  if (!response.ok) {
    const error = new Error(data?.msg || data?.error_description || data?.error || text || "Could not fetch user.");
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

export async function signOut(accessToken) {
  const { anonKey } = getSupabaseConfig();
  const { response, data, text } = await supabaseFetch("/auth/v1/logout", {
    method: "POST",
    apiKey: anonKey,
    accessToken,
    body: { scope: "local" },
  });

  if (!response.ok) {
    throw new Error(data?.msg || data?.error_description || data?.error || text || "Sign-out failed.");
  }
}

export function buildOAuthAuthorizeUrl(provider, redirectTo) {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) {
    throw new Error("Supabase auth is not configured.");
  }

  const params = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
  });

  return `${url}/auth/v1/authorize?${params.toString()}`;
}

function parseCookies(request) {
  const raw = String(request.headers.cookie || "");
  const entries = raw
    .split(/;\s*/)
    .map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return null;
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
    .filter(Boolean);
  return Object.fromEntries(entries);
}

export function setSessionCookies(response, request, session) {
  const maxAge = Number(session?.expires_in || 3600);
  response.setHeader("Set-Cookie", [
    `${ACCESS_TOKEN_COOKIE}=${encodeURIComponent(session.access_token || "")}; ${getCookieAttributes(request, maxAge)}`,
    `${REFRESH_TOKEN_COOKIE}=${encodeURIComponent(session.refresh_token || "")}; ${getCookieAttributes(request, 60 * 60 * 24 * 30)}`,
  ]);
}

export function clearSessionCookies(response, request) {
  response.setHeader("Set-Cookie", [
    `${ACCESS_TOKEN_COOKIE}=; ${getCookieAttributes(request, 0)}`,
    `${REFRESH_TOKEN_COOKIE}=; ${getCookieAttributes(request, 0)}`,
  ]);
}

export async function resolveAuthenticatedUser(request, response) {
  const cookies = parseCookies(request);
  const accessToken = cleanEnv(cookies[ACCESS_TOKEN_COOKIE]);
  const refreshToken = cleanEnv(cookies[REFRESH_TOKEN_COOKIE]);

  if (!accessToken && !refreshToken) {
    return null;
  }

  if (accessToken) {
    try {
      const user = await fetchUser(accessToken);
      return { user, accessToken, refreshToken };
    } catch (error) {
      if (error.statusCode && error.statusCode !== 401) {
        throw error;
      }
    }
  }

  if (!refreshToken) {
    clearSessionCookies(response, request);
    return null;
  }

  try {
    const refreshed = await refreshSession(refreshToken);
    setSessionCookies(response, request, refreshed);
    const user = await fetchUser(refreshed.access_token);
    return { user, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token };
  } catch {
    clearSessionCookies(response, request);
    return null;
  }
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function postgrest(path, { method = "GET", query, body, headers = {} } = {}) {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase database credentials are not configured.");
  }

  const response = await fetch(`${url}/rest/v1/${path}${buildQueryString(query)}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = parseJsonSafely(text);
  if (!response.ok && response.status !== 406) {
    throw new Error(data?.message || data?.error || text || "Supabase database request failed.");
  }
  return { response, data, text };
}

export async function insertBuildJobRecord(job) {
  await postgrest("build_jobs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      id: job.id,
      user_id: job.userId,
      slug: job.slug,
      topic: job.topic,
      page_mode: job.pageMode,
      status: job.status,
      logs: job.logs || [],
      error: job.error,
      site_url: job.siteUrl,
      thumbnail_url: job.thumbnailUrl,
      metadata_url: job.metadataUrl,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    },
  });
}

export async function updateBuildJobRecord(job) {
  await postgrest("build_jobs", {
    method: "PATCH",
    query: { id: `eq.${job.id}` },
    headers: { Prefer: "return=minimal" },
    body: {
      status: job.status,
      logs: job.logs || [],
      error: job.error,
      site_url: job.siteUrl,
      thumbnail_url: job.thumbnailUrl,
      metadata_url: job.metadataUrl,
      updated_at: job.updatedAt,
    },
  });
}

export async function findBuildJobRecord(userId, jobId) {
  const { data } = await postgrest("build_jobs", {
    method: "GET",
    query: {
      select: "*",
      user_id: `eq.${userId}`,
      id: `eq.${jobId}`,
      limit: 1,
    },
    headers: { Accept: "application/vnd.pgrst.object+json" },
  });

  return data || null;
}

export async function listGeneratedSiteRecords(userId, limit = 80) {
  const { data } = await postgrest("generated_sites", {
    method: "GET",
    query: {
      select: "slug,title,created_at,site_url,thumbnail_url,version_label",
      user_id: `eq.${userId}`,
      deleted_at: "is.null",
      order: "created_at.desc",
      limit,
    },
  });

  return Array.isArray(data) ? data : [];
}

export async function findGeneratedSiteRecord(userId, slug) {
  const { data } = await postgrest("generated_sites", {
    method: "GET",
    query: {
      select: "*",
      user_id: `eq.${userId}`,
      slug: `eq.${slug}`,
      deleted_at: "is.null",
      limit: 1,
    },
    headers: { Accept: "application/vnd.pgrst.object+json" },
  });

  return data || null;
}

export async function upsertGeneratedSiteRecord(record) {
  await postgrest("generated_sites", {
    method: "POST",
    query: { on_conflict: "user_id,slug" },
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      user_id: record.userId,
      slug: record.slug,
      title: record.title,
      topic: record.topic,
      page_mode: record.pageMode,
      existing_website: record.existingWebsite,
      colors: record.colors || [],
      thumbnail_url: record.thumbnailUrl,
      site_url: record.siteUrl,
      version_label: record.versionLabel,
      metadata_url: record.metadataUrl,
      edit_source_slug: record.editSourceSlug,
      start_prompt: record.startPrompt,
      end_prompt: record.endPrompt,
      video_prompt: record.videoPrompt,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: null,
    },
  });
}

export async function markGeneratedSiteDeleted(userId, slug) {
  await postgrest("generated_sites", {
    method: "PATCH",
    query: {
      user_id: `eq.${userId}`,
      slug: `eq.${slug}`,
      deleted_at: "is.null",
    },
    headers: { Prefer: "return=minimal" },
    body: {
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}
