#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

import {
  buildOAuthAuthorizeUrl,
  clearSessionCookies,
  fetchUser,
  findBuildJobRecord,
  findGeneratedSiteRecord,
  insertBuildJobRecord,
  isSupabaseConfigured,
  listGeneratedSiteRecords,
  markGeneratedSiteDeleted,
  resolveAuthenticatedUser,
  setSessionCookies,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  updateBuildJobRecord,
  upsertGeneratedSiteRecord,
} from "./supabase.mjs";

const BACKEND_LOG_PATH = "/tmp/ultimateweb-backend.log";
const PAGE_MODES = new Set(["conversion", "editorial", "hybrid"]);
const PUBLIC_SAMPLE_SLUGS = new Set([
  "red-2026-corvette-stingray-mms967ki",
  "2026-lamborghini-aventador-reborn-mmvev4j6",
  "elon-musk-mms9ohn0",
  "space-x-rockets-mmu5bg8j",
  "eiffel-tower-paris-france-mmveca8i",
  "michael-jordan-mmr6r4o0",
]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

function loadEnvFromDotenv(dotenvPath) {
  if (!existsSync(dotenvPath)) return;

  const raw = readFileSync(dotenvPath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendJavaScript(response, source) {
  response.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(source);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwardedProto || (request.socket?.encrypted ? "https" : "http");
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "127.0.0.1").split(",")[0].trim();
  return `${protocol}://${host}`;
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendOAuthCallbackPage(response) {
  sendHtml(
    response,
    200,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Completing sign-in...</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #08111d;
      color: #e9f4ff;
      font: 16px/1.5 system-ui, sans-serif;
    }
    main {
      width: min(28rem, calc(100vw - 2rem));
      padding: 1.4rem;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 1rem;
      background: linear-gradient(160deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03));
    }
    p { margin: 0; }
    .muted { margin-top: 0.65rem; color: #9fb4c7; font-size: 0.95rem; }
    .error { color: #ffb0a2; }
  </style>
</head>
<body>
  <main>
    <p id="status">Completing Google sign-in...</p>
    <p id="detail" class="muted">Your Supabase session is being attached to this app.</p>
  </main>
  <script>
    const statusNode = document.getElementById("status");
    const detailNode = document.getElementById("detail");

    function setState(message, detail, isError) {
      statusNode.textContent = message;
      detailNode.textContent = detail;
      detailNode.classList.toggle("error", Boolean(isError));
    }

    async function finalize() {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const queryParams = new URLSearchParams(window.location.search);
      const error = hashParams.get("error_description") || queryParams.get("error_description") || hashParams.get("error") || queryParams.get("error");
      if (error) {
        setState("Google sign-in failed.", error, true);
        return;
      }

      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      const expiresIn = hashParams.get("expires_in");

      if (!accessToken) {
        setState("Google sign-in could not be completed.", "Supabase did not return an access token to the callback page.", true);
        return;
      }

      const response = await fetch("/api/auth/oauth/session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          refreshToken,
          expiresIn,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setState("Google sign-in could not be completed.", data.error || "The app could not store the Supabase session.", true);
        return;
      }

      setState("Signed in.", "Redirecting back to the builder...");
      window.location.replace("/");
    }

    void finalize();
  </script>
</body>
</html>`
  );
}

function logBackend(message) {
  try {
    appendFileSync(BACKEND_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Ignore file logging failures.
  }
}

function safeResolve(baseDir, requestPath) {
  const sanitized = requestPath.replace(/^\/+/, "");
  const resolved = resolve(baseDir, sanitized);
  if (!resolved.startsWith(baseDir)) {
    return null;
  }
  return resolved;
}

function serveFile(response, filePath) {
  try {
    let target = filePath;
    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, "index.html");
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      sendText(response, 404, "Not found");
      return;
    }

    const ext = extname(target).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const buffer = readFileSync(target);
    response.writeHead(200, { "Content-Type": contentType });
    response.end(buffer);
  } catch (error) {
    sendText(response, 500, `Failed to serve file: ${error.message}`);
  }
}

function parseJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        rejectBody(new Error("Payload too large"));
      }
    });
    request.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        resolveBody(parsed);
      } catch {
        rejectBody(new Error("Invalid JSON body"));
      }
    });
    request.on("error", (error) => rejectBody(error));
  });
}

function sanitizeUploadFilename(filename, fallbackBase) {
  const raw = basename(String(filename || "").trim()) || fallbackBase;
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const extension = extname(cleaned);
  const base = cleaned.slice(0, cleaned.length - extension.length) || fallbackBase;
  return `${base.slice(0, 48)}${extension.slice(0, 12)}`;
}

function pickUploadedFile(files, preferredFieldName, matcher) {
  const preferred = files?.[preferredFieldName];
  if (preferred?.path) return preferred.path;

  for (const file of Object.values(files || {})) {
    if (!file?.path) continue;
    if (!matcher || matcher(file)) return file.path;
  }

  return null;
}

function isUploadedImage(file) {
  return /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(String(file?.filename || ""));
}

function isUploadedVideo(file) {
  return /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(String(file?.filename || ""));
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.slice(start));
  return parts;
}

function parseMultipartBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const contentType = String(request.headers["content-type"] || "");
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      rejectBody(new Error("Missing multipart boundary"));
      return;
    }

    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks = [];
    let totalSize = 0;

    request.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > 250 * 1024 * 1024) {
        rejectBody(new Error("Upload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const boundaryMarker = Buffer.from(`--${boundary}`);
        const sections = splitBuffer(body, boundaryMarker).slice(1, -1);
        const fields = {};
        const files = {};
        const uploadDir = mkdtempSync(join(tmpdir(), "ultimateweb-upload-"));

        for (const section of sections) {
          let part = section;
          if (part.subarray(0, 2).equals(Buffer.from("\r\n"))) {
            part = part.subarray(2);
          }
          if (part.length >= 2 && part.subarray(part.length - 2).equals(Buffer.from("\r\n"))) {
            part = part.subarray(0, part.length - 2);
          }

          const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
          if (headerEnd === -1) continue;

          const headerText = part.subarray(0, headerEnd).toString("utf8");
          const content = part.subarray(headerEnd + 4);
          const dispositionMatch = headerText.match(/content-disposition:[^\r\n]*name="([^"]+)"/i);
          if (!dispositionMatch) continue;

          const fieldName = dispositionMatch[1];
          const filenameMatch = headerText.match(/filename="([^"]*)"/i);
          if (filenameMatch && filenameMatch[1]) {
            const safeFilename = sanitizeUploadFilename(filenameMatch[1], fieldName);
            const storedPath = join(uploadDir, `${Date.now().toString(36)}-${safeFilename}`);
            writeFileSync(storedPath, content);
            files[fieldName] = { path: storedPath, filename: filenameMatch[1] };
          } else {
            fields[fieldName] = content.toString("utf8");
          }
        }

        resolveBody({ fields, files });
      } catch (error) {
        rejectBody(new Error(`Invalid multipart body: ${error.message}`));
      }
    });

    request.on("error", (error) => rejectBody(error));
  });
}

function appendJobLog(job, chunk) {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  for (const line of lines) {
    logBackend(`[job ${job.id}] ${line}`);
  }
  job.logs.push(...lines);
  if (job.logs.length > 240) {
    job.logs.splice(0, job.logs.length - 240);
  }
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizePageMode(rawMode) {
  const mode = String(rawMode || "conversion").trim().toLowerCase();
  if (!PAGE_MODES.has(mode)) {
    throw new Error(`Invalid pageMode "${rawMode}". Expected conversion, editorial, or hybrid.`);
  }
  return mode;
}

function cleanOptionalString(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function parseColorList(rawColors) {
  const text = cleanOptionalString(rawColors);
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(/[,\n]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, 6);
}

function parseAllowedOrigins() {
  const raw = cleanOptionalString(process.env.ULTIMATEWEB_ALLOWED_ORIGINS);
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function applyCors(response, request) {
  const allowedOrigins = parseAllowedOrigins();
  const origin = cleanOptionalString(request.headers.origin);

  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  } else if (!origin) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function presentUser(user) {
  return {
    id: user.id,
    email: user.email || null,
    lastSignInAt: user.last_sign_in_at || null,
  };
}

function presentGalleryEntries(rows) {
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    createdAt: row.created_at,
    siteUrl: row.site_url,
    thumbnailUrl: row.thumbnail_url,
    versionLabel: row.version_label,
  }));
}

function presentJobRecord(record) {
  return {
    id: record.id,
    slug: record.slug,
    topic: record.topic,
    pageMode: record.page_mode,
    status: record.status,
    logs: Array.isArray(record.logs) ? record.logs : [],
    error: record.error,
    siteUrl: record.site_url,
    thumbnailUrl: record.thumbnail_url,
    metadataUrl: record.metadata_url,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function startBuilderServer({ appDir, publicDir }) {
  const rootDir = resolve(appDir, "..");
  const generatedDir = join(rootDir, "generated-sites");
  const pipelineScript = join(
    rootDir,
    "skills",
    "fal-futuristic-website-builder",
    "scripts",
    "build_futuristic_site.mjs"
  );

  loadEnvFromDotenv(join(rootDir, ".env"));

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const jobs = new Map();

  mkdirSync(generatedDir, { recursive: true });

  function getSiteConfig(slug) {
    const siteRoot = join(generatedDir, slug);
    if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) return null;
    const metadataPath = join(siteRoot, "pipeline-metadata.json");
    const metadata = readJsonFile(metadataPath);
    if (!metadata) return null;
    const currentMedia = resolveEditSourceMedia(slug);

    const palette = Array.isArray(metadata.paletteOverride) && metadata.paletteOverride.length
      ? metadata.paletteOverride
      : Array.isArray(metadata.sourceContext?.palette)
        ? metadata.sourceContext.palette
        : [];

    return {
      slug,
      title: String(metadata.topic || slug.replace(/-/g, " ")).trim(),
      topic: String(metadata.topic || "").trim(),
      pageMode: normalizePageMode(metadata.pageMode),
      existingWebsite: cleanOptionalString(metadata.sourceUrl || metadata.sourceContext?.url),
      colors: palette.join(", "),
      startPrompt: cleanOptionalString(metadata.prompts?.startPrompt),
      endPrompt: cleanOptionalString(metadata.prompts?.endPrompt),
      videoPrompt: cleanOptionalString(metadata.prompts?.motionPrompt),
      editSourceSlug: cleanOptionalString(metadata.editSourceSlug),
      media: {
        startImage: currentMedia?.startImage
          ? {
              available: true,
              filename: basename(currentMedia.startImage),
              url: `/generated-sites/${slug}/media/${basename(currentMedia.startImage)}`,
            }
          : { available: false, filename: null, url: null },
        endImage: currentMedia?.endImage
          ? {
              available: true,
              filename: basename(currentMedia.endImage),
              url: `/generated-sites/${slug}/media/${basename(currentMedia.endImage)}`,
            }
          : { available: false, filename: null, url: null },
        video: currentMedia?.videoPath
          ? {
              available: true,
              filename: basename(currentMedia.videoPath),
              url: `/generated-sites/${slug}/media/${basename(currentMedia.videoPath)}`,
            }
          : { available: false, filename: null, url: null },
      },
    };
  }

  function resolveEditSourceMedia(slug) {
    const cleanSlug = cleanOptionalString(slug);
    if (!cleanSlug) return null;

    const siteRoot = join(generatedDir, cleanSlug);
    if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) return null;

    const mediaDir = join(siteRoot, "media");
    const startCandidates = ["start-frame.png", "start-frame.jpg", "start-frame.jpeg", "start-frame.webp"];
    const endCandidates = ["end-frame.png", "end-frame.jpg", "end-frame.jpeg", "end-frame.webp"];

    const pickExistingFile = (candidates) => {
      for (const fileName of candidates) {
        const filePath = join(mediaDir, fileName);
        if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
      }
      return null;
    };

    const videoPath = join(mediaDir, "transition.mp4");
    return {
      startImage: pickExistingFile(startCandidates),
      endImage: pickExistingFile(endCandidates),
      videoPath: existsSync(videoPath) && statSync(videoPath).isFile() ? videoPath : null,
    };
  }

  function deleteGeneratedSite(slug) {
    const cleanSlug = cleanOptionalString(slug);
    if (!cleanSlug || cleanSlug !== basename(cleanSlug)) {
      throw new Error("Invalid site slug.");
    }

    const siteRoot = join(generatedDir, cleanSlug);
    if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
      return false;
    }

    rmSync(siteRoot, { recursive: true, force: true });
    return true;
  }

  async function persistJob(job) {
    try {
      if (job.persisted) {
        await updateBuildJobRecord(job);
      } else {
        await insertBuildJobRecord(job);
        job.persisted = true;
      }
    } catch (error) {
      logBackend(`Supabase job persistence failed for ${job.id}: ${error.message}`);
    }
  }

  async function persistCompletedSite(job) {
    try {
      const siteConfig = getSiteConfig(job.slug);
      if (!siteConfig) return;
      await upsertGeneratedSiteRecord({
        userId: job.userId,
        slug: job.slug,
        title: siteConfig.title,
        topic: siteConfig.topic,
        pageMode: siteConfig.pageMode,
        existingWebsite: siteConfig.existingWebsite,
        colors: parseColorList(siteConfig.colors),
        thumbnailUrl: job.thumbnailUrl,
        siteUrl: job.siteUrl,
        versionLabel: siteConfig.editSourceSlug ? "Edited version" : "Original version",
        metadataUrl: job.metadataUrl,
        editSourceSlug: siteConfig.editSourceSlug,
        startPrompt: siteConfig.startPrompt,
        endPrompt: siteConfig.endPrompt,
        videoPrompt: siteConfig.videoPrompt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error) {
      logBackend(`Supabase site persistence failed for ${job.slug}: ${error.message}`);
    }
  }

  function startBuildJob(topic, pageMode = "conversion", options = {}) {
    const id = randomUUID();
    const slug = `${slugify(topic)}-${Date.now().toString(36)}`;
    const job = {
      id,
      topic,
      pageMode,
      slug,
      userId: options.userId,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      siteUrl: null,
      thumbnailUrl: null,
      metadataUrl: null,
      error: null,
      persisted: false,
    };

    const args = [
      pipelineScript,
      "--topic",
      topic,
      "--slug",
      slug,
      "--out-dir",
      generatedDir,
      "--page-mode",
      pageMode,
      "--start-model",
      "fal-ai/nano-banana-2",
      "--end-model",
      "fal-ai/nano-banana-2/edit",
      "--video-model",
      "fal-ai/kling-video/v3/pro/image-to-video",
    ];

    const optionalArgs = [
      ["--source-url", options.existingWebsite],
      ["--start-image", options.startImage],
      ["--end-image", options.endImage],
      ["--video-path", options.videoPath],
      ["--video-url", options.videoUrl],
      ["--start-prompt", options.startPrompt],
      ["--end-prompt", options.endPrompt],
      ["--motion-prompt", options.videoPrompt],
      ["--change-request", options.changeRequest],
      ["--edit-source-slug", options.editSourceSlug],
    ];

    for (const [flag, value] of optionalArgs) {
      if (!value) continue;
      args.push(flag, value);
    }

    for (const color of options.colors || []) {
      args.push("--color", color);
    }

    const mediaMode = options.videoPath
      ? `video-path:${options.videoPath}`
      : options.videoUrl
        ? `video-url:${options.videoUrl}`
        : "fal-generate-video";
    logBackend(
      `Starting job ${id} user=${options.userId} slug=${slug} mode=${pageMode} editSource=${options.editSourceSlug || "none"} ` +
      `startImage=${options.startImage || "none"} endImage=${options.endImage || "none"} media=${mediaMode}`
    );

    const child = spawn("node", args, {
      cwd: rootDir,
      env: { ...process.env, FAL_KEY: process.env.FAL_KEY || "" },
    });

    job.status = "running";
    jobs.set(id, job);
    void persistJob(job);

    child.stdout.on("data", (chunk) => {
      appendJobLog(job, chunk);
      job.updatedAt = new Date().toISOString();
    });

    child.stderr.on("data", (chunk) => {
      appendJobLog(job, chunk);
      job.updatedAt = new Date().toISOString();
    });

    child.on("error", (error) => {
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date().toISOString();
      void persistJob(job);
    });

    child.on("close", () => {
      if (existsSync(join(generatedDir, slug, "media", "start-frame.webp"))) {
        job.thumbnailUrl = `/generated-sites/${slug}/media/start-frame.webp`;
      } else if (existsSync(join(generatedDir, slug, "media", "start-frame.png"))) {
        job.thumbnailUrl = `/generated-sites/${slug}/media/start-frame.png`;
      } else if (existsSync(join(generatedDir, slug, "media", "end-frame.webp"))) {
        job.thumbnailUrl = `/generated-sites/${slug}/media/end-frame.webp`;
      } else if (existsSync(join(generatedDir, slug, "media", "end-frame.png"))) {
        job.thumbnailUrl = `/generated-sites/${slug}/media/end-frame.png`;
      }

      if (existsSync(join(generatedDir, slug, "index.html"))) {
        job.status = "completed";
        job.siteUrl = `/generated-sites/${slug}/index.html`;
        job.metadataUrl = `/generated-sites/${slug}/pipeline-metadata.json`;
      } else {
        job.status = "failed";
        job.error = job.logs[job.logs.length - 1] || "Pipeline finished without producing a site.";
      }
      job.updatedAt = new Date().toISOString();
      void persistJob(job);
      if (job.status === "completed") {
        void persistCompletedSite(job);
      }
    });

    return job;
  }

  async function getRequestSession(request, response) {
    if (request.ultimatewebSession !== undefined) {
      return request.ultimatewebSession;
    }

    if (!isSupabaseConfigured()) {
      request.ultimatewebSession = null;
      return null;
    }

    try {
      const session = await resolveAuthenticatedUser(request, response);
      request.ultimatewebSession = session;
      return session;
    } catch (error) {
      logBackend(`Supabase auth lookup failed: ${error.message}`);
      request.ultimatewebSession = null;
      return null;
    }
  }

  async function requireSupabase(response) {
    if (!isSupabaseConfigured()) {
      sendJson(response, 503, {
        error: "Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
      });
      return false;
    }
    return true;
  }

  async function requireAuthenticatedSession(request, response) {
    if (!(await requireSupabase(response))) return null;
    const session = await getRequestSession(request, response);
    if (!session?.user?.id) {
      sendJson(response, 401, { error: "Authentication required." });
      return null;
    }
    return session;
  }

  const server = createServer(async (request, response) => {
    applyCors(response, request);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (!request.url) {
      sendText(response, 400, "Missing URL");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/config") {
      const apiBase = String(process.env.ULTIMATEWEB_API_BASE || "").trim().replace(/\/+$/, "");
      sendJavaScript(
        response,
        `window.ULTIMATEWEB_API_BASE = ${JSON.stringify(apiBase)};\nwindow.ULTIMATEWEB_SUPABASE_ENABLED = ${JSON.stringify(isSupabaseConfigured())};\n`
      );
      return;
    }

    if (request.method === "GET" && pathname === "/api/auth/session") {
      if (!isSupabaseConfigured()) {
        sendJson(response, 200, { configured: false, authenticated: false, user: null });
        return;
      }
      const session = await getRequestSession(request, response);
      sendJson(response, 200, {
        configured: true,
        authenticated: Boolean(session?.user),
        user: session?.user ? presentUser(session.user) : null,
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/auth/google") {
      if (!(await requireSupabase(response))) return;
      try {
        const redirectTo = `${getRequestOrigin(request)}/auth/callback`;
        response.writeHead(302, {
          Location: buildOAuthAuthorizeUrl("google", redirectTo),
          "Cache-Control": "no-store",
        });
        response.end();
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/auth/callback") {
      sendOAuthCallbackPage(response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/sign-in") {
      if (!(await requireSupabase(response))) return;
      try {
        const body = await parseJsonBody(request);
        const email = cleanOptionalString(body.email);
        const password = cleanOptionalString(body.password);
        if (!email || !password) {
          sendJson(response, 400, { error: "Email and password are required." });
          return;
        }
        const session = await signInWithPassword(email, password);
        setSessionCookies(response, request, session);
        sendJson(response, 200, {
          authenticated: true,
          user: presentUser(session.user),
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/sign-up") {
      if (!(await requireSupabase(response))) return;
      try {
        const body = await parseJsonBody(request);
        const email = cleanOptionalString(body.email);
        const password = cleanOptionalString(body.password);
        if (!email || !password) {
          sendJson(response, 400, { error: "Email and password are required." });
          return;
        }
        const session = await signUpWithPassword(email, password);
        if (session.access_token && session.refresh_token) {
          setSessionCookies(response, request, session);
        }
        sendJson(response, 200, {
          authenticated: Boolean(session.user),
          user: session.user ? presentUser(session.user) : null,
          message: session.session ? "Account created." : "Account created. Check your auth settings if confirmation is required.",
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/oauth/session") {
      if (!(await requireSupabase(response))) return;
      try {
        const body = await parseJsonBody(request);
        const accessToken = cleanOptionalString(body.accessToken);
        const refreshToken = cleanOptionalString(body.refreshToken);
        const expiresIn = Number(body.expiresIn || 3600);
        if (!accessToken) {
          sendJson(response, 400, { error: "Access token is required." });
          return;
        }
        const user = await fetchUser(accessToken);
        setSessionCookies(response, request, {
          access_token: accessToken,
          refresh_token: refreshToken || "",
          expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
        });
        sendJson(response, 200, {
          authenticated: true,
          user: presentUser(user),
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/sign-out") {
      if (!(await requireSupabase(response))) return;
      const session = await getRequestSession(request, response);
      try {
        if (session?.accessToken) {
          await signOut(session.accessToken);
        }
      } catch (error) {
        logBackend(`Supabase sign-out failed: ${error.message}`);
      }
      clearSessionCookies(response, request);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && pathname === "/api/build") {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      try {
        const contentType = String(request.headers["content-type"] || "");
        const body = contentType.includes("multipart/form-data")
          ? await parseMultipartBody(request)
          : { fields: await parseJsonBody(request), files: {} };
        const topic = String(body.fields.topic || "").trim();
        const pageMode = normalizePageMode(body.fields.pageMode);
        const existingWebsite = cleanOptionalString(body.fields.existingWebsite);
        const uploadedStartImage = pickUploadedFile(body.files, "startImage", isUploadedImage) || cleanOptionalString(body.fields.startImage);
        const uploadedEndImage = pickUploadedFile(body.files, "endImage", isUploadedImage) || cleanOptionalString(body.fields.endImage);
        const uploadedVideo = pickUploadedFile(body.files, "video", isUploadedVideo) || cleanOptionalString(body.fields.video);
        const startPrompt = cleanOptionalString(body.fields.startPrompt);
        const endPrompt = cleanOptionalString(body.fields.endPrompt);
        const videoPrompt = cleanOptionalString(body.fields.videoPrompt);
        const changeRequest = cleanOptionalString(body.fields.changeRequest);
        const editSourceSlug = cleanOptionalString(body.fields.editSourceSlug);
        const colors = parseColorList(body.fields.colors);
        const hasUploadedMedia = Boolean(uploadedStartImage || uploadedEndImage || uploadedVideo);

        if (editSourceSlug) {
          const editableSite = await findGeneratedSiteRecord(session.user.id, editSourceSlug);
          if (!editableSite) {
            sendJson(response, 404, { error: "The selected source site does not exist for this account." });
            return;
          }
        }

        const existingMedia = !hasUploadedMedia && editSourceSlug
          ? resolveEditSourceMedia(editSourceSlug)
          : null;
        const startImage = uploadedStartImage || existingMedia?.startImage || null;
        const endImage = uploadedEndImage || existingMedia?.endImage || null;
        const video = uploadedVideo || existingMedia?.videoPath || null;

        logBackend(
          `POST /api/build user=${session.user.id} topic="${topic}" editSource=${editSourceSlug || "none"} ` +
          `uploadedFiles=${JSON.stringify({
            keys: Object.keys(body.files || {}),
            startImage: body.files.startImage?.filename || null,
            endImage: body.files.endImage?.filename || null,
            video: body.files.video?.filename || null,
          })} ` +
          `resolvedMedia=${JSON.stringify({ startImage, endImage, video })}`
        );

        if (!topic) {
          sendJson(response, 400, { error: "Topic is required." });
          return;
        }

        if (!process.env.FAL_KEY && !video) {
          sendJson(response, 500, {
            error: "FAL_KEY is not set. Add it to .env or environment before starting the server, or provide an existing video.",
          });
          return;
        }

        const isVideoUrl = Boolean(video && /^https?:\/\//i.test(video));
        const job = startBuildJob(topic, pageMode, {
          userId: session.user.id,
          existingWebsite,
          colors,
          startImage,
          endImage,
          videoPath: video && !isVideoUrl ? video : null,
          videoUrl: isVideoUrl ? video : null,
          startPrompt,
          endPrompt,
          videoPrompt,
          changeRequest,
          editSourceSlug,
        });
        sendJson(response, 202, {
          id: job.id,
          slug: job.slug,
          status: job.status,
          pageMode: job.pageMode,
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/jobs/")) {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const id = pathname.split("/").pop();
      const liveJob = id ? jobs.get(id) : null;
      if (liveJob?.userId === session.user.id) {
        sendJson(response, 200, liveJob);
        return;
      }

      try {
        const storedJob = id ? await findBuildJobRecord(session.user.id, id) : null;
        if (!storedJob) {
          sendJson(response, 404, { error: "Job not found." });
          return;
        }
        sendJson(response, 200, presentJobRecord(storedJob));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/jobs") {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const summaries = Array.from(jobs.values())
        .filter((job) => job.userId === session.user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
      sendJson(response, 200, summaries);
      return;
    }

    if (request.method === "GET" && pathname === "/api/gallery") {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      try {
        const rows = await listGeneratedSiteRecords(session.user.id);
        sendJson(response, 200, presentGalleryEntries(rows));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/sites/")) {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const slug = pathname.split("/").pop();
      if (!slug) {
        sendJson(response, 404, { error: "Site config not found." });
        return;
      }

      try {
        const siteRecord = await findGeneratedSiteRecord(session.user.id, slug);
        if (!siteRecord) {
          sendJson(response, 404, { error: "Site config not found." });
          return;
        }
        const siteConfig = getSiteConfig(slug);
        if (!siteConfig) {
          sendJson(response, 404, { error: "Generated site files not found." });
          return;
        }
        sendJson(response, 200, siteConfig);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (
      (request.method === "DELETE" && pathname.startsWith("/api/sites/")) ||
      (request.method === "POST" && pathname.startsWith("/api/sites/") && pathname.endsWith("/delete"))
    ) {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const slug = pathname.endsWith("/delete")
        ? pathname.split("/").slice(-2, -1)[0]
        : pathname.split("/").pop();
      try {
        const existingRecord = slug ? await findGeneratedSiteRecord(session.user.id, slug) : null;
        if (!existingRecord) {
          sendJson(response, 404, { error: "Site not found." });
          return;
        }
        const deleted = slug ? deleteGeneratedSite(slug) : false;
        if (!deleted) {
          sendJson(response, 404, { error: "Generated site files not found." });
          return;
        }
        await markGeneratedSiteDeleted(session.user.id, slug);
        logBackend(`Deleted generated site user=${session.user.id} slug=${slug}`);
        sendJson(response, 200, { ok: true, slug });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (pathname.startsWith("/generated-sites/")) {
      const relativePath = pathname.replace(/^\/generated-sites\//, "");
      const [slug] = relativePath.split("/");
      if (!slug) {
        sendText(response, 404, "Not found");
        return;
      }
      const isPublicSample = PUBLIC_SAMPLE_SLUGS.has(slug);

      if (!isPublicSample) {
        const session = await requireAuthenticatedSession(request, response);
        if (!session) return;

        try {
          const siteRecord = await findGeneratedSiteRecord(session.user.id, slug);
          if (!siteRecord) {
            sendText(response, 404, "Not found");
            return;
          }
        } catch (error) {
          sendText(response, 500, error.message);
          return;
        }
      }
      const resolvedFile = safeResolve(generatedDir, relativePath);
      if (!resolvedFile) {
        sendText(response, 403, "Forbidden");
        return;
      }
      serveFile(response, resolvedFile);
      return;
    }

    const publicPath = pathname === "/" ? "/index.html" : pathname;
    const resolvedPublic = safeResolve(publicDir, publicPath);
    if (!resolvedPublic) {
      sendText(response, 403, "Forbidden");
      return;
    }
    serveFile(response, resolvedPublic);
  });

  server.listen(port, host, () => {
    console.log(`Builder portal running on http://${host}:${port}`);
    console.log("FAL_KEY is read from .env at project root (or from environment variable).");
    console.log("Supabase auth/database integration requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.");
  });

  return server;
}

export function resolveAppDir(importMetaUrl) {
  return dirname(new URL(importMetaUrl).pathname);
}
