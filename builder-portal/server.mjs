#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(APP_DIR, "..");
const PUBLIC_DIR = existsSync(join(APP_DIR, "public"))
  ? join(APP_DIR, "public")
  : join(ROOT_DIR, "frontend");
const GENERATED_DIR = join(ROOT_DIR, "generated-sites");
const PIPELINE_SCRIPT = join(
  ROOT_DIR,
  "skills",
  "fal-futuristic-website-builder",
  "scripts",
  "build_futuristic_site.mjs"
);

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

loadEnvFromDotenv(join(ROOT_DIR, ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const jobs = new Map();
const PAGE_MODES = new Set(["conversion", "editorial", "hybrid"]);

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

mkdirSync(GENERATED_DIR, { recursive: true });

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

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
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
      } catch (error) {
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

function getGalleryEntries(limit = 80) {
  const entries = [];
  const dirents = readdirSync(GENERATED_DIR, { withFileTypes: true });

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    const siteRoot = join(GENERATED_DIR, slug);
    const indexPath = join(siteRoot, "index.html");
    if (!existsSync(indexPath)) continue;

    const metadataPath = join(siteRoot, "pipeline-metadata.json");
    const metadata = readJsonFile(metadataPath) || {};
    const title = String(metadata.topic || slug.replace(/-/g, " ")).trim();

    const thumbCandidates = [
      "start-frame.png",
      "start-frame.jpg",
      "start-frame.jpeg",
      "end-frame.png",
      "end-frame.jpg",
      "end-frame.jpeg",
    ];

    let thumbnailUrl = null;
    for (const fileName of thumbCandidates) {
      if (existsSync(join(siteRoot, "media", fileName))) {
        thumbnailUrl = `/generated-sites/${slug}/media/${fileName}`;
        break;
      }
    }

    const createdAt =
      metadata.generatedAt ||
      (existsSync(metadataPath)
        ? statSync(metadataPath).mtime.toISOString()
        : statSync(siteRoot).mtime.toISOString());

    entries.push({
      slug,
      title,
      createdAt,
      siteUrl: `/generated-sites/${slug}/index.html`,
      thumbnailUrl,
    });
  }

  return entries
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

function startBuildJob(topic, pageMode = "conversion", options = {}) {
  const id = randomUUID();
  const slug = `${slugify(topic)}-${Date.now().toString(36)}`;
  const job = {
    id,
    topic,
    pageMode,
    slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    siteUrl: null,
    thumbnailUrl: null,
    metadataUrl: null,
    error: null,
  };

  const args = [
    PIPELINE_SCRIPT,
    "--topic",
    topic,
    "--slug",
    slug,
    "--out-dir",
    GENERATED_DIR,
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
  ];

  for (const [flag, value] of optionalArgs) {
    if (!value) continue;
    args.push(flag, value);
  }

  for (const color of options.colors || []) {
    args.push("--color", color);
  }

  const child = spawn("node", args, {
    cwd: ROOT_DIR,
    env: { ...process.env, FAL_KEY: process.env.FAL_KEY || "" },
  });

  job.status = "running";
  jobs.set(id, job);

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
  });

  child.on("close", (code) => {
    if (code === 0) {
      job.status = "completed";
      job.siteUrl = `/generated-sites/${slug}/index.html`;
      job.thumbnailUrl = `/generated-sites/${slug}/media/start-frame.png`;
      job.metadataUrl = `/generated-sites/${slug}/pipeline-metadata.json`;
    } else {
      job.status = "failed";
      job.error = job.logs[job.logs.length - 1] || `Pipeline exited with code ${code}`;
    }
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  if (request.method === "POST" && pathname === "/api/build") {
    try {
      const contentType = String(request.headers["content-type"] || "");
      const body = contentType.includes("multipart/form-data")
        ? await parseMultipartBody(request)
        : { fields: await parseJsonBody(request), files: {} };
      const topic = String(body.fields.topic || "").trim();
      const pageMode = normalizePageMode(body.fields.pageMode);
      const existingWebsite = cleanOptionalString(body.fields.existingWebsite);
      const startImage = body.files.startImage?.path || cleanOptionalString(body.fields.startImage);
      const endImage = body.files.endImage?.path || cleanOptionalString(body.fields.endImage);
      const video = body.files.video?.path || cleanOptionalString(body.fields.video);
      const startPrompt = cleanOptionalString(body.fields.startPrompt);
      const endPrompt = cleanOptionalString(body.fields.endPrompt);
      const videoPrompt = cleanOptionalString(body.fields.videoPrompt);
      const colors = parseColorList(body.fields.colors);
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
        existingWebsite,
        colors,
        startImage,
        endImage,
        videoPath: video && !isVideoUrl ? video : null,
        videoUrl: isVideoUrl ? video : null,
        startPrompt,
        endPrompt,
        videoPrompt,
      });
      sendJson(response, 202, {
        id: job.id,
        slug: job.slug,
        status: job.status,
        pageMode: job.pageMode,
      });
      return;
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }

  if (request.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const id = pathname.split("/").pop();
    const job = id ? jobs.get(id) : null;
    if (!job) {
      sendJson(response, 404, { error: "Job not found." });
      return;
    }
    sendJson(response, 200, job);
    return;
  }

  if (request.method === "GET" && pathname === "/api/jobs") {
    const summaries = Array.from(jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
    sendJson(response, 200, summaries);
    return;
  }

  if (request.method === "GET" && pathname === "/api/gallery") {
    sendJson(response, 200, getGalleryEntries());
    return;
  }

  if (pathname.startsWith("/generated-sites/")) {
    const relativePath = pathname.replace(/^\/generated-sites\//, "");
    const resolved = safeResolve(GENERATED_DIR, relativePath);
    if (!resolved) {
      sendText(response, 403, "Forbidden");
      return;
    }
    serveFile(response, resolved);
    return;
  }

  const publicPath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPublic = safeResolve(PUBLIC_DIR, publicPath);
  if (!resolvedPublic) {
    sendText(response, 403, "Forbidden");
    return;
  }
  serveFile(response, resolvedPublic);
});

server.listen(PORT, HOST, () => {
  console.log(`Builder portal running on http://${HOST}:${PORT}`);
  console.log("FAL_KEY is read from .env at project root (or from environment variable).");
});
