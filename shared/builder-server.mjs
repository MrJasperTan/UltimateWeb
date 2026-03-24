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
const DRAFT_PREVIEW_TTL_MS = 1000 * 60 * 60;
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
    const headers = { "Content-Type": contentType };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-store, max-age=0";
    }
    response.writeHead(200, headers);
    response.end(buffer);
  } catch (error) {
    sendText(response, 500, `Failed to serve file: ${error.message}`);
  }
}

function serveFavicon(response, publicDir) {
  const svgPath = join(publicDir, "favicon.svg");
  if (!existsSync(svgPath) || !statSync(svgPath).isFile()) {
    sendText(response, 404, "Not found");
    return;
  }

  const buffer = readFileSync(svgPath);
  response.writeHead(200, { "Content-Type": "image/svg+xml" });
  response.end(buffer);
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

function pickExactUploadedFile(files, fieldName, matcher) {
  const file = files?.[fieldName];
  if (!file?.path) return null;
  if (matcher && !matcher(file)) return null;
  return file.path;
}

function isUploadedImage(file) {
  return /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(String(file?.filename || file?.path || ""));
}

function isUploadedVideo(file) {
  return /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(String(file?.filename || file?.path || ""));
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
          const dispositionMatch = headerText.match(/content-disposition:[^\r\n]*;\s*name="([^"]+)"/i);
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

        resolveBody({ fields, files, uploadDir });
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExperienceUpgrades(raw) {
  const guided = raw?.guidedScroll && typeof raw.guidedScroll === "object" ? raw.guidedScroll : {};
  const audio = raw?.audio && typeof raw.audio === "object" ? raw.audio : {};
  const depth = raw?.depthHero && typeof raw.depthHero === "object" ? raw.depthHero : {};
  return {
    guidedScroll: {
      enabled: Boolean(guided.enabled),
      initialDelayMs: Math.max(0, Number(guided.initialDelayMs || 6000) || 6000),
      downDurationMs: Math.max(5000, Number(guided.downDurationMs || 112500) || 112500),
      upDurationMs: Math.max(3000, Number(guided.upDurationMs || 56250) || 56250),
      endPauseMs: Math.max(0, Number(guided.endPauseMs || 3000) || 3000),
      resumeDelayMs: Math.max(250, Number(guided.resumeDelayMs || 2000) || 2000),
    },
    audio: {
      enabled: Boolean(audio.enabled),
    },
    depthHero: {
      enabled: Boolean(depth.enabled),
    },
  };
}

function normalizeMediaPlayback(raw) {
  const playback = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Boolean(playback.enabled),
    loopMode: String(playback.loopMode || "loop").trim() === "boomerang" ? "boomerang" : "loop",
    speed: Math.min(2.5, Math.max(0.25, Number(playback.speed || 1) || 1)),
    mobileFit: String(playback.mobileFit || "contain").trim() === "cover" ? "cover" : "contain",
  };
}

function parseExperienceUpgradesFromSite(siteRoot) {
  const htmlPath = join(siteRoot, "index.html");
  if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) return null;
  const html = readFileSync(htmlPath, "utf-8");
  const appScriptPath = join(siteRoot, "js", "app.js");
  const appScript = existsSync(appScriptPath) && statSync(appScriptPath).isFile()
    ? readFileSync(appScriptPath, "utf-8")
    : "";

  const guidedEnabled = /id=["']guided-mode-btn["']/i.test(html) || /\bguidedModeButton\b/.test(appScript);
  const audioEnabled = /id=["']sound-toggle-btn["']/i.test(html) || /\bsoundToggleButton\b/.test(appScript);
  const depthEnabled = /\bhero-depth-grid\b/i.test(html) || /\bhero-depth-grid\b/.test(appScript);

  if (!guidedEnabled && !audioEnabled && !depthEnabled) return null;

  const guidedDurationMatch = appScript.match(
    /guidedModePhase\s*===\s*["']down["']\s*\?\s*(\d+)\s*:\s*(\d+)/
  );
  const downDurationMs = guidedDurationMatch ? Number(guidedDurationMatch[1]) : 112500;
  const upDurationMs = guidedDurationMatch ? Number(guidedDurationMatch[2]) : 56250;

  const endPauseMatch = appScript.match(
    /guidedModePauseUntil\s*=\s*(?:timestamp|performance\.now\(\))\s*\+\s*(\d+)/
  );
  const initialDelayMatch = appScript.match(
    /if\s*\(!guidedModeDismissed\)\s*startGuidedMode\(\);\s*}\s*,\s*(\d+)\s*\)/
  );
  const resumeDelayMatch = appScript.match(
    /guidedResumeTimer\s*=\s*window\.setTimeout\([\s\S]*?,\s*(\d+)\s*\);/
  );

  return normalizeExperienceUpgrades({
    guidedScroll: {
      enabled: guidedEnabled,
      initialDelayMs: initialDelayMatch ? Number(initialDelayMatch[1]) : 6000,
      downDurationMs,
      upDurationMs,
      endPauseMs: endPauseMatch ? Number(endPauseMatch[1]) : 3000,
      resumeDelayMs: resumeDelayMatch ? Number(resumeDelayMatch[1]) : 2000,
    },
    audio: { enabled: audioEnabled },
    depthHero: { enabled: depthEnabled },
  });
}

function parseEditableContentFromSite(siteRoot, metadata = null) {
  const htmlPath = join(siteRoot, "index.html");
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, "utf-8");

  const getMatch = (pattern) => {
    const match = html.match(pattern);
    return match?.[1] ? stripHtml(match[1]) : "";
  };

  const hero = {
    kicker: getMatch(/<p class="hero-kicker">([\s\S]*?)<\/p>/i),
    title: getMatch(/<section class="hero-standalone"[^>]*>[\s\S]*?<h1>([\s\S]*?)<\/h1>/i),
    sub: getMatch(/<p class="hero-sub">([\s\S]*?)<\/p>/i),
    trustLine: getMatch(/<p class="hero-trust">([\s\S]*?)<\/p>/i),
  };

  const sectionBlocks = Array.from(html.matchAll(/<section[^>]+class="scroll-section[\s\S]*?<\/section>/gi), (match) => match[0]);
  const sections = sectionBlocks.map((block) => {
    const kind = stripHtml(block.match(/data-editor-kind="([^"]+)"/i)?.[1] || "")
      || (block.includes("section-stats") ? "stats" : "")
      || (block.includes("cards-grid faq-grid") ? "faq" : "")
      || (block.includes("cards-grid") ? "cards" : "")
      || (block.includes("cta-button") ? "cta" : "copy");
    const section = {
      kind,
      label: stripHtml(block.match(/<p class="section-label">([\s\S]*?)<\/p>/i)?.[1] || ""),
      heading: stripHtml(block.match(/<h2 class="section-heading">([\s\S]*?)<\/h2>/i)?.[1] || ""),
      body: stripHtml(block.match(/<p class="section-body">([\s\S]*?)<\/p>/i)?.[1] || ""),
      button: stripHtml(block.match(/<a class="cta-button"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || ""),
      stats: [],
      cards: [],
      items: [],
    };

    if (kind === "stats") {
      section.stats = Array.from(
        block.matchAll(/<div class="stat">\s*<span class="stat-number" data-value="([^"]*)" data-decimals="([^"]*)">[\s\S]*?<\/span>\s*<span class="stat-suffix">([\s\S]*?)<\/span>\s*<span class="stat-label">([\s\S]*?)<\/span>\s*<\/div>/gi),
        (statMatch) => ({
          value: stripHtml(statMatch[1] || ""),
          decimals: stripHtml(statMatch[2] || "0"),
          suffix: stripHtml(statMatch[3] || ""),
          label: stripHtml(statMatch[4] || ""),
        })
      );
    }

    if (kind === "cards") {
      section.cards = Array.from(
        block.matchAll(/<article class="stat info-card">\s*<span class="stat-label">([\s\S]*?)<\/span>\s*<p class="card-body">([\s\S]*?)<\/p>\s*<\/article>/gi),
        (cardMatch) => ({
          title: stripHtml(cardMatch[1] || ""),
          body: stripHtml(cardMatch[2] || ""),
        })
      );
    }

    if (kind === "faq") {
      section.items = Array.from(
        block.matchAll(/<article class="stat info-card">\s*<span class="stat-label">([\s\S]*?)<\/span>\s*<p class="card-body">([\s\S]*?)<\/p>\s*<\/article>/gi),
        (itemMatch) => ({
          question: stripHtml(itemMatch[1] || ""),
          answer: stripHtml(itemMatch[2] || ""),
        })
      );
    }

    return section;
  });

  if (!sections.length && Array.isArray(metadata?.editableContent?.sections)) {
    return metadata.editableContent;
  }

  const ctaSection = sections[sections.length - 1] || null;
  return {
    hero,
    marqueeText: getMatch(/<p class="marquee-text">([\s\S]*?)<\/p>/i).split("·")[0]?.trim() || "",
    sections: ctaSection ? sections.slice(0, -1) : sections,
    cta: ctaSection
      ? {
          label: ctaSection.label,
          heading: ctaSection.heading,
          body: ctaSection.body,
          button: ctaSection.button,
          headerCta: getMatch(/<header class="site-header">[\s\S]*?<a href="#cta">([\s\S]*?)<\/a>/i),
        }
      : {
          label: "",
          heading: "",
          body: "",
          button: "",
          headerCta: "",
        },
  };
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
  const draftPreviews = new Map();

  mkdirSync(generatedDir, { recursive: true });

  function cleanupExpiredDraftPreviews() {
    const now = Date.now();
    for (const [previewId, preview] of draftPreviews.entries()) {
      if (preview.expiresAt > now) continue;
      rmSync(preview.rootDir, { recursive: true, force: true });
      draftPreviews.delete(previewId);
    }
  }

  function registerDraftPreview(userId, rootDir, siteDir) {
    cleanupExpiredDraftPreviews();
    const previewId = randomUUID();
    draftPreviews.set(previewId, {
      userId,
      rootDir,
      siteDir,
      expiresAt: Date.now() + DRAFT_PREVIEW_TTL_MS,
    });
    return previewId;
  }

  function resolveDraftPreview(previewId) {
    cleanupExpiredDraftPreviews();
    const preview = draftPreviews.get(previewId) || null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      rmSync(preview.rootDir, { recursive: true, force: true });
      draftPreviews.delete(previewId);
      return null;
    }
    preview.expiresAt = Date.now() + DRAFT_PREVIEW_TTL_MS;
    return preview;
  }

  async function resolvePreviewCinematicLayers(userId, rawLayers, files = {}, previewId) {
    if (!rawLayers || typeof rawLayers !== "object") return null;

    const mapLayer = async (layer, fallbackLabel) => {
      if (!layer || typeof layer !== "object") {
        return {
          enabled: false,
          label: fallbackLabel,
          layout: "card",
          loopMode: "loop",
          speed: 1,
          parallax: false,
          url: "",
        };
      }

      const uploadField = cleanOptionalString(layer.uploadField);
      const uploadedFile = uploadField ? files?.[uploadField] : null;
      if (uploadedFile?.path) {
        return {
          enabled: Boolean(layer.enabled),
          label: cleanOptionalString(layer.label) || fallbackLabel,
          layout: String(layer.layout || "card"),
          loopMode: String(layer.loopMode || "loop"),
          speed: Number(layer.speed || 1),
          parallax: Boolean(layer.parallax),
          url: `/draft-previews/${previewId}/assets/${encodeURIComponent(basename(uploadedFile.path))}`,
        };
      }

      const sourceUrl = cleanOptionalString(layer.sourceUrl || layer.sourceInput || layer.url);
      if (!sourceUrl) {
        return {
          enabled: false,
          label: cleanOptionalString(layer.label) || fallbackLabel,
          layout: String(layer.layout || "card"),
          loopMode: String(layer.loopMode || "loop"),
          speed: Number(layer.speed || 1),
          parallax: Boolean(layer.parallax),
          url: "",
        };
      }

      await resolveGeneratedSiteAssetInput(userId, sourceUrl);
      return {
        enabled: Boolean(layer.enabled),
        label: cleanOptionalString(layer.label) || fallbackLabel,
        layout: String(layer.layout || "card"),
        loopMode: String(layer.loopMode || "loop"),
        speed: Number(layer.speed || 1),
        parallax: Boolean(layer.parallax),
        url: sourceUrl,
      };
    };

    return {
      hero: await mapLayer(rawLayers.hero, "Hero"),
      sections: await Promise.all(
        (Array.isArray(rawLayers.sections) ? rawLayers.sections : []).map((layer, index) =>
          mapLayer(layer, `Section ${index + 1}`)
        )
      ),
    };
  }

  async function runDraftPreviewBuild({
    userId,
    sourceSlug,
    previewRoot,
    siteConfig,
    contentOverrides,
    rawCinematicLayers,
    experienceUpgrades,
    mediaPlayback,
    files = {},
    startPrompt,
    endPrompt,
    videoPrompt,
    publicSiteUrl,
  }) {
    const uploadedStartImage = pickUploadedFile(files, "startImage", isUploadedImage);
    const uploadedEndImage = pickUploadedFile(files, "endImage", isUploadedImage);
    const uploadedVideo = pickUploadedFile(files, "video", isUploadedVideo);
    const existingMedia = resolveEditSourceMedia(sourceSlug);
    const hasReplacementVideo = Boolean(uploadedVideo);
    const startImage = uploadedStartImage || (!hasReplacementVideo ? existingMedia?.startImage : null) || null;
    const endImage = uploadedEndImage || (!hasReplacementVideo ? existingMedia?.endImage : null) || null;
    const previewVideoPath = uploadedVideo || existingMedia?.videoPath || null;
    if (!previewVideoPath) {
      throw new Error("A draft preview build requires either an uploaded video or an existing video on the source site.");
    }
    logBackend(
      `draft-preview-build source=${sourceSlug} video=${previewVideoPath} ` +
      `startImage=${startImage || "derive"} endImage=${endImage || "derive"} previewRoot=${previewRoot}`
    );

    const cinematicLayers = await hydrateCinematicLayersForBuild(userId, rawCinematicLayers, files);
    const args = [
      pipelineScript,
      "--topic",
      String(siteConfig.topic || siteConfig.title || sourceSlug).trim(),
      "--slug",
      sourceSlug,
      "--out-dir",
      previewRoot,
      "--page-mode",
      normalizePageMode(siteConfig.pageMode),
      "--video-path",
      previewVideoPath,
      "--edit-source-slug",
      sourceSlug,
      "--content-overrides",
      JSON.stringify(contentOverrides || siteConfig.editableContent || {}),
      "--experience-upgrades",
      JSON.stringify(experienceUpgrades || siteConfig.experienceUpgrades || {}),
      "--media-playback",
      JSON.stringify(mediaPlayback || siteConfig.mediaPlayback || {}),
    ];

    if (startImage) args.push("--start-image", startImage);
    if (endImage) args.push("--end-image", endImage);
    if (siteConfig.existingWebsite) args.push("--source-url", siteConfig.existingWebsite);
    if (publicSiteUrl) args.push("--site-url", publicSiteUrl);
    if (startPrompt || siteConfig.startPrompt) args.push("--start-prompt", startPrompt || siteConfig.startPrompt);
    if (endPrompt || siteConfig.endPrompt) args.push("--end-prompt", endPrompt || siteConfig.endPrompt);
    if (videoPrompt || siteConfig.videoPrompt) args.push("--motion-prompt", videoPrompt || siteConfig.videoPrompt);
    if (cinematicLayers) args.push("--cinematic-layers", JSON.stringify(cinematicLayers));

    for (const color of parseColorList(siteConfig.colors)) {
      args.push("--color", color);
    }

    const child = spawn("node", args, {
      cwd: rootDir,
      env: { ...process.env, FAL_KEY: process.env.FAL_KEY || "" },
    });

    let logs = "";
    await new Promise((resolvePromise, rejectPromise) => {
      child.stdout.on("data", (chunk) => {
        logs += String(chunk || "");
      });
      child.stderr.on("data", (chunk) => {
        logs += String(chunk || "");
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(logs.trim() || `Draft preview build failed with exit code ${code}`));
      });
    });

    const previewSiteDir = join(previewRoot, sourceSlug);
    if (!existsSync(join(previewSiteDir, "index.html"))) {
      throw new Error("Draft preview build finished without producing an index.html file.");
    }
    logBackend(`draft-preview-build-complete source=${sourceSlug} previewSiteDir=${previewSiteDir}`);
    return previewSiteDir;
  }

  function buildDraftPreviewRuntimeScript(previewData) {
    const serializedData = JSON.stringify(previewData).replace(/</g, "\\u003c");
    return `
<script>
(() => {
  const draft = ${serializedData};

  function updateText(selector, value, root = document) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value || "";
  }

  function upsertMeta(attribute, key, content) {
    let selector = "";
    if (attribute === "name") selector = 'meta[name="' + key + '"]';
    if (attribute === "property") selector = 'meta[property="' + key + '"]';
    let meta = selector ? document.head.querySelector(selector) : null;
    if (!content) {
      if (meta) meta.remove();
      return;
    }
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute(attribute, key);
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", content);
  }

  function upsertCanonical(url) {
    let link = document.head.querySelector('link[rel="canonical"]');
    if (!url) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", url);
  }

  function applySeo() {
    const canonicalUrl = String(draft.publicSiteUrl || "").trim();
    const title = String(draft.title || "").trim();
    if (title) document.title = title;
    upsertCanonical(canonicalUrl);
    upsertMeta("property", "og:url", canonicalUrl || "");
    upsertMeta("name", "robots", canonicalUrl ? "index, follow" : "noindex, nofollow");
  }

  function ensureCinematicStyles() {
    if (document.getElementById("uw-draft-preview-style")) return;
    const style = document.createElement("style");
    style.id = "uw-draft-preview-style";
    style.textContent = \`
      .hero-standalone { position: relative; }
      .hero-standalone > *:not(.hero-cinematic) { position: relative; z-index: 2; }
      .hero-cinematic,
      .section-cinematic {
        position: absolute;
        overflow: hidden;
        border-radius: 1.6rem;
        border: 1px solid rgba(255,255,255,0.1);
        background:
          linear-gradient(160deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
          rgba(5,8,10,0.34);
        box-shadow: 0 28px 70px rgba(0,0,0,0.34);
        z-index: 0;
      }
      .hero-cinematic::after,
      .section-cinematic::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          linear-gradient(180deg, rgba(8,10,15,0.04), rgba(8,10,15,0.28)),
          radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 28%);
      }
      .hero-cinematic-full {
        inset: 0;
        border-radius: 0;
        border: 0;
        box-shadow: none;
        background: rgba(0,0,0,0.12);
      }
      .hero-cinematic-full::after {
        background:
          linear-gradient(90deg, rgba(7,8,12,0.82) 0%, rgba(7,8,12,0.46) 38%, rgba(7,8,12,0.28) 62%, rgba(7,8,12,0.62) 100%),
          radial-gradient(circle at 20% 20%, rgba(255,255,255,0.1), transparent 26%);
      }
      .hero-cinematic-card { inset: 8vh 5vw 12vh 49vw; }
      .section-cinematic { top: 50%; transform: translateY(-50%); }
      .section-cinematic-card { width: min(34vw, 32rem); aspect-ratio: 16 / 10; }
      .section-cinematic-right { right: 5vw; }
      .section-cinematic-left { left: 5vw; }
      .section-cinematic-center { left: 50%; transform: translate(-50%, -50%); width: min(72vw, 56rem); aspect-ratio: 16 / 7; }
      .section-cinematic-full { inset: clamp(1rem, 3vw, 2rem) 4vw; top: 0; transform: none; border-radius: 2rem; }
      .section-cinematic-full::after {
        background:
          linear-gradient(180deg, rgba(7,9,13,0.68), rgba(7,9,13,0.38)),
          radial-gradient(circle at 50% 12%, rgba(255,255,255,0.14), transparent 24%);
      }
      .cinematic-video {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
        pointer-events: none;
      }
      body.guided-mode-active { cursor: ns-resize; }
      .experience-controls { position: fixed; inset: 0; pointer-events: none; z-index: 55; }
      .experience-button {
        position: fixed;
        bottom: 1.25rem;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 999px;
        width: 3.25rem;
        height: 3.25rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font: inherit;
        font-size: 1.2rem;
        line-height: 1;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05)),
          rgba(10,9,15,0.8);
        backdrop-filter: blur(14px);
        box-shadow: 0 18px 40px rgba(0,0,0,0.24);
        pointer-events: auto;
      }
      .experience-button[data-experience-slot="guided"] { left: 1.25rem; }
      .experience-button[data-experience-slot="sound"] { right: 1.25rem; }
      .experience-button[data-experience-active="true"] {
        border-color: rgba(255,255,255,0.28);
        box-shadow: 0 18px 40px rgba(0,0,0,0.24), 0 0 0 1px rgba(255,255,255,0.08) inset;
      }
      .hero-standalone { perspective: 1600px; }
      .hero-depth-grid { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
      .depth-orb, .depth-ring, .depth-beam { position: absolute; display: block; will-change: transform; }
      .depth-orb { border-radius: 999px; filter: blur(8px); }
      .depth-orb-a {
        width: min(28vw, 22rem); height: min(28vw, 22rem); top: 10vh; left: 8vw;
        background: radial-gradient(circle, rgba(246,107,162,0.22), rgba(246,107,162,0.02) 60%, transparent 72%);
        transform: translate3d(calc(var(--depth-x, 0) * -18px), calc(var(--depth-y, 0) * -24px), 90px);
      }
      .depth-orb-b {
        width: min(22vw, 18rem); height: min(22vw, 18rem); right: 10vw; bottom: 16vh;
        background: radial-gradient(circle, rgba(244,177,77,0.18), rgba(244,177,77,0.02) 58%, transparent 72%);
        transform: translate3d(calc(var(--depth-x, 0) * 24px), calc(var(--depth-y, 0) * 16px), 70px);
      }
      .depth-ring {
        width: min(42vw, 38rem); height: min(42vw, 38rem); right: 18vw; top: 8vh;
        border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); box-shadow: inset 0 0 50px rgba(255,255,255,0.04);
        transform: rotate(18deg) translate3d(calc(var(--depth-x, 0) * 12px), calc(var(--depth-y, 0) * -12px), 20px);
      }
      .depth-beam {
        inset: 12vh auto auto 42vw; width: min(28vw, 24rem); height: 65vh;
        background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0));
        clip-path: polygon(38% 0, 64% 0, 100% 100%, 0 100%); opacity: 0.25;
        transform: translate3d(calc(var(--depth-x, 0) * 20px), calc(var(--depth-y, 0) * -10px), 10px);
      }
      .hero-frame-glare {
        position: absolute; inset: 0;
        background:
          radial-gradient(circle at calc(52% + var(--depth-x, 0) * 16%), calc(28% + var(--depth-y, 0) * 14%), rgba(255,255,255,0.22), transparent 24%),
          linear-gradient(120deg, rgba(255,255,255,0.06), transparent 40%);
        mix-blend-mode: screen; pointer-events: none;
      }
      .hero-cinematic-card {
        transform-style: preserve-3d;
        transform:
          translate3d(calc(var(--depth-x, 0) * 20px), calc(var(--scroll-shift-y, 0px) + var(--depth-y, 0) * -18px), 70px)
          rotateX(calc(var(--depth-y, 0) * -5deg))
          rotateY(calc(var(--depth-x, 0) * 7deg));
      }
      .hero-cinematic-card.cinematic-parallax {
        transform:
          translate3d(calc(var(--parallax-x, 0) * 20px), calc(var(--scroll-shift-y, 0px) + var(--parallax-y, 0) * -18px), 70px)
          rotateX(calc(var(--parallax-y, 0) * -5deg))
          rotateY(calc(var(--parallax-x, 0) * 7deg));
      }
      .section-cinematic-card.cinematic-parallax,
      .section-cinematic-center.cinematic-parallax {
        transform:
          translate3d(calc(var(--parallax-x, 0) * 16px), calc(-50% + var(--parallax-y, 0) * -14px), 48px)
          rotateX(calc(var(--parallax-y, 0) * -4deg))
          rotateY(calc(var(--parallax-x, 0) * 6deg));
      }
      .scroll-section { isolation: isolate; }
      .section-inner { position: relative; z-index: 2; }
      @media (max-width: 900px) {
        .experience-button {
          bottom: 0.9rem;
          width: 3rem;
          height: 3rem;
          font-size: 1.05rem;
        }
        .experience-button[data-experience-slot="guided"] { left: 0.9rem; }
        .experience-button[data-experience-slot="sound"] { right: 0.9rem; }
        .hero-cinematic-card,
        .section-cinematic-card,
        .section-cinematic-center,
        .section-cinematic-full {
          position: relative;
          inset: auto;
          left: auto;
          right: auto;
          top: auto;
          transform: none;
          width: 100%;
          aspect-ratio: 16 / 9;
          margin: 0 auto 1rem;
        }
        .hero-standalone { perspective: none; }
        .hero-depth-grid { opacity: 0.75; }
      }
    \`;
    document.head.appendChild(style);
  }

  function ensureExperienceControls() {
    const settings = draft.experienceUpgrades || {};
    if (!settings.guidedScroll?.enabled && !settings.audio?.enabled) return {};
    let controls = document.querySelector(".experience-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "experience-controls";
      document.body.appendChild(controls);
    }
    if (settings.guidedScroll?.enabled && !controls.querySelector("[data-guided-mode-btn]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "experience-button";
      button.setAttribute("data-guided-mode-btn", "true");
      button.setAttribute("data-experience-slot", "guided");
      button.textContent = "↕";
      controls.appendChild(button);
    }
    if (settings.audio?.enabled && !controls.querySelector("[data-sound-toggle-btn]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "experience-button";
      button.setAttribute("data-sound-toggle-btn", "true");
      button.setAttribute("data-experience-slot", "sound");
      button.textContent = "♪";
      controls.appendChild(button);
    }
    return {
      guidedModeButton: controls.querySelector("[data-guided-mode-btn]"),
      soundToggleButton: controls.querySelector("[data-sound-toggle-btn]"),
    };
  }

  let guidedModeRaf = 0;
  let guidedModeActive = false;
  let guidedModeDismissed = false;
  let guidedModeStartedAt = 0;
  let guidedModePhase = "down";
  let guidedModeOrigin = 0;
  let guidedModePauseUntil = 0;
  let guidedResumeTimer = 0;
  let lastKnownScrollY = 0;
  let ambientAudioContext = null;
  let ambientAudioNodes = [];
  let ambientPulseTimer = 0;
  let ambientAudioEnabled = false;

  function updateGuidedModeUi(button) {
    if (!button) return;
    button.textContent = "↕";
    button.dataset.experienceActive = guidedModeActive ? "true" : "false";
    button.setAttribute("aria-label", guidedModeActive ? "Guided mode on" : guidedModeDismissed ? "Resume guided mode" : "Guided mode off");
    button.title = button.getAttribute("aria-label");
    document.body.classList.toggle("guided-mode-active", guidedModeActive);
  }

  function stopGuidedMode(button, markDismissed = true) {
    guidedModeActive = false;
    if (markDismissed) guidedModeDismissed = true;
    if (guidedModeRaf) cancelAnimationFrame(guidedModeRaf);
    guidedModeRaf = 0;
    const scroller = document.scrollingElement || document.documentElement;
    guidedModeOrigin = scroller.scrollTop;
    guidedModePauseUntil = 0;
    updateGuidedModeUi(button);
  }

  function guidedModeStep(button) {
    const settings = draft.experienceUpgrades?.guidedScroll || {};
    if (!guidedModeActive) return;
    const scroller = document.scrollingElement || document.documentElement;
    const now = performance.now();
    if (guidedModePauseUntil && now < guidedModePauseUntil) {
      guidedModeRaf = requestAnimationFrame(() => guidedModeStep(button));
      return;
    }
    if (guidedModePauseUntil && now >= guidedModePauseUntil) {
      guidedModePauseUntil = 0;
      guidedModePhase = "up";
      guidedModeOrigin = scroller.scrollTop;
      guidedModeStartedAt = 0;
    }
    if (!guidedModeStartedAt) guidedModeStartedAt = now;
    const duration = guidedModePhase === "down" ? Number(settings.downDurationMs || 112500) : Number(settings.upDurationMs || 56250);
    const progress = Math.min(1, (now - guidedModeStartedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 2.2);
    const maxScroll = Math.max(0, scroller.scrollHeight - window.innerHeight);
    const isNearBottom = scroller.scrollTop >= Math.max(0, maxScroll - 8);
    if (guidedModePhase === "down" && isNearBottom) {
      guidedModePauseUntil = now + Number(settings.endPauseMs || 3000);
      scroller.scrollTop = maxScroll;
      guidedModeRaf = requestAnimationFrame(() => guidedModeStep(button));
      return;
    }
    const target = guidedModePhase === "down" ? maxScroll : 0;
    scroller.scrollTop = guidedModeOrigin + (target - guidedModeOrigin) * eased;
    if (progress >= 1) {
      if (guidedModePhase === "down") {
        guidedModePauseUntil = now + Number(settings.endPauseMs || 3000);
        guidedModeOrigin = scroller.scrollTop;
      } else {
        guidedModePhase = "down";
        guidedModeOrigin = scroller.scrollTop;
        guidedModeStartedAt = 0;
      }
    }
    guidedModeRaf = requestAnimationFrame(() => guidedModeStep(button));
  }

  function startGuidedMode(button) {
    const settings = draft.experienceUpgrades?.guidedScroll || {};
    if (!settings.enabled || guidedModeActive) return;
    if (guidedResumeTimer) {
      clearTimeout(guidedResumeTimer);
      guidedResumeTimer = 0;
    }
    guidedModeActive = true;
    guidedModeStartedAt = 0;
    guidedModePauseUntil = 0;
    const scroller = document.scrollingElement || document.documentElement;
    guidedModeOrigin = scroller.scrollTop;
    guidedModePhase = scroller.scrollTop >= Math.max(0, scroller.scrollHeight - window.innerHeight - 8) ? "up" : "down";
    updateGuidedModeUi(button);
    guidedModeRaf = requestAnimationFrame(() => guidedModeStep(button));
  }

  function scheduleGuidedResume(button) {
    const settings = draft.experienceUpgrades?.guidedScroll || {};
    if (!settings.enabled) return;
    if (guidedResumeTimer) clearTimeout(guidedResumeTimer);
    guidedResumeTimer = setTimeout(() => {
      if (!guidedModeActive) {
        guidedModeDismissed = false;
        startGuidedMode(button);
      }
    }, Number(settings.resumeDelayMs || 2000));
  }

  function bindGuidedMode(button) {
    const settings = draft.experienceUpgrades?.guidedScroll || {};
    if (!button || button.dataset.bound === "true" || !settings.enabled) return;
    button.dataset.bound = "true";
    const interrupt = (event) => {
      if (event?.target instanceof Node && button.contains(event.target)) return;
      if (guidedModeActive) stopGuidedMode(button, true);
      scheduleGuidedResume(button);
    };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach((eventName) => window.addEventListener(eventName, interrupt, { passive: true }));
    window.addEventListener("scroll", () => {
      const scroller = document.scrollingElement || document.documentElement;
      const currentScrollY = scroller.scrollTop;
      const delta = Math.abs(currentScrollY - lastKnownScrollY);
      lastKnownScrollY = currentScrollY;
      if (!guidedModeActive && delta > 2) scheduleGuidedResume(button);
    }, { passive: true });
    button.addEventListener("click", () => {
      if (guidedModeActive) {
        if (guidedResumeTimer) {
          clearTimeout(guidedResumeTimer);
          guidedResumeTimer = 0;
        }
        stopGuidedMode(button, true);
        return;
      }
      guidedModeDismissed = false;
      startGuidedMode(button);
    });
    const bootGuidedMode = () => {
      setTimeout(() => {
        if (!guidedModeDismissed) startGuidedMode(button);
      }, Number(settings.initialDelayMs || 6000));
    };
    if (document.readyState === "complete") {
      bootGuidedMode();
    } else {
      window.addEventListener("load", bootGuidedMode, { once: true });
    }
  }

  function createAudioVoice(context, type, frequency, gainValue) {
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    gain.gain.value = gainValue;
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    ambientAudioNodes.push(oscillator, filter, gain);
    return { oscillator, filter, gain };
  }

  function playAmbientPulse() {
    if (!ambientAudioContext) return;
    const pulseOsc = ambientAudioContext.createOscillator();
    const pulseGain = ambientAudioContext.createGain();
    pulseOsc.type = "sine";
    pulseOsc.frequency.setValueAtTime(220, ambientAudioContext.currentTime);
    pulseOsc.frequency.exponentialRampToValueAtTime(110, ambientAudioContext.currentTime + 1.8);
    pulseGain.gain.setValueAtTime(0.0001, ambientAudioContext.currentTime);
    pulseGain.gain.exponentialRampToValueAtTime(0.018, ambientAudioContext.currentTime + 0.2);
    pulseGain.gain.exponentialRampToValueAtTime(0.0001, ambientAudioContext.currentTime + 1.8);
    pulseOsc.connect(pulseGain);
    pulseGain.connect(ambientAudioContext.destination);
    pulseOsc.start();
    pulseOsc.stop(ambientAudioContext.currentTime + 2);
  }

  async function enableAmbientAudio(button) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!ambientAudioContext) ambientAudioContext = new AudioContextClass();
    await ambientAudioContext.resume();
    if (!ambientAudioEnabled) {
      const bass = createAudioVoice(ambientAudioContext, "triangle", 55, 0.018);
      const pad = createAudioVoice(ambientAudioContext, "sawtooth", 110, 0.008);
      createAudioVoice(ambientAudioContext, "sine", 220, 0.0035);
      const lfo = ambientAudioContext.createOscillator();
      const lfoGain = ambientAudioContext.createGain();
      lfo.type = "sine";
      lfo.frequency.value = 0.07;
      lfoGain.gain.value = 110;
      lfo.connect(lfoGain);
      lfoGain.connect(bass.filter.frequency);
      lfoGain.connect(pad.filter.frequency);
      lfo.start();
      ambientAudioNodes.push(lfo, lfoGain);
      playAmbientPulse();
      ambientPulseTimer = setInterval(playAmbientPulse, 6800);
    }
    ambientAudioEnabled = true;
    if (button) {
      button.textContent = "♪";
      button.dataset.experienceActive = "true";
      button.setAttribute("aria-label", "Sound on");
      button.title = "Sound on";
    }
  }

  function disableAmbientAudio(button) {
    if (ambientPulseTimer) clearInterval(ambientPulseTimer);
    ambientPulseTimer = 0;
    ambientAudioNodes.forEach((node) => {
      try { if (typeof node.stop === "function") node.stop(); } catch {}
      try { if (typeof node.disconnect === "function") node.disconnect(); } catch {}
    });
    ambientAudioNodes = [];
    ambientAudioEnabled = false;
    if (button) {
      button.textContent = "♪";
      button.dataset.experienceActive = "false";
      button.setAttribute("aria-label", "Sound off");
      button.title = "Sound off";
    }
  }

  function bindSoundToggle(button) {
    if (!button || button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      if (ambientAudioEnabled) {
        disableAmbientAudio(button);
        return;
      }
      try {
        await enableAmbientAudio(button);
      } catch {
        button.textContent = "Sound Unavailable";
      }
    });
  }

  function applyExperience() {
    const settings = draft.experienceUpgrades || {};
    const heroNode = document.querySelector(".hero-standalone");
    if (settings.depthHero?.enabled && heroNode) {
      if (!heroNode.querySelector(".hero-depth-grid")) {
        const depthGrid = document.createElement("div");
        depthGrid.className = "hero-depth-grid";
        depthGrid.setAttribute("aria-hidden", "true");
        depthGrid.innerHTML = '<span class="depth-orb depth-orb-a"></span><span class="depth-orb depth-orb-b"></span><span class="depth-ring"></span><span class="depth-beam"></span>';
        heroNode.insertBefore(depthGrid, heroNode.firstChild);
      }
      const cinematicNode = heroNode.querySelector(".hero-cinematic-card");
      if (cinematicNode && !cinematicNode.querySelector(".hero-frame-glare")) {
        const glare = document.createElement("div");
        glare.className = "hero-frame-glare";
        glare.setAttribute("aria-hidden", "true");
        cinematicNode.appendChild(glare);
      }
      if (heroNode.dataset.depthBound !== "true") {
        heroNode.dataset.depthBound = "true";
        heroNode.addEventListener("pointermove", (event) => {
          const bounds = heroNode.getBoundingClientRect();
          const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
          const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
          heroNode.style.setProperty("--depth-x", x.toFixed(3));
          heroNode.style.setProperty("--depth-y", y.toFixed(3));
        });
        heroNode.addEventListener("pointerleave", () => {
          heroNode.style.setProperty("--depth-x", "0");
          heroNode.style.setProperty("--depth-y", "0");
        });
      }
    }
    const { guidedModeButton, soundToggleButton } = ensureExperienceControls();
    bindGuidedMode(guidedModeButton);
    bindSoundToggle(soundToggleButton);
  }

  function setupVideo(video) {
    if (!video || video.dataset.previewBound === "true") return;
    video.dataset.previewBound = "true";
    const loopMode = String(video.dataset.loopMode || "loop");
    const speed = Math.min(2.5, Math.max(0.25, Number(video.dataset.playbackSpeed || 1) || 1));
    let reversing = false;
    let frameId = 0;
    let lastTick = 0;

    const stopReverse = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      reversing = false;
      lastTick = 0;
    };

    const restartForward = () => {
      stopReverse();
      video.currentTime = video.duration && video.duration > 0.001 ? 0.001 : 0;
      video.playbackRate = speed;
      video.play().catch(() => {});
    };

    const reverseStep = (timestamp) => {
      if (!reversing) return;
      if (!lastTick) lastTick = timestamp;
      const delta = (timestamp - lastTick) / 1000;
      lastTick = timestamp;
      const nextTime = Math.max(0, video.currentTime - delta * speed);
      video.currentTime = nextTime;
      if (nextTime <= 0.02) {
        restartForward();
        return;
      }
      frameId = requestAnimationFrame(reverseStep);
    };

    const startReverse = () => {
      if (loopMode !== "boomerang" || reversing) return;
      if (video.duration && video.currentTime >= video.duration - 0.02) {
        video.currentTime = Math.max(0, video.duration - 0.02);
      }
      reversing = true;
      video.pause();
      frameId = requestAnimationFrame(reverseStep);
    };

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = "auto";
    video.loop = loopMode !== "boomerang";
    video.playbackRate = speed;
    video.addEventListener("canplay", () => {
      video.playbackRate = speed;
      video.play().catch(() => {});
    });
    video.addEventListener("loadeddata", () => {
      video.playbackRate = speed;
      if (loopMode === "boomerang" && video.currentTime <= 0) {
        video.currentTime = 0.001;
      }
    });
    if (loopMode === "boomerang") {
      video.addEventListener("ended", startReverse);
      video.addEventListener("timeupdate", () => {
        if (!reversing && video.duration && video.currentTime >= video.duration - 0.04) {
          startReverse();
        }
      });
      video.addEventListener("seeked", () => {
        if (reversing && video.currentTime <= 0.02) {
          restartForward();
        }
      });
      video.addEventListener("play", () => {
        if (reversing) stopReverse();
      });
    }
  }

  function applyMediaPlayback() {
    const mediaStage = document.querySelector(".media-stage");
    if (!mediaStage) return;
    const playback = draft.mediaPlayback || {};
    const canvasWrap = mediaStage.querySelector(".canvas-wrap");
    const playbackUrl = String(playback.url || "").trim() || "media/transition.mp4";
    const shouldUseVideo = Boolean(playback.enabled && playbackUrl);
    let videoWrap = mediaStage.querySelector("[data-draft-main-video='true']");

    if (!shouldUseVideo) {
      if (videoWrap) videoWrap.remove();
      mediaStage.classList.remove("is-video-playback");
      if (canvasWrap) {
        canvasWrap.style.opacity = "1";
        canvasWrap.style.visibility = "";
      }
      return;
    }

    mediaStage.classList.add("is-video-playback");
    if (!videoWrap) {
      videoWrap = document.createElement("div");
      videoWrap.setAttribute("data-draft-main-video", "true");
      videoWrap.style.position = "absolute";
      videoWrap.style.inset = "0";
      videoWrap.style.display = "flex";
      videoWrap.style.alignItems = "center";
      videoWrap.style.justifyContent = "center";
      videoWrap.style.background = "#0a0a0a";
      videoWrap.style.pointerEvents = "none";
      mediaStage.appendChild(videoWrap);
    }

    videoWrap.innerHTML = "";
    const video = document.createElement("video");
    video.dataset.loopMode = playback.loopMode || "loop";
    video.dataset.playbackSpeed = String(playback.speed || 1);
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.display = "block";
    video.style.objectFit = window.innerWidth <= 900 && String(playback.mobileFit || "contain") === "cover" ? "cover" : "contain";
    video.style.background = "#0a0a0a";
    const source = document.createElement("source");
    source.src = playbackUrl;
    source.type = /\.webm$/i.test(playbackUrl) ? "video/webm" : /\.ogg$/i.test(playbackUrl) ? "video/ogg" : "video/mp4";
    video.appendChild(source);
    videoWrap.appendChild(video);
    setupVideo(video);
    video.load();

    if (canvasWrap) {
      canvasWrap.style.opacity = "0";
      canvasWrap.style.visibility = "hidden";
    }
  }

  function getSectionPlacementClass(sectionNode, layer) {
    if (layer.layout === "full-background") return "section-cinematic section-cinematic-full";
    if (sectionNode.classList.contains("align-right")) return "section-cinematic section-cinematic-card section-cinematic-left";
    if (sectionNode.classList.contains("align-center")) return "section-cinematic section-cinematic-card section-cinematic-center";
    return "section-cinematic section-cinematic-card section-cinematic-right";
  }

  function setupLayerParallax(wrapper, hostNode) {
    if (!wrapper || !hostNode || wrapper.dataset.parallaxBound === "true") return;
    wrapper.dataset.parallaxBound = "true";

    const reset = () => {
      wrapper.style.setProperty("--parallax-x", "0");
      wrapper.style.setProperty("--parallax-y", "0");
    };

    hostNode.addEventListener("pointermove", (event) => {
      const bounds = hostNode.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
      const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
      wrapper.style.setProperty("--parallax-x", x.toFixed(3));
      wrapper.style.setProperty("--parallax-y", y.toFixed(3));
    });
    hostNode.addEventListener("pointerleave", reset);
    reset();
  }

  function renderLayer(layer, options = {}) {
    if (!layer || !layer.enabled || !layer.url) return null;
    const wrapper = document.createElement("div");
    wrapper.className = options.type === "hero"
      ? "hero-cinematic " + (layer.layout === "full-background" ? "hero-cinematic-full" : "hero-cinematic-card")
      : getSectionPlacementClass(options.sectionNode, layer);
    if (layer.parallax) wrapper.classList.add("cinematic-parallax");
    const video = document.createElement("video");
    video.className = "cinematic-video";
    video.dataset.loopMode = layer.loopMode || "loop";
    video.dataset.playbackSpeed = String(layer.speed || 1);
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = layer.url;
    wrapper.appendChild(video);
    setupVideo(video);
    if (layer.parallax) {
      setupLayerParallax(wrapper, options.type === "hero" ? options.hostNode : options.sectionNode);
    }
    return wrapper;
  }

  function toggleLegacyHeroMedia(enabled) {
    [
      document.querySelector(".hero-standalone .hero-frame-stage"),
      document.querySelector(".hero-standalone .hero-depth-grid"),
      document.querySelector(".video-stage"),
    ]
      .filter(Boolean)
      .forEach((node) => {
        if (!node.dataset.previewOriginalDisplay) {
          node.dataset.previewOriginalDisplay = node.style.display || "";
        }
        node.style.display = enabled ? "none" : node.dataset.previewOriginalDisplay;
      });
  }

  function applyContent() {
    const content = draft.editableContent || {};
    updateText(".hero-kicker", content.hero && content.hero.kicker);
    updateText(".hero-standalone h1", content.hero && content.hero.title);
    updateText(".hero-sub", content.hero && content.hero.sub);
    updateText(".hero-trust", content.hero && content.hero.trustLine);
    updateText(".marquee-text", content.marqueeText);
    updateText(".site-header a[href=\"#cta\"]", content.cta && content.cta.headerCta);

    const sectionNodes = Array.from(document.querySelectorAll(".scroll-section")).filter((node) => node.id !== "cta");
    (content.sections || []).forEach((section, index) => {
      const node = sectionNodes[index];
      if (!node) return;
      updateText(".section-label", section.label, node);
      updateText(".section-heading", section.heading, node);
      updateText(".section-body", section.body, node);
      updateText(".cta-button", section.button, node);

      if (section.kind === "stats") {
        Array.from(node.querySelectorAll(".stat")).forEach((statNode, statIndex) => {
          const stat = section.stats && section.stats[statIndex];
          if (!stat) return;
          const statNumber = statNode.querySelector(".stat-number");
          if (statNumber) {
            statNumber.textContent = stat.value || "";
            statNumber.setAttribute("data-value", stat.value || "");
          }
          updateText(".stat-suffix", stat.suffix, statNode);
          updateText(".stat-label", stat.label, statNode);
        });
      }

      if (section.kind === "cards") {
        Array.from(node.querySelectorAll(".info-card")).forEach((cardNode, cardIndex) => {
          const card = section.cards && section.cards[cardIndex];
          if (!card) return;
          updateText(".stat-label", card.title, cardNode);
          updateText(".card-body", card.body, cardNode);
        });
      }

      if (section.kind === "faq") {
        Array.from(node.querySelectorAll(".info-card")).forEach((itemNode, itemIndex) => {
          const item = section.items && section.items[itemIndex];
          if (!item) return;
          updateText(".stat-label", item.question, itemNode);
          updateText(".card-body", item.answer, itemNode);
        });
      }
    });

    const ctaNode = document.querySelector("#cta");
    if (ctaNode && content.cta) {
      updateText(".section-label", content.cta.label, ctaNode);
      updateText(".section-heading", content.cta.heading, ctaNode);
      updateText(".section-body", content.cta.body, ctaNode);
      updateText(".cta-button", content.cta.button, ctaNode);
    }
  }

  function applyCinematic() {
    ensureCinematicStyles();
    const layers = draft.cinematicLayers || {};

    const heroNode = document.querySelector(".hero-standalone");
    if (heroNode) {
      heroNode.querySelectorAll(".hero-cinematic").forEach((node) => node.remove());
      const heroLayer = renderLayer(layers.hero, { type: "hero", hostNode: heroNode });
      toggleLegacyHeroMedia(Boolean(layers.hero && layers.hero.enabled));
      if (heroLayer) heroNode.insertBefore(heroLayer, heroNode.firstChild);
    }

    const sectionNodes = Array.from(document.querySelectorAll(".scroll-section")).filter((node) => node.id !== "cta");
    sectionNodes.forEach((sectionNode, index) => {
      sectionNode.querySelectorAll(".section-cinematic").forEach((node) => node.remove());
      const layer = layers.sections && layers.sections[index];
      const cinematicNode = renderLayer(layer, { sectionNode });
      if (cinematicNode) sectionNode.insertBefore(cinematicNode, sectionNode.firstChild);
    });
  }

  function applyDraft() {
    applySeo();
    applyContent();
    applyCinematic();
    applyMediaPlayback();
    applyExperience();
  }

  const scheduleApplyDraft = () => {
    applyDraft();
    requestAnimationFrame(applyDraft);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleApplyDraft, { once: true });
  } else {
    scheduleApplyDraft();
  }
  window.addEventListener("load", scheduleApplyDraft, { once: true });
})();
</script>`;
  }

  function renderDraftPreviewHtml(sourceSlug, previewData) {
    const indexPath = join(generatedDir, sourceSlug, "index.html");
    if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
      throw new Error("Generated site files not found.");
    }

    const rawHtml = readFileSync(indexPath, "utf-8");
    const baseTag = `<base href="${escapeHtml(`/generated-sites/${sourceSlug}/`)}" />`;
    const withBase = /<head([^>]*)>/i.test(rawHtml)
      ? rawHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : `<!doctype html><html><head>${baseTag}</head><body>${rawHtml}</body></html>`;
    return withBase.replace(/<\/body>/i, `${buildDraftPreviewRuntimeScript(previewData)}</body>`);
  }

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
    const editableContent = metadata.editableContent || parseEditableContentFromSite(siteRoot, metadata);
    const rawExperienceUpgrades = metadata.experienceUpgrades || parseExperienceUpgradesFromSite(siteRoot);
    const experienceUpgrades = rawExperienceUpgrades ? normalizeExperienceUpgrades(rawExperienceUpgrades) : null;
    const mediaPlayback = normalizeMediaPlayback(metadata.mediaPlayback);
    const cinematicLayers = metadata.cinematicLayers
      ? {
          hero: metadata.cinematicLayers.hero
            ? {
                ...metadata.cinematicLayers.hero,
                video: metadata.cinematicLayers.hero.video?.url
                  ? {
                      ...metadata.cinematicLayers.hero.video,
                      url: `/generated-sites/${slug}/${String(metadata.cinematicLayers.hero.video.url).replace(/^\/+/, "")}`,
                    }
                  : metadata.cinematicLayers.hero.video,
              }
            : null,
          sections: Array.isArray(metadata.cinematicLayers.sections)
            ? metadata.cinematicLayers.sections.map((layer) => ({
                ...layer,
                video: layer?.video?.url
                  ? {
                      ...layer.video,
                      url: `/generated-sites/${slug}/${String(layer.video.url).replace(/^\/+/, "")}`,
                    }
                  : layer?.video,
              }))
            : [],
        }
      : null;

    return {
      slug,
      title: String(editableContent?.hero?.title || metadata.topic || slug.replace(/-/g, " ")).trim(),
      topic: String(metadata.topic || "").trim(),
      pageMode: normalizePageMode(metadata.pageMode),
      existingWebsite: cleanOptionalString(metadata.sourceUrl || metadata.sourceContext?.url),
      publicSiteUrl: cleanOptionalString(metadata.siteUrl || metadata.seo?.canonicalUrl),
      colors: palette.join(", "),
      startPrompt: cleanOptionalString(metadata.prompts?.startPrompt),
      endPrompt: cleanOptionalString(metadata.prompts?.endPrompt),
      videoPrompt: cleanOptionalString(metadata.prompts?.motionPrompt),
      editSourceSlug: cleanOptionalString(metadata.editSourceSlug),
      siteUrl: `/generated-sites/${slug}/index.html`,
      seo: metadata.seo || null,
      cinematicLayers,
      experienceUpgrades,
      mediaPlayback,
      editableContent,
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

  async function resolveGeneratedSiteAssetInput(userId, rawValue) {
    const value = cleanOptionalString(rawValue);
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    const match = value.match(/^\/generated-sites\/([^/]+)\/(.+)$/);
    if (!match) return value;

    const slug = match[1];
    const relativePath = `${slug}/${match[2]}`;
    const siteRecord = await findGeneratedSiteRecord(userId, slug);
    if (!siteRecord) {
      throw new Error("The selected cinematic asset does not belong to this account.");
    }
    const resolved = safeResolve(generatedDir, relativePath);
    if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error("The selected cinematic asset file was not found.");
    }
    return resolved;
  }

  async function hydrateCinematicLayersForBuild(userId, rawLayers, files = {}) {
    if (!rawLayers || typeof rawLayers !== "object") return null;

    const hydrateLayer = async (layer, fallbackLabel) => {
      if (!layer || typeof layer !== "object") {
        return {
          enabled: false,
          label: fallbackLabel,
          layout: "card",
          loopMode: "loop",
          speed: 1,
          parallax: false,
          sourceInput: null,
        };
      }

      const uploadField = cleanOptionalString(layer.uploadField);
      const uploadedFile = uploadField ? files?.[uploadField] : null;
      const sourceInput = uploadedFile?.path
        ? uploadedFile.path
        : await resolveGeneratedSiteAssetInput(userId, layer.sourceUrl || layer.sourceInput);

      return {
        enabled: Boolean(layer.enabled) && Boolean(sourceInput),
        label: cleanOptionalString(layer.label) || fallbackLabel,
        layout: String(layer.layout || "card"),
        loopMode: String(layer.loopMode || "loop"),
        speed: Number(layer.speed || 1),
        parallax: Boolean(layer.parallax),
        sourceInput,
      };
    };

    return {
      hero: await hydrateLayer(rawLayers.hero, "Hero"),
      sections: await Promise.all(
        (Array.isArray(rawLayers.sections) ? rawLayers.sections : []).map((layer, index) =>
          hydrateLayer(layer, `Section ${index + 1}`)
        )
      ),
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
      ["--site-url", options.publicSiteUrl],
      ["--start-image", options.startImage],
      ["--end-image", options.endImage],
      ["--video-path", options.videoPath],
      ["--video-url", options.videoUrl],
      ["--start-prompt", options.startPrompt],
      ["--end-prompt", options.endPrompt],
      ["--motion-prompt", options.videoPrompt],
      ["--change-request", options.changeRequest],
      ["--edit-source-slug", options.editSourceSlug],
      ["--content-overrides", options.contentOverrides ? JSON.stringify(options.contentOverrides) : null],
      ["--cinematic-layers", options.cinematicLayers ? JSON.stringify(options.cinematicLayers) : null],
      ["--experience-upgrades", options.experienceUpgrades ? JSON.stringify(options.experienceUpgrades) : null],
      ["--media-playback", options.mediaPlayback ? JSON.stringify(options.mediaPlayback) : null],
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
        const publicSiteUrl = cleanOptionalString(body.fields.siteUrl);
        const uploadedStartImage = pickExactUploadedFile(body.files, "startImage", isUploadedImage) || cleanOptionalString(body.fields.startImage);
        const uploadedEndImage = pickExactUploadedFile(body.files, "endImage", isUploadedImage) || cleanOptionalString(body.fields.endImage);
        const uploadedVideo = pickExactUploadedFile(body.files, "video", isUploadedVideo) || cleanOptionalString(body.fields.video);
        const startPrompt = cleanOptionalString(body.fields.startPrompt);
        const endPrompt = cleanOptionalString(body.fields.endPrompt);
        const videoPrompt = cleanOptionalString(body.fields.videoPrompt);
        const changeRequest = cleanOptionalString(body.fields.changeRequest);
        const editSourceSlug = cleanOptionalString(body.fields.editSourceSlug);
        const contentOverrides = cleanOptionalString(body.fields.contentOverrides)
          ? JSON.parse(String(body.fields.contentOverrides))
          : null;
        const rawCinematicLayers = cleanOptionalString(body.fields.cinematicLayers)
          ? JSON.parse(String(body.fields.cinematicLayers))
          : null;
        const experienceUpgrades = cleanOptionalString(body.fields.experienceUpgrades)
          ? JSON.parse(String(body.fields.experienceUpgrades))
          : null;
        const mediaPlayback = cleanOptionalString(body.fields.mediaPlayback)
          ? normalizeMediaPlayback(JSON.parse(String(body.fields.mediaPlayback)))
          : normalizeMediaPlayback(null);
        const colors = parseColorList(body.fields.colors);
        if (editSourceSlug) {
          const editableSite = await findGeneratedSiteRecord(session.user.id, editSourceSlug);
          if (!editableSite) {
            sendJson(response, 404, { error: "The selected source site does not exist for this account." });
            return;
          }
        }

        const existingMedia = editSourceSlug
          ? resolveEditSourceMedia(editSourceSlug)
          : null;
        const cinematicLayers = await hydrateCinematicLayersForBuild(session.user.id, rawCinematicLayers, body.files);
        const hasReplacementVideo = Boolean(uploadedVideo);
        const startImage = uploadedStartImage || (!hasReplacementVideo ? existingMedia?.startImage : null) || null;
        const endImage = uploadedEndImage || (!hasReplacementVideo ? existingMedia?.endImage : null) || null;
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
          publicSiteUrl,
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
          contentOverrides,
          cinematicLayers,
          experienceUpgrades,
          mediaPlayback,
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

    if (
      request.method === "POST" &&
      pathname.startsWith("/api/sites/") &&
      pathname.endsWith("/preview")
    ) {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const slug = pathname.split("/").slice(-2, -1)[0];
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

        const contentType = String(request.headers["content-type"] || "");
        const body = contentType.includes("multipart/form-data")
          ? await parseMultipartBody(request)
          : { fields: await parseJsonBody(request), files: {} };
        const siteConfig = getSiteConfig(slug);
        if (!siteConfig) {
          sendJson(response, 404, { error: "Generated site files not found." });
          return;
        }

        const publicSiteUrl = cleanOptionalString(body.fields.siteUrl ?? siteConfig.publicSiteUrl);
        const uploadedStartImage = pickExactUploadedFile(body.files, "startImage", isUploadedImage) || cleanOptionalString(body.fields.startImage);
        const uploadedEndImage = pickExactUploadedFile(body.files, "endImage", isUploadedImage) || cleanOptionalString(body.fields.endImage);
        const uploadedVideo = pickExactUploadedFile(body.files, "video", isUploadedVideo) || cleanOptionalString(body.fields.video);
        const startPrompt = cleanOptionalString(body.fields.startPrompt ?? siteConfig.startPrompt);
        const endPrompt = cleanOptionalString(body.fields.endPrompt ?? siteConfig.endPrompt);
        const videoPrompt = cleanOptionalString(body.fields.videoPrompt ?? siteConfig.videoPrompt);
        const contentOverrides = cleanOptionalString(body.fields.contentOverrides)
          ? JSON.parse(String(body.fields.contentOverrides))
          : siteConfig.editableContent;
        const rawCinematicLayers = cleanOptionalString(body.fields.cinematicLayers)
          ? JSON.parse(String(body.fields.cinematicLayers))
          : siteConfig.cinematicLayers;
        const experienceUpgrades = cleanOptionalString(body.fields.experienceUpgrades)
          ? JSON.parse(String(body.fields.experienceUpgrades))
          : siteConfig.experienceUpgrades;
        const mediaPlayback = cleanOptionalString(body.fields.mediaPlayback)
          ? normalizeMediaPlayback(JSON.parse(String(body.fields.mediaPlayback)))
          : normalizeMediaPlayback(siteConfig.mediaPlayback);
        const previewRoot = body.uploadDir || mkdtempSync(join(tmpdir(), "ultimateweb-preview-"));
        const hasDraftMediaUploads = Boolean(uploadedStartImage || uploadedEndImage || uploadedVideo);
        logBackend(
          `POST /api/sites/${slug}/preview user=${session.user.id} ` +
          `draftMedia=${hasDraftMediaUploads} files=${JSON.stringify({
            keys: Object.keys(body.files || {}),
            startImage: body.files.startImage?.filename || null,
            endImage: body.files.endImage?.filename || null,
            video: body.files.video?.filename || null,
          })}`
        );

        if (hasDraftMediaUploads) {
          const previewSiteDir = await runDraftPreviewBuild({
            userId: session.user.id,
            sourceSlug: slug,
            previewRoot,
            siteConfig,
            contentOverrides,
            rawCinematicLayers,
            experienceUpgrades,
            mediaPlayback,
            files: body.files,
            startPrompt,
            endPrompt,
            videoPrompt,
            publicSiteUrl,
          });
          const previewId = registerDraftPreview(session.user.id, previewRoot, previewSiteDir);
          sendJson(response, 200, {
            previewId,
            previewUrl: `/draft-previews/${previewId}/index.html`,
          });
          return;
        }

        const previewId = randomUUID();
        const cinematicLayers = await resolvePreviewCinematicLayers(session.user.id, rawCinematicLayers, body.files, previewId);
        const previewHtml = renderDraftPreviewHtml(slug, {
          title: String(contentOverrides?.hero?.title || siteConfig.title || "").trim(),
          publicSiteUrl,
          editableContent: contentOverrides,
          cinematicLayers,
          experienceUpgrades,
          mediaPlayback,
        });
        draftPreviews.set(previewId, {
          userId: session.user.id,
          rootDir: previewRoot,
          siteDir: join(generatedDir, slug),
          html: previewHtml,
          files: body.files || {},
          expiresAt: Date.now() + DRAFT_PREVIEW_TTL_MS,
        });
        cleanupExpiredDraftPreviews();
        sendJson(response, 200, {
          previewId,
          previewUrl: `/draft-previews/${previewId}/index.html`,
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
        await markGeneratedSiteDeleted(session.user.id, slug);
        logBackend(
          `Deleted generated site user=${session.user.id} slug=${slug} filesRemoved=${deleted ? "yes" : "no"}`
        );
        sendJson(response, 200, { ok: true, slug, filesRemoved: deleted });
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

    if (pathname.startsWith("/draft-previews/")) {
      const session = await requireAuthenticatedSession(request, response);
      if (!session) return;

      const relativePath = pathname.replace(/^\/draft-previews\//, "");
      const [previewId, ...rest] = relativePath.split("/");
      if (!previewId) {
        sendText(response, 404, "Not found");
        return;
      }

      const preview = resolveDraftPreview(previewId);
      if (!preview || preview.userId !== session.user.id) {
        sendText(response, 404, "Not found");
        return;
      }

      const requestedPath = rest.length ? rest.join("/") : "index.html";
      if (requestedPath === "index.html" || !requestedPath) {
        if (preview.html) {
          sendHtml(response, 200, preview.html);
          return;
        }
        serveFile(response, join(preview.siteDir, "index.html"));
        return;
      }
      if (requestedPath.startsWith("assets/")) {
        const assetName = decodeURIComponent(requestedPath.replace(/^assets\//, ""));
        const matchingFile = Object.values(preview.files || {}).find((file) => basename(file?.path || "") === assetName);
        if (!matchingFile?.path) {
          sendText(response, 404, "Not found");
          return;
        }
        serveFile(response, matchingFile.path);
        return;
      }
      const resolvedFile = safeResolve(preview.siteDir, requestedPath);
      if (!resolvedFile) {
        sendText(response, 403, "Forbidden");
        return;
      }
      serveFile(response, resolvedFile);
      return;
    }

    if (pathname === "/favicon.ico") {
      serveFavicon(response, publicDir);
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
