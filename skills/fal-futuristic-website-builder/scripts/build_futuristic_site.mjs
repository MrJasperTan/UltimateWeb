#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { URL, fileURLToPath } from "node:url";

const DEFAULT_START_MODEL = "fal-ai/nano-banana-2";
const DEFAULT_END_MODEL = "fal-ai/nano-banana-2/edit";
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";
const FAL_BASE_URL = "https://queue.fal.run";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "../../..");
const PAGE_MODES = new Set(["conversion", "editorial", "hybrid"]);

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

function printUsage() {
  console.log(`Usage:
  node build_futuristic_site.mjs --topic "2025 Corvette Stingray" [options]

Required:
  --topic            Product/topic for the website

Optional:
  --out-dir          Parent output directory (default: generated-sites)
  --slug             Output folder slug (default: derived from topic)
  --brand            Brand label used in the page copy
  --site-url         Public canonical URL for the generated page
  --source-url       Existing website URL used for reference context
  --color            Palette override color; repeat flag for multiple values
  --start-image      Existing start image URL or local path
  --end-image        Existing end image URL or local path
  --video-path       Existing video path; skips fal media generation
  --video-url        Existing video URL; skips fal media generation
  --change-request   Plain-language edit request applied to generated prompts
  --edit-source-slug Source site slug when creating a new version
  --cinematic-layers JSON string with hero/section video layer settings
  --experience-upgrades JSON string with guided scroll, audio, and depth settings
  --start-prompt     Override first-frame prompt
  --end-prompt       Override last-frame prompt
  --motion-prompt    Override video motion prompt
  --content-overrides JSON string with exact editable copy overrides
  --start-model      Override start image model
  --end-model        Override end image model
  --video-model      Override video model
  --duration         Video duration seconds (default: 5)
  --page-mode        Site mode: conversion, editorial, or hybrid (default: conversion)
  --searxng-url      SearXNG instance URL for topic research (default: http://192.168.0.166:8888)
  --no-research      Skip topic research step
  --qa               Run Playwright screenshot QA after scaffolding
  --help             Show this help
`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    if (key === "color") {
      if (!Array.isArray(options[key])) options[key] = [];
      options[key].push(next);
    } else {
      options[key] = next;
    }
    i += 1;
  }
  return options;
}

function normalizePageMode(rawMode) {
  const mode = String(rawMode || "conversion").trim().toLowerCase();
  if (!PAGE_MODES.has(mode)) {
    throw new Error(`Invalid --page-mode "${rawMode}". Expected one of: conversion, editorial, hybrid.`);
  }
  return mode;
}

function normalizeExperienceUpgrades(rawValue) {
  const raw = rawValue && typeof rawValue === "object" ? rawValue : {};
  const guided = raw.guidedScroll && typeof raw.guidedScroll === "object" ? raw.guidedScroll : {};
  const audio = raw.audio && typeof raw.audio === "object" ? raw.audio : {};
  const depth = raw.depthHero && typeof raw.depthHero === "object" ? raw.depthHero : {};

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

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseFrameRate(raw) {
  if (!raw) return 24;
  if (!raw.includes("/")) return Number(raw);
  const [num, den] = raw.split("/").map(Number);
  if (!num || !den) return 24;
  return num / den;
}

function normalizeVideoDuration(seconds) {
  // Kling v3 pro i2v supports 5s and 10s.
  if (seconds >= 8) return "10";
  return "5";
}

function extractSourceUrls(value) {
  return Array.from(String(value || "").matchAll(/https?:\/\/[^\s,)]+/gi), (match) => match[0]);
}

function stripSourceUrls(value) {
  return normalizeWhitespace(String(value || "").replace(/https?:\/\/[^\s,)]+/gi, " "));
}

function sanitizeTopic(value) {
  return normalizeWhitespace(
    stripSourceUrls(value)
      .replace(/[|]+/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/,\s*$/, "")
      .replace(/\s{2,}/g, " ")
  );
}

function parseTopicInput(rawTopic) {
  const sourceUrls = extractSourceUrls(rawTopic);
  const sourceUrl = sourceUrls[0] || null;
  const topic = sanitizeTopic(rawTopic);
  return { rawTopic: String(rawTopic || ""), topic, sourceUrl };
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
  );
}

function deriveBrandLabel(topic) {
  const cleanTopic = sanitizeTopic(topic);
  const beforeLocation = cleanTopic.split(/\s+(?:in|at|near)\s+/i)[0]?.trim();
  const withoutDescriptors = beforeLocation
    ?.replace(/\b(restaurant|bar|pub|cafe|café|bistro|grill|brewery|brewpub|tavern|lounge|steakhouse|hotel|resort)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return withoutDescriptors || beforeLocation || cleanTopic;
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanOptionalString(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizePaletteOverride(rawColors) {
  const input = Array.isArray(rawColors) ? rawColors : [rawColors];
  return Array.from(
    new Set(
      input
        .flatMap((value) => String(value || "").split(/[,\n]+/))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, 6);
}

function applyChangeRequest(prompt, changeRequest) {
  const request = cleanOptionalString(changeRequest);
  if (!request) return prompt;
  return `${String(prompt).trim()} Revision request: ${request}. Preserve overall quality and coherence.`;
}

function toAbsoluteUrl(baseUrl, maybeRelative) {
  if (!baseUrl || !maybeRelative) return null;
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return null;
  }
}

function tokenizeText(value) {
  return Array.from(
    new Set(
      normalizeWhitespace(value)
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((token) => token.length >= 3)
    )
  );
}

function summarizePalette(colors) {
  if (!colors || colors.length === 0) return null;
  return colors.slice(0, 3).join(", ");
}

function pickLogoCandidate(imageUrls) {
  return (imageUrls || []).find((url) => /logo|brand|mark|icon/i.test(url)) || imageUrls?.[0] || null;
}

function detectCategory(rawTopic) {
  const topic = sanitizeTopic(rawTopic);
  if (/(corvette|stingray|car|supercar|vehicle|sedan|truck|automotive|auto|tesla|porsche|ferrari|lamborghini|bmw|mercedes|mustang|camaro|mclaren|bugatti|aston\s*martin)/i.test(topic)) {
    return "car";
  }
  if (/\b(restaurant|bar|pub|irish pub|tavern|brewery|brewpub|drinkery|cafe|café|coffee|bistro|grill|steakhouse|eatery|kitchen|lounge|hotel|resort|inn|club|saloon|menu|drinks|specials|catering|reservations?|happy hour)\b/i.test(topic)) {
    return "venue";
  }
  if (/(city|town|village|country|island|mountain|lake|river|park|monument|landmark|tower|bridge|canyon|beach|resort|temple|palace|cathedral|museum|airport|harbor|port|district|borough|prefecture|province|state of|tokyo|kyoto|osaka|paris|london|new york|los angeles|dubai|rome|venice|barcelona|amsterdam|berlin|sydney|singapore|hong kong|bangkok|istanbul|cairo|mumbai|delhi|beijing|shanghai|seattle|chicago|miami|las vegas|san francisco|hawaii|bali|maldives|santorini|machu picchu|grand canyon|niagara|yellowstone|yosemite|everest|kilimanjaro|alps|sahara|amazon|patagonia|japan|france|italy|spain|germany|australia|brazil|mexico|india|china|egypt|greece|thailand|vietnam|morocco|peru|argentina|colombia|portugal|turkey|iceland|norway|switzerland|austria|croatia|czech|ireland|scotland|england|canada|alaska|africa|europe|asia|antarctica|\b[A-Z]{2}\b)/i.test(topic)) {
    return "place";
  }
  if (/(dr\.?|mr\.?|mrs\.?|ms\.?|president|ceo|chef|coach|captain|king|queen|prince|princess|saint|st\.)/i.test(topic)) {
    return "person";
  }
  const words = topic.trim().split(/\s+/);
  const allCapitalized = words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Z]/.test(word));
  const noProductWords = !/\d{4}|edition|pro|max|ultra|plus|series|model|version|gen\b/i.test(topic);
  if (allCapitalized && noProductWords) {
    return "person";
  }
  return "generic";
}

function ensureBinary(binary) {
  const check = spawnSync(binary, ["-version"], { stdio: "ignore" });
  if (check.status !== 0) {
    throw new Error(`${binary} is required but not available on PATH.`);
  }
}

function readVideoMetadata(videoPath) {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", videoPath],
    { encoding: "utf-8" }
  );
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed: ${probe.stderr || "unknown error"}`);
  }

  const parsed = JSON.parse(probe.stdout);
  const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === "video");
  if (!videoStream) {
    throw new Error("No video stream found in generated video.");
  }

  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);
  const duration = Number(parsed.format?.duration || videoStream.duration || 0);
  const fps = parseFrameRate(videoStream.r_frame_rate);
  return { width, height, duration, fps };
}

function chooseExtractionSettings(meta) {
  const duration = meta.duration || 8;
  let fps = 12;
  if (duration < 10) fps = Math.min(20, Math.max(10, Math.round(meta.fps || 12)));
  else if (duration >= 30) fps = 8;

  const width = Math.max(1280, Math.min(1920, meta.width || 1600));
  return { fps, width };
}

function extractVideoFrame(videoPath, outputPath, seekSeconds = null) {
  const args = ["-y"];
  if (typeof seekSeconds === "number" && Number.isFinite(seekSeconds) && seekSeconds > 0) {
    args.push("-ss", seekSeconds.toFixed(3));
  }
  args.push(
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "82",
    "-compression_level",
    "6",
    outputPath
  );
  const ffmpeg = spawnSync("ffmpeg", args, { stdio: "pipe", encoding: "utf-8" });
  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg frame capture failed: ${ffmpeg.stderr || "unknown error"}`);
  }
}

function extractVideoEdgeFrames(videoPath, startPath = null, endPath = null) {
  const meta = readVideoMetadata(videoPath);
  if (startPath) {
    extractVideoFrame(videoPath, startPath, 0);
  }
  if (endPath) {
    const endTime = Math.max((meta.duration || 0) - 0.1, 0);
    extractVideoFrame(videoPath, endPath, endTime);
  }
}

function extractPayload(raw) {
  if (raw?.data && typeof raw.data === "object") return raw.data;
  if (raw?.output && typeof raw.output === "object") return raw.output;
  if (raw?.result && typeof raw.result === "object") return raw.result;
  return raw;
}

function pickImageUrl(raw) {
  const payload = extractPayload(raw);
  if (payload?.images?.[0]?.url) return payload.images[0].url;
  if (payload?.image?.url) return payload.image.url;
  if (payload?.url && typeof payload.url === "string") return payload.url;
  throw new Error(`Could not find image URL in model response: ${JSON.stringify(payload).slice(0, 400)}`);
}

function pickVideoUrl(raw) {
  const payload = extractPayload(raw);
  if (payload?.video?.url) return payload.video.url;
  if (payload?.videos?.[0]?.url) return payload.videos[0].url;
  if (payload?.video_url && typeof payload.video_url === "string") return payload.video_url;
  if (payload?.url && typeof payload.url === "string") return payload.url;
  throw new Error(`Could not find video URL in model response: ${JSON.stringify(payload).slice(0, 400)}`);
}

async function falPost(path, body, falKey) {
  const response = await fetch(`${FAL_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`fal request failed (${response.status}): ${text.slice(0, 600)}`);
  }
  return response.json();
}

async function falGet(url, falKey) {
  const response = await fetch(url, {
    headers: { Authorization: `Key ${falKey}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`fal polling failed (${response.status}): ${text.slice(0, 600)}`);
  }
  return response.json();
}

function shouldTryRawBody(errorMessage) {
  return (
    typeof errorMessage === "string" &&
    errorMessage.includes("\"loc\":[\"body\",\"prompt\"]") &&
    errorMessage.includes("\"input\"")
  );
}

async function runFalModel(modelId, input, falKey) {
  let submitted;
  try {
    submitted = await falPost(modelId, input, falKey);
  } catch (error) {
    if (shouldTryRawBody(error.message)) {
      submitted = await falPost(modelId, { input }, falKey);
    } else {
      throw error;
    }
  }
  const requestId = submitted.request_id;
  const statusUrl =
    submitted.status_url || `${FAL_BASE_URL}/${modelId}/requests/${requestId}/status`;
  const responseUrl =
    submitted.response_url || `${FAL_BASE_URL}/${modelId}/requests/${requestId}`;

  const timeoutMs = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await falGet(statusUrl, falKey);
    const state = String(status.status || "").toUpperCase();

    if (state === "COMPLETED") {
      if (status.response && typeof status.response === "object") {
        return extractPayload(status.response);
      }
      const resultUrl = status.response_url || responseUrl;
      const result = await falGet(resultUrl, falKey);
      return extractPayload(result);
    }

    if (state === "FAILED") {
      throw new Error(`fal job failed for ${modelId}: ${JSON.stringify(status).slice(0, 600)}`);
    }

    await sleep(2500);
  }

  throw new Error(`fal job timed out for ${modelId}`);
}

async function runFalWithInputVariants(modelId, inputVariants, falKey, label) {
  let lastError = null;
  for (let i = 0; i < inputVariants.length; i += 1) {
    try {
      return await runFalModel(modelId, inputVariants[i], falKey);
    } catch (error) {
      lastError = error;
      const attempt = i + 1;
      console.warn(`${label} variant ${attempt} failed: ${error.message}`);
    }
  }
  throw lastError || new Error(`All input variants failed for ${label}.`);
}

async function downloadToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Download failed (${response.status}): ${text.slice(0, 400)}`);
  }
  if (!response.body) {
    throw new Error("Download response did not include a body stream.");
  }
  const fileStream = createWriteStream(outputPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);
}

async function copyLocalFileToOutput(inputPath, outputPath) {
  const sourcePath = resolve(String(inputPath));
  if (!existsSync(sourcePath)) {
    throw new Error(`Local asset not found: ${sourcePath}`);
  }
  writeFileSync(outputPath, readFileSync(sourcePath));
  return sourcePath;
}

function convertImageToWebp(inputPath, outputPath) {
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "82",
      "-compression_level",
      "6",
      outputPath,
    ],
    { stdio: "pipe", encoding: "utf-8" }
  );
  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg image conversion failed: ${ffmpeg.stderr || "unknown error"}`);
  }
}

async function materializeAsset(inputValue, outputPath) {
  const value = cleanOptionalString(inputValue);
  if (!value) return null;
  if (isValidHttpUrl(value)) {
    await downloadToFile(value, outputPath);
    return value;
  }
  return copyLocalFileToOutput(value, outputPath);
}

async function materializeImageAsset(inputValue, outputPath) {
  const tempPath = `${outputPath}.source`;
  const source = await materializeAsset(inputValue, tempPath);
  if (!source) return null;
  convertImageToWebp(tempPath, outputPath);
  rmSync(tempPath, { force: true });
  return source;
}

function normalizeCinematicLayout(value) {
  const layout = String(value || "card").trim().toLowerCase();
  if (layout === "full-background" || layout === "background") return "full-background";
  return "card";
}

function normalizeLoopMode(value) {
  const mode = String(value || "loop").trim().toLowerCase();
  return mode === "boomerang" ? "boomerang" : "loop";
}

function normalizePlaybackSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return 1;
  return Math.min(2.5, Math.max(0.25, Number(speed.toFixed(2))));
}

function guessVideoExtension(value) {
  const raw = String(value || "");
  try {
    const parsed = isValidHttpUrl(raw) ? new URL(raw) : null;
    const ext = extname(parsed ? parsed.pathname : raw).toLowerCase();
    if (ext && /\.(mp4|mov|webm|m4v|ogg)$/i.test(ext)) return ext;
  } catch {
    // Ignore parse failure.
  }
  const localExt = extname(raw).toLowerCase();
  if (localExt && /\.(mp4|mov|webm|m4v|ogg)$/i.test(localExt)) return localExt;
  return ".mp4";
}

function normalizeCinematicLayer(rawLayer = {}, fallbackLabel = "") {
  const sourceInput = cleanOptionalString(rawLayer.sourceInput)
    || cleanOptionalString(rawLayer.sourceUrl)
    || cleanOptionalString(rawLayer.url);
  return {
    enabled: Boolean(rawLayer.enabled) && Boolean(sourceInput),
    label: cleanOptionalString(rawLayer.label) || fallbackLabel,
    layout: normalizeCinematicLayout(rawLayer.layout),
    loopMode: normalizeLoopMode(rawLayer.loopMode),
    speed: normalizePlaybackSpeed(rawLayer.speed),
    parallax: Boolean(rawLayer.parallax),
    sourceInput,
  };
}

function normalizeCinematicLayersInput(rawLayers, sectionCount = 0) {
  const source = rawLayers && typeof rawLayers === "object" ? rawLayers : {};
  return {
    hero: normalizeCinematicLayer(source.hero, "Hero"),
    sections: Array.from({ length: sectionCount }, (_, index) =>
      normalizeCinematicLayer(source.sections?.[index], `Section ${index + 1}`)
    ),
  };
}

async function materializeCinematicLayers(rawLayers, mediaDir, sectionCount = 0) {
  const normalized = normalizeCinematicLayersInput(rawLayers, sectionCount);

  const materializeLayer = async (layer, filenameBase) => {
    if (!layer.enabled || !layer.sourceInput) {
      return {
        enabled: false,
        label: layer.label,
        layout: layer.layout,
        loopMode: layer.loopMode,
        speed: layer.speed,
        parallax: layer.parallax,
        video: { available: false, filename: null, url: null },
      };
    }

    const extension = guessVideoExtension(layer.sourceInput);
    const filename = `${filenameBase}${extension}`;
    const outputPath = join(mediaDir, filename);
    await materializeAsset(layer.sourceInput, outputPath);
    return {
      enabled: true,
      label: layer.label,
      layout: layer.layout,
      loopMode: layer.loopMode,
      speed: layer.speed,
      parallax: layer.parallax,
      video: {
        available: true,
        filename,
        url: `media/${filename}`,
      },
    };
  };

  return {
    hero: await materializeLayer(normalized.hero, "cinematic-hero"),
    sections: await Promise.all(
      normalized.sections.map((layer, index) => materializeLayer(layer, `cinematic-section-${index + 1}`))
    ),
  };
}

async function downloadImageAsWebp(url, outputPath) {
  const tempPath = `${outputPath}.source`;
  await downloadToFile(url, tempPath);
  convertImageToWebp(tempPath, outputPath);
  rmSync(tempPath, { force: true });
}

function imagePathToDataUri(imagePath) {
  const ext = extname(String(imagePath)).toLowerCase();
  const mimeType = ext === ".webp"
    ? "image/webp"
    : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : "image/png";
  const buffer = readFileSync(imagePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEFAULT_SEARXNG_URL = "http://192.168.0.166:8888";

function extractMetaContent(html, selectors) {
  for (const selector of selectors) {
    const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${selector}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(match[1]);
  }
  return null;
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

function extractCssColors(html) {
  const colors = Array.from(new Set(Array.from(html.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi), (match) => match[0].toLowerCase())));
  return colors.filter((color) => !/^#(?:fff(?:fff)?|000(?:000)?)$/i.test(color)).slice(0, 6);
}

function extractImageUrls(html, baseUrl) {
  const urls = [];
  for (const match of html.matchAll(/<(?:img|source)[^>]+(?:src|srcset)=["']([^"']+)["']/gi)) {
    const value = match[1].split(",")[0]?.trim().split(/\s+/)[0];
    const absolute = toAbsoluteUrl(baseUrl, value);
    if (absolute) urls.push(absolute);
  }
  return Array.from(new Set(urls)).slice(0, 8);
}

async function fetchSourceContext(sourceUrl) {
  if (!isValidHttpUrl(sourceUrl)) return null;
  try {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const html = await response.text();
    const title = extractHtmlTitle(html);
    const description =
      extractMetaContent(html, ["description", "og:description", "twitter:description"]);
    const themeColor = extractMetaContent(html, ["theme-color", "msapplication-TileColor"]);
    const ogImage = extractMetaContent(html, ["og:image", "twitter:image"]);
    const imageUrls = extractImageUrls(html, sourceUrl);
    const pageText = clipText(stripHtml(html), 1200);
    if (ogImage) {
      const absolute = toAbsoluteUrl(sourceUrl, ogImage);
      if (absolute && !imageUrls.includes(absolute)) imageUrls.unshift(absolute);
    }
    const palette = Array.from(new Set([themeColor, ...extractCssColors(html)].filter(Boolean))).slice(0, 4);
    return {
      url: sourceUrl,
      title,
      description,
      pageText,
      palette,
      imageUrls,
      logoUrl: pickLogoCandidate(imageUrls),
    };
  } catch {
    return null;
  }
}

function inferCategoryFromSignals(topic, sourceContext = null, research = null) {
  const categorySignals = [
    topic,
    sourceContext?.title,
    sourceContext?.description,
    sourceContext?.pageText,
    ...(research?.snippets || []).slice(0, 6),
  ]
    .filter(Boolean)
    .join(" ");

  if (/\b(restaurant|bar|pub|tavern|brewery|brewpub|drinkery|cafe|café|coffee|bistro|grill|steakhouse|eatery|kitchen|lounge|menu|drinks|specials|catering|reservations?|happy hour|cocktails|beer|wine|craft beer|parties)\b/i.test(categorySignals)) {
    return "venue";
  }
  return detectCategory(categorySignals || topic);
}

function buildBusinessProfile(topic, brand, sourceContext = null, research = null) {
  const category = inferCategoryFromSignals(topic, sourceContext, research);
  return {
    topic,
    brand,
    category,
    sourceContext,
    research,
    logoUrl: sourceContext?.logoUrl || null,
    referenceMedia: (sourceContext?.imageUrls || []).slice(0, 6),
    palette: sourceContext?.palette || [],
    locationSignal: sourceContext?.title || research?.summary || null,
  };
}

function buildResearchQueries(topic, category, sourceContext) {
  const queries = [];
  if (category === "car") {
    queries.push(`${topic} specifications performance horsepower`);
    queries.push(`${topic} review features interior`);
    queries.push(`${topic} top speed 0-60`);
  } else if (category === "person") {
    queries.push(`${topic} biography achievements`);
    queries.push(`${topic} career milestones`);
    queries.push(`${topic} facts awards`);
  } else if (category === "place") {
    queries.push(`${topic} travel highlights skyline culture`);
    queries.push(`${topic} population founded landmarks`);
    queries.push(`${topic} destination guide neighborhoods`);
  } else if (category === "venue") {
    queries.push(`${topic} menu atmosphere reviews location`);
    queries.push(`${topic} official site hours address`);
    queries.push(`${topic} neighborhood events signature drinks`);
  } else {
    queries.push(`${topic} specifications features`);
    queries.push(`${topic} review details`);
    queries.push(`${topic} facts stats`);
  }

  if (sourceContext?.url) {
    queries.unshift(`${topic} site:${new URL(sourceContext.url).hostname}`);
  }

  return queries.slice(0, 4);
}

function isLikelyIrrelevantResult(category, text) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack) return false;
  if (category === "venue") {
    return /\b(font|typeface|template|mockup|vector|creative market|download|spec enterprise)\b/i.test(haystack);
  }
  return false;
}

function isRelevantSearchResult(topic, result, sourceContext) {
  const haystack = normalizeWhitespace(`${result.title || ""} ${result.content || ""} ${result.url || ""}`).toLowerCase();
  const category = inferCategoryFromSignals(topic, sourceContext, null);
  if (isLikelyIrrelevantResult(category, haystack)) return false;
  const topicTokens = tokenizeText(topic).slice(0, 6);
  const tokenHits = topicTokens.filter((token) => haystack.includes(token)).length;
  if (tokenHits >= Math.min(2, topicTokens.length)) return true;

  const brandToken = tokenizeText(deriveBrandLabel(topic))[0];
  if (brandToken && haystack.includes(brandToken)) return true;

  if (sourceContext?.url) {
    try {
      const hostname = new URL(sourceContext.url).hostname.replace(/^www\./, "");
      if (haystack.includes(hostname)) return true;
    } catch {
      // ignore invalid source context
    }
  }

  return false;
}

async function researchTopic(topic, searxngUrl, sourceContext) {
  const category = inferCategoryFromSignals(topic, sourceContext, null);
  const queries = buildResearchQueries(topic, category, sourceContext);

  const allResults = [];
  const sources = [];

  for (const query of queries) {
    try {
      const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo,brave,startpage,wikipedia`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const results = data.results.filter((result) => isRelevantSearchResult(topic, result, sourceContext)).slice(0, 5);
        allResults.push(...results);
        for (const result of results) {
          if (!result.url) continue;
          sources.push({
            url: result.url,
            title: result.title || query,
            source: result.engine || result.engines?.[0] || "search",
          });
        }
      }
      if (data.infoboxes && data.infoboxes.length > 0) {
        for (const box of data.infoboxes) {
          allResults.push({
            title: box.infobox || "",
            content: box.content || "",
            infobox_attributes: box.attributes || [],
          });
        }
      }
    } catch {
      // Search unavailable, continue silently
    }
  }

  if (allResults.length === 0) {
    console.log("Research: no search results available, using template content.");
    return null;
  }

  console.log(`Research: gathered ${allResults.length} results across ${queries.length} queries.`);

  const research = {
    topic,
    snippets: [],
    attributes: {},
    sources: [],
  };

  for (const result of allResults) {
    if (result.content && typeof result.content === "string" && result.content.length > 20) {
      research.snippets.push(result.content.slice(0, 500));
    }
    if (result.infobox_attributes && Array.isArray(result.infobox_attributes)) {
      for (const attr of result.infobox_attributes) {
        if (attr.label && attr.value) {
          research.attributes[attr.label] = String(attr.value).slice(0, 200);
        }
      }
    }
  }

  // Deduplicate snippets
  research.snippets = [...new Set(research.snippets)].slice(0, 10);
  research.sources = dedupeSources(sources, 8);
  if (sourceContext?.description) {
    research.snippets.unshift(sourceContext.description);
  }
  research.snippets = [...new Set(research.snippets)].slice(0, 10);
  if (sourceContext?.url) {
    research.sources = dedupeSources(
      [{ url: sourceContext.url, title: sourceContext.title || topic, source: "source-site" }, ...sources],
      8
    );
  } else {
    research.sources = dedupeSources(sources, 8);
  }
  research.category = category;
  research.summary = buildResearchSummary(topic, research.snippets);
  research.facts = buildResearchFacts(research.category, research.attributes, research.snippets);
  research.proofPoints = buildProofPoints(research.category, topic, research.facts, research.snippets);
  research.faqCandidates = buildFaqCandidates(research.category, topic, research.facts);
  research.researchedFields = research.facts.map((fact) => fact.label);
  research.inferredFallbackUsed = research.sources.length === 0 || research.facts.length < 2;
  research.confidence =
    research.sources.length >= 4 && research.facts.length >= 4
      ? "high"
      : research.sources.length >= 2 || research.facts.length >= 2
        ? "medium"
        : "low";
  research.coverage = {
    snippetCount: research.snippets.length,
    attributeCount: Object.keys(research.attributes).length,
    sourceCount: research.sources.length,
    factCount: research.facts.length,
  };

  return research;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxLen) {
  const clean = normalizeWhitespace(value);
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3).trimEnd() + "...";
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function normalizePublicSiteUrl(value) {
  if (!isValidHttpUrl(value)) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    if (url.pathname.endsWith("/index.html")) {
      url.pathname = url.pathname.slice(0, -"/index.html".length) || "/";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function buildSeoTitle(topic, brand) {
  const cleanTopic = normalizeWhitespace(topic);
  const cleanBrand = normalizeWhitespace(brand);
  if (!cleanBrand) return cleanTopic;
  if (cleanTopic.toLowerCase() === cleanBrand.toLowerCase()) return cleanTopic;
  return `${cleanTopic} | ${cleanBrand}`;
}

function buildSeoDescription({ topic, profile, sourceContext, research }) {
  const candidates = [
    profile?.heroSub,
    research?.summary,
    sourceContext?.description,
    `${topic} is presented as a research-informed, premium digital experience designed for modern search and conversion.`,
  ];

  for (const candidate of candidates) {
    const clipped = clipText(candidate, 158);
    if (clipped) return clipped;
  }

  return clipText(`${topic} is presented as a premium digital experience.`, 158);
}

function buildSeoKeywords({ topic, brand, category, pageMode, research }) {
  const terms = [
    topic,
    brand,
    category,
    pageMode,
    ...(research?.facts || []).slice(0, 4).map((fact) => fact.label),
  ];
  return Array.from(new Set(terms.map((value) => normalizeWhitespace(value)).filter(Boolean))).slice(0, 10);
}

function buildCanonicalAssetUrl(siteUrl, relativePath) {
  if (!siteUrl || !relativePath) return null;
  try {
    return new URL(relativePath, siteUrl).toString();
  } catch {
    return null;
  }
}

function buildRobotsDirectives(siteUrl) {
  if (!siteUrl) return "noindex, nofollow";
  return "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
}

function buildFaviconSvg({ brand, accentColor, backgroundColor }) {
  const letter = escapeHtml((normalizeWhitespace(brand).charAt(0) || "U").toUpperCase());
  const bg = escapeHtml(backgroundColor || "#05070a");
  const accent = escapeHtml(accentColor || "#f4b14d");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="${escapeHtml(brand)} favicon">
  <rect width="96" height="96" rx="24" fill="${bg}" />
  <circle cx="48" cy="48" r="30" fill="${accent}" opacity="0.18" />
  <text x="48" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" font-weight="700" fill="#ffffff">${letter}</text>
</svg>
`;
}

function inferSchemaType(category, topic) {
  if (category === "car") return "Product";
  if (category === "person") return "Person";
  if (category === "place") return "Place";
  if (category === "venue") {
    if (/\b(bar|pub|brewery|brewpub|tavern|cocktail|lounge)\b/i.test(topic)) return "BarOrPub";
    if (/\b(cafe|café|coffee|bistro|restaurant|grill|steakhouse|kitchen|eatery)\b/i.test(topic)) return "Restaurant";
    return "LocalBusiness";
  }
  return "Organization";
}

function buildStructuredData({ topic, brand, category, siteUrl, seoTitle, seoDescription, heroImageUrl, sourceContext, research }) {
  const graph = [];
  const siteName = normalizeWhitespace(brand || topic);
  const sourceLinks = dedupeSources(research?.sources || [], 8).map((entry) => entry.url);
  const pageId = siteUrl ? `${siteUrl}#webpage` : `#webpage-${slugify(topic)}`;
  const entityId = siteUrl ? `${siteUrl}#primaryentity` : `#primaryentity-${slugify(topic)}`;
  const websiteId = siteUrl ? `${siteUrl}#website` : `#website-${slugify(topic)}`;
  const schemaType = inferSchemaType(category, topic);

  graph.push({
    "@type": "WebPage",
    "@id": pageId,
    url: siteUrl || undefined,
    name: seoTitle,
    description: seoDescription,
    isPartOf: { "@id": websiteId },
    primaryImageOfPage: heroImageUrl || undefined,
    about: { "@id": entityId },
  });

  graph.push({
    "@type": "WebSite",
    "@id": websiteId,
    url: siteUrl || undefined,
    name: siteName,
    description: seoDescription,
  });

  const entity = {
    "@type": schemaType,
    "@id": entityId,
    name: normalizeWhitespace(topic),
    description: seoDescription,
    image: heroImageUrl || undefined,
    url: siteUrl || sourceContext?.url || undefined,
    sameAs: sourceLinks.length ? sourceLinks : undefined,
  };

  if (schemaType === "Product") {
    entity.brand = {
      "@type": "Brand",
      name: siteName,
    };
  }

  if (schemaType === "Person" && sourceContext?.url) {
    entity.mainEntityOfPage = sourceContext.url;
  }

  if ((schemaType === "Restaurant" || schemaType === "BarOrPub" || schemaType === "LocalBusiness") && sourceContext?.url) {
    entity.sameAs = Array.from(new Set([sourceContext.url, ...sourceLinks])).slice(0, 8);
  }

  graph.push(entity);

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}

function writeProductionArtifacts({ siteDir, siteUrl }) {
  const hasPublicUrl = Boolean(siteUrl);
  const sitemapUrl = hasPublicUrl ? new URL("sitemap.xml", siteUrl).toString() : null;
  const pageUrl = hasPublicUrl ? siteUrl : null;

  const robotsLines = hasPublicUrl
    ? [
        "User-agent: *",
        "Allow: /",
        `Sitemap: ${sitemapUrl}`,
      ]
    : [
        "User-agent: *",
        "Disallow: /",
      ];
  writeFileSync(join(siteDir, "robots.txt"), robotsLines.join("\n") + "\n");

  if (hasPublicUrl && pageUrl) {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${pageUrl}</loc>
  </url>
</urlset>
`;
    writeFileSync(join(siteDir, "sitemap.xml"), sitemap);
  }

  return {
    hasPublicUrl,
    pageUrl,
    sitemapUrl,
    robotsPath: "robots.txt",
    sitemapPath: hasPublicUrl ? "sitemap.xml" : null,
  };
}

function dedupeLines(items, normalizeForCompare = true) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const clean = normalizeWhitespace(item);
    if (!clean) continue;
    const key = normalizeForCompare ? clean.toLowerCase().replace(/[^\w\s]/g, "") : clean;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function titleizeFactLabel(value) {
  return normalizeWhitespace(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dedupeSources(items, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const url = normalizeWhitespace(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: clipText(item.title || url, 160),
      source: clipText(item.source || "search", 80),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function scoreSnippet(topic, snippet) {
  const clean = normalizeWhitespace(snippet);
  const lower = clean.toLowerCase();
  let score = 0;
  if (lower.includes(String(topic || "").toLowerCase())) score += 3;
  if (/\b(menu|drinks|events|party|catering|craft beer|cocktail|patio|downtown|chandler)\b/i.test(clean)) score += 2;
  if (!clean.includes("...")) score += 1;
  if (clean.length >= 80 && clean.length <= 260) score += 2;
  if (/last page|official website of|creative market|tiktok|spec enterprise/i.test(clean)) score -= 4;
  return score;
}

function buildResearchSummary(topic, snippets) {
  const candidates = dedupeLines(snippets)
    .sort((a, b) => scoreSnippet(topic, b) - scoreSnippet(topic, a));
  const best = candidates[0] ? clipText(candidates[0], 320) : null;
  if (best) return best;
  return `${topic} is presented through a research-informed narrative with premium positioning and category-specific proof points.`;
}

function makeFact(label, value, type = "attribute") {
  const cleanValue = clipText(value, 180);
  if (!cleanValue) return null;
  return {
    label: titleizeFactLabel(label),
    value: cleanValue,
    type,
  };
}

function buildResearchFacts(category, attributes, snippets) {
  const facts = [];
  const pushFact = (label, value, type) => {
    const fact = makeFact(label, value, type);
    if (!fact) return;
    if (facts.some((entry) => entry.label === fact.label && entry.value === fact.value)) return;
    facts.push(fact);
  };

  for (const [label, value] of Object.entries(attributes || {})) {
    pushFact(label, value, "attribute");
  }

  const combined = normalizeWhitespace((snippets || []).join(" "));
  if (category === "car") {
    pushFact("Horsepower", extractNumber(combined, /(\d{2,4})\s*(?:hp|horsepower|bhp)/i), "metric");
    pushFact(
      "0-60 mph",
      extractNumber(combined, /(\d+\.?\d*)\s*(?:s|sec|seconds?).*?0.?(?:to|-).?60/i)
        || extractNumber(combined, /0.?(?:to|-).?60.*?(\d+\.?\d*)\s*(?:s|sec)/i),
      "metric"
    );
    pushFact(
      "Top speed",
      extractNumber(combined, /top\s*speed.*?(\d{2,3})\s*(?:mph|km)/i)
        || extractNumber(combined, /(\d{2,3})\s*(?:mph|km\/h).*?top\s*speed/i),
      "metric"
    );
  }

  if (category === "person") {
    pushFact("Born", attributes["Born"] || attributes["Date of birth"] || attributes["Birthday"], "bio");
    pushFact("Nationality", attributes["Nationality"] || attributes["Country"], "bio");
    pushFact("Occupation", attributes["Occupation"] || attributes["Known for"] || attributes["Profession"], "bio");
  }

  if (category === "place") {
    pushFact("Population", attributes["Population"] || extractNumber(combined, /population.*?(\d[\d,]+)/i), "metric");
    pushFact("Founded", attributes["Founded"] || attributes["Established"], "history");
    pushFact("Area", attributes["Area"] || attributes["Size"], "metric");
    pushFact("Elevation", attributes["Elevation"] || attributes["Altitude"], "metric");
  }
  if (category === "venue") {
    pushFact("Address", attributes["Address"] || attributes["Location"], "venue");
    pushFact("Hours", attributes["Hours"] || attributes["Opening hours"], "venue");
    pushFact("Cuisine", attributes["Cuisine"] || attributes["Specialties"], "venue");
    pushFact("Rating", extractNumber(combined, /(\d\.\d)\s*(?:\/\s*5|stars?)/i), "venue");
    pushFact("Tap count", extractNumber(combined, /(\d{1,3})\s*(?:beers?|taps?|drafts?)/i), "venue");
  }

  return facts.slice(0, 8);
}

function buildProofPoints(category, topic, facts, snippets) {
  const proofPoints = [];
  for (const fact of facts.slice(0, 4)) {
    proofPoints.push(`${fact.label}: ${fact.value}`);
  }
  for (const snippet of snippets || []) {
    const line = clipText(snippet, 140);
    if (!line || proofPoints.includes(line)) continue;
    proofPoints.push(line);
    if (proofPoints.length >= 4) break;
  }

  if (proofPoints.length > 0) return proofPoints.slice(0, 4);

  if (category === "car") {
    return [
      `${topic} is framed around measurable performance, premium design, and purchase intent.`,
      "The landing page should move from impact to proof to a clear configuration CTA.",
    ];
  }
  if (category === "person") {
    return [
      `${topic} is defined through milestones, identity, and lasting cultural impact.`,
      "The page should feel editorial first, but still guide visitors into deeper exploration.",
    ];
  }
  if (category === "place") {
    return [
      `${topic} is defined through atmosphere, geography, and signature experiences.`,
      "The page should translate inspiration into planning intent with practical highlights.",
    ];
  }
  if (category === "venue") {
    return [
      `${topic} is defined by room energy, real hospitality signals, and the feeling of being there.`,
      "The page should convert curiosity into a visit, reservation, or event-night decision.",
    ];
  }
  return [
    `${topic} is positioned as a premium modern offer with clear differentiation.`,
    "The page should convert attention into action using proof, clarity, and visual conviction.",
  ];
}

function buildFaqCandidates(category, topic, facts) {
  const faqs = facts.slice(0, 3).map((fact) => ({
    question: `What should visitors know about ${topic} ${fact.label.toLowerCase()}?`,
    answer: `${topic} ${fact.label.toLowerCase()} is surfaced through ${fact.value}, turning raw information into a usable decision signal.`,
  }));

  if (faqs.length < 3) {
    if (category === "car") {
      faqs.push(
        {
          question: `Why choose ${topic}?`,
          answer: `${topic} is positioned as a balance of emotional design, measurable performance, and premium ownership appeal.`,
        },
        {
          question: "What should the page emphasize first?",
          answer: "Lead with verified specs, then translate them into a visceral ownership story and a clear configurator CTA.",
        }
      );
    } else if (category === "person") {
      faqs.push(
        {
          question: `What makes ${topic} distinct?`,
          answer: `${topic} should be defined by measurable achievements, narrative arc, and cultural resonance rather than generic praise.`,
        },
        {
          question: "How should a visitor move through the page?",
          answer: "Start with identity, move into milestone proof, and end with a clear invitation to explore the full story.",
        }
      );
    } else if (category === "place") {
      faqs.push(
        {
          question: `Why visit ${topic}?`,
          answer: `${topic} should combine atmosphere, practical facts, and signature experiences in one coherent journey.`,
        },
        {
          question: "What should the page convert toward?",
          answer: "Convert inspiration into planning intent with concrete highlights, travel signals, and a destination-oriented CTA.",
        }
      );
    } else if (category === "venue") {
      faqs.push(
        {
          question: `Why go to ${topic}?`,
          answer: `${topic} should feel specific to its neighborhood, offer, and crowd energy instead of reading like a generic food-and-drink listing.`,
        },
        {
          question: "What should the page convert toward?",
          answer: "Move visitors toward a real visit with hours, signature highlights, social proof, and a clear plan-the-night CTA.",
        }
      );
    } else {
      faqs.push(
        {
          question: `What differentiates ${topic}?`,
          answer: `${topic} should pair a strong visual point of view with real proof points so the page feels persuasive instead of generic.`,
        },
        {
          question: "How should this landing page convert?",
          answer: "Structure the page so visitors quickly understand the offer, trust it, and move naturally into the primary call to action.",
        }
      );
    }
  }

  return faqs.slice(0, 3);
}

function extractResearchStats(research, category) {
  if (!research) return null;

  const attrs = research.attributes || {};
  const snippetText = (research.snippets || []).join(" ");

  if (category === "car") {
    const hp = extractNumber(snippetText, /(\d{2,4})\s*(?:hp|horsepower|bhp)/i) || attrs["Power"] || attrs["Horsepower"];
    const accel = extractNumber(snippetText, /(\d+\.?\d*)\s*(?:s|sec|seconds?).*?0.?(?:to|-).?60/i)
      || extractNumber(snippetText, /0.?(?:to|-).?60.*?(\d+\.?\d*)\s*(?:s|sec)/i)
      || attrs["0-60 mph"] || attrs["Acceleration"];
    const topSpeed = extractNumber(snippetText, /top\s*speed.*?(\d{2,3})\s*(?:mph|km)/i)
      || extractNumber(snippetText, /(\d{2,3})\s*(?:mph|km\/h).*?top\s*speed/i)
      || attrs["Top speed"] || attrs["Top Speed"];
    if (hp || accel || topSpeed) {
      return { hp, accel, topSpeed };
    }
  }

  if (category === "person") {
    const born = attrs["Born"] || attrs["Date of birth"] || attrs["Birthday"];
    const nationality = attrs["Nationality"] || attrs["Country"];
    const occupation = attrs["Occupation"] || attrs["Known for"] || attrs["Profession"];
    const awards = extractNumber(snippetText, /(\d+)\s*(?:awards?|titles?|championships?|medals?|grammy|oscar)/i);
    if (born || nationality || occupation || awards) {
      return { born, nationality, occupation, awards };
    }
  }

  if (category === "place") {
    const population = attrs["Population"] || extractNumber(snippetText, /population.*?(\d[\d,]+)/i);
    const elevation = attrs["Elevation"] || attrs["Altitude"];
    const founded = attrs["Founded"] || attrs["Established"];
    const area = attrs["Area"] || attrs["Size"];
    if (population || elevation || founded || area) {
      return { population, elevation, founded, area };
    }
  }
  if (category === "venue") {
    const hours = attrs["Hours"] || attrs["Opening hours"];
    const taps = extractNumber(snippetText, /(\d{1,3})\s*(?:beers?|taps?|drafts?)/i);
    const rating = extractNumber(snippetText, /(\d\.\d)\s*(?:\/\s*5|stars?)/i);
    if (hours || taps || rating) {
      return { hours, taps, rating };
    }
  }

  return null;
}

function extractNumber(text, regex) {
  const match = text.match(regex);
  return match ? match[1].replace(/,/g, "") : null;
}

function pickBestSnippet(research, maxLen) {
  if (!research || !research.snippets || research.snippets.length === 0) return null;
  const topic = research.topic || "";
  const sorted = [...dedupeLines(research.snippets)].sort((a, b) => {
    const scoreDelta = scoreSnippet(topic, b) - scoreSnippet(topic, a);
    if (scoreDelta !== 0) return scoreDelta;
    return b.length - a.length;
  });
  const best = sorted[0];
  return best.length > maxLen ? best.slice(0, maxLen) + "..." : best;
}

function generateDramaticCopy(category, topic, brand, research) {
  const bestSnippet = pickBestSnippet(research, 220);
  const introSubtext = bestSnippet || `Experience ${topic} like never before — a journey through precision, beauty, and uncompromising craft.`;

  if (category === "car") {
    return {
      tagline: "ANNIHILATE THE ROAD",
      introStatement: "We didn\u2019t design another car. We sculpted velocity into metal.",
      introSubtext,
      closingStatement: "The last machine you\u2019ll ever need.",
    };
  }
  if (category === "person") {
    return {
      tagline: "REDEFINE POSSIBLE",
      introStatement: "Some people don\u2019t follow the path. They become it.",
      introSubtext,
      closingStatement: "The standard was set. Then surpassed.",
    };
  }
  if (category === "place") {
    return {
      tagline: "DISCOVER THE UNKNOWN",
      introStatement: "Some places don\u2019t appear on maps. They appear in memories.",
      introSubtext,
      closingStatement: "Every journey ends here. Every story begins.",
    };
  }
  if (category === "venue") {
    return {
      tagline: "PULL UP AFTER DARK",
      introStatement: "A real venue needs tension, atmosphere, and a reason to walk through the door tonight.",
      introSubtext,
      closingStatement: "The room is the product. The night is the proof.",
    };
  }
  // generic
  return {
    tagline: "ENGINEERED BEYOND",
    introStatement: `We didn\u2019t build another product. We engineered a force of nature.`,
    introSubtext,
    closingStatement: "The future arrived. It just needed a name.",
  };
}

function buildFeaturesFromResearch(category, topic, research) {
  const animations = ["slide-left", "clip-reveal", "slide-right", "stagger-up"];
  const alignments = ["left", "right", "left", "right"];
  const snippets = dedupeLines((research && research.snippets) || []);

  function snip(i) {
    return (snippets[i] && snippets[i].length > 30) ? snippets[i] : null;
  }

  let templates;

  if (category === "car") {
    templates = [
      { label: "001 / Engine", heading: "Powertrain Supremacy", body: snip(0) || "Raw displacement meets digital precision \u2014 a powertrain tuned for instant throttle response across the entire rev range." },
      { label: "002 / Chassis", heading: "Suspension Architecture", body: snip(1) || "Adaptive damping, optimised geometry, and structural rigidity engineered for corner confidence and straight-line composure." },
      { label: "003 / Interior", heading: "Technology Cockpit", body: snip(2) || "Driver-focused layout with haptic controls, head-up projection, and materials that reward every touch." },
      { label: "004 / Aero", heading: "Design Language", body: snip(3) || "Every surface manages airflow \u2014 sculpted for downforce, cooled for endurance, and shaped for unmistakable presence." },
    ];
  } else if (category === "person") {
    templates = [
      { label: "001 / Origins", heading: "Where It All Began", body: snip(0) || `The formative years that forged ${topic} \u2014 raw talent colliding with relentless ambition.` },
      { label: "002 / Peak", heading: "Peak Achievement", body: snip(1) || `The moments that redefined what was possible \u2014 records shattered, boundaries dissolved.` },
      { label: "003 / Impact", heading: "Cultural Resonance", body: snip(2) || `Beyond the accolades \u2014 how ${topic} shifted the conversation and inspired a generation.` },
      { label: "004 / Philosophy", heading: "The Approach", body: snip(3) || `A singular philosophy: outwork everyone, question everything, and never accept the ceiling as permanent.` },
    ];
  } else if (category === "place") {
    templates = [
      { label: "001 / Landscape", heading: "Geography & Terrain", body: snip(0) || `The topography of ${topic} \u2014 dramatic horizons, shifting light, and terrain that humbles the traveller.` },
      { label: "002 / Culture", heading: "History & Heritage", body: snip(1) || `Centuries of tradition compressed into living streets, rituals, and the quiet pride of a place that remembers.` },
      { label: "003 / Cuisine", heading: "Flavour & Lifestyle", body: snip(2) || `Taste the locale \u2014 ingredients sourced from the land, techniques passed through generations, experiences shared around every table.` },
      { label: "004 / Architecture", heading: "Landmarks & Design", body: snip(3) || `Structures that define the skyline \u2014 from ancient stonework to contemporary glass, each building tells a story.` },
    ];
  } else if (category === "venue") {
    templates = [
      { label: "001 / Atmosphere", heading: "Room Energy", body: snip(0) || `${topic} should feel like a place with its own pulse \u2014 lighting, sound, density, and social gravity all working together.` },
      { label: "002 / Offer", heading: "What People Come For", body: snip(1) || `Build the page around the real draw: signature pours, standout dishes, events, and the reasons regulars keep returning.` },
      { label: "003 / Setting", heading: "Neighborhood Context", body: snip(2) || `The venue should feel anchored to its block and city, with local cues that make the experience unmistakably rooted in place.` },
      { label: "004 / Experience", heading: "Night-Of Momentum", body: snip(3) || `Translate the best parts of the visit into motion: arrival, first order, crowd energy, and the sense that the night is building.` },
    ];
  } else {
    templates = [
      { label: "001 / Core", heading: "Core Technology", body: snip(0) || "A foundational system engineered for reliability, speed, and effortless scalability from day one." },
      { label: "002 / Design", heading: "Design Language", body: snip(1) || "Every surface, every pixel, every interaction has been considered \u2014 nothing arbitrary, nothing wasted." },
      { label: "003 / UX", heading: "User Experience", body: snip(2) || "Intuitive at first touch, powerful at depth \u2014 an interface that disappears so the work can take centre stage." },
      { label: "004 / Performance", heading: "Performance Class", body: snip(3) || "Benchmarked against the best, tuned beyond the rest \u2014 performance that compounds over time." },
    ];
  }

  return templates.map((t, i) => ({
    ...t,
    animation: animations[i],
    alignment: alignments[i],
  }));
}

function buildTheme(category, sourceContext = null) {
  const themes = {
    car: {
      bg: "#070709",
      bgElevated: "#101218",
      text: "#f6efe8",
      muted: "#b6a99e",
      accent: "#ff5b36",
      accentSoft: "#ffd0bf",
      accentAlt: "#6ce6ff",
      heroGlow: "rgba(255, 91, 54, 0.30)",
      heroGlowAlt: "rgba(108, 230, 255, 0.18)",
      displayFont: "\"Oswald\", \"Arial Narrow\", sans-serif",
      bodyFont: "\"Manrope\", \"Segoe UI\", sans-serif",
    },
    person: {
      bg: "#0a090f",
      bgElevated: "#15121d",
      text: "#f7f1ea",
      muted: "#baaabf",
      accent: "#f4b14d",
      accentSoft: "#f6e0b7",
      accentAlt: "#f66ba2",
      heroGlow: "rgba(246, 107, 162, 0.22)",
      heroGlowAlt: "rgba(244, 177, 77, 0.20)",
      displayFont: "\"DM Serif Display\", Georgia, serif",
      bodyFont: "\"Manrope\", \"Segoe UI\", sans-serif",
    },
    place: {
      bg: "#071114",
      bgElevated: "#0e1e24",
      text: "#eef7f4",
      muted: "#a4c1bf",
      accent: "#2fe0b5",
      accentSoft: "#c4fff1",
      accentAlt: "#5ec8ff",
      heroGlow: "rgba(47, 224, 181, 0.24)",
      heroGlowAlt: "rgba(94, 200, 255, 0.18)",
      displayFont: "\"Syne\", \"Arial Narrow\", sans-serif",
      bodyFont: "\"Manrope\", \"Segoe UI\", sans-serif",
    },
    venue: {
      bg: "#120d0b",
      bgElevated: "#1b1512",
      text: "#f9f1e7",
      muted: "#cbb7a3",
      accent: "#d8893d",
      accentSoft: "#f0d1aa",
      accentAlt: "#5daaa8",
      heroGlow: "rgba(216, 137, 61, 0.26)",
      heroGlowAlt: "rgba(93, 170, 168, 0.18)",
      displayFont: "\"Oswald\", \"Arial Narrow\", sans-serif",
      bodyFont: "\"Manrope\", \"Segoe UI\", sans-serif",
    },
    generic: {
      bg: "#08090c",
      bgElevated: "#11151c",
      text: "#f2f7ff",
      muted: "#a8b7ca",
      accent: "#49c0ff",
      accentSoft: "#c9edff",
      accentAlt: "#ff8a3d",
      heroGlow: "rgba(73, 192, 255, 0.26)",
      heroGlowAlt: "rgba(255, 138, 61, 0.18)",
      displayFont: "\"Chakra Petch\", \"Arial Narrow\", sans-serif",
      bodyFont: "\"Manrope\", \"Segoe UI\", sans-serif",
    },
  };

  const theme = { ...(themes[category] || themes.generic) };
  if (sourceContext?.palette?.[0]) theme.accent = sourceContext.palette[0];
  if (sourceContext?.palette?.[1]) theme.accentAlt = sourceContext.palette[1];
  if (sourceContext?.palette?.[2]) theme.accentSoft = sourceContext.palette[2];
  return theme;
}

function formatStatValue(rawValue, fallbackValue, fallbackSuffix = "") {
  const clean = String(rawValue ?? "").replace(/,/g, "").trim();
  const matched = clean.match(/-?\d+(?:\.\d+)?/);
  if (!matched) {
    return {
      value: String(fallbackValue),
      decimals: String(String(fallbackValue).includes(".") ? 1 : 0),
      suffix: fallbackSuffix,
    };
  }

  const numeric = matched[0];
  let suffix = clean.replace(matched[0], "").trim();
  if (!suffix && fallbackSuffix) suffix = fallbackSuffix;
  return {
    value: numeric,
    decimals: String(numeric.includes(".") ? 1 : 0),
    suffix,
  };
}

function buildStatEntries(category, researchStats) {
  if (category === "car") {
    return [
      { ...formatStatValue(researchStats?.hp, 495, "hp"), label: "Peak output" },
      { ...formatStatValue(researchStats?.accel, 2.9, "s"), label: "0-60 launch" },
      { ...formatStatValue(researchStats?.topSpeed, 194, "mph"), label: "Top speed class" },
    ];
  }

  if (category === "person") {
    return [
      { ...formatStatValue(researchStats?.awards, 12, "+"), label: "Major achievements" },
      { ...formatStatValue("1", 1, "era"), label: "Defining run" },
      { ...formatStatValue("24", 24, "moments"), label: "Signature story beats" },
    ];
  }

  if (category === "place") {
    return [
      { ...formatStatValue(researchStats?.population, 1.2, "M"), label: "Population scale" },
      { ...formatStatValue(researchStats?.founded, 1868), label: "Established" },
      { ...formatStatValue("3", 3, "must-sees"), label: "Core highlights" },
    ];
  }
  if (category === "venue") {
    return [
      { ...formatStatValue(researchStats?.hours, 7, "days"), label: "Open rhythm" },
      { ...formatStatValue(researchStats?.taps, 12, "taps"), label: "Signature pours" },
      { ...formatStatValue(researchStats?.rating, 4.7, "/5"), label: "Review signal" },
    ];
  }

  return [
    { ...formatStatValue("24", 24, "mo"), label: "Roadmap horizon" },
    { ...formatStatValue("98.6", 98.6, "%"), label: "Confidence target" },
    { ...formatStatValue("6", 6, "signals"), label: "Proof layers" },
  ];
}

function buildCtaProfile(category, topic, brand, pageMode) {
  if (category === "car") {
    return {
      label: pageMode === "editorial" ? "008 / Next Frame" : "008 / Configuration",
      heading: `Configure ${brand}`,
      body: `Choose performance package, aero setup, wheel architecture, and signature finish for your ${topic}.`,
      button: pageMode === "editorial" ? "See Full Build" : "Open Configurator",
      headerCta: "Configure",
    };
  }

  if (category === "person") {
    return {
      label: "008 / Explore",
      heading: `Discover ${brand}`,
      body: `Move from headline milestones into the deeper story, philosophy, and defining moments behind ${topic}.`,
      button: "Explore Story",
      headerCta: "Discover",
    };
  }

  if (category === "place") {
    return {
      label: "008 / Journey",
      heading: `Plan ${brand}`,
      body: `Translate the atmosphere of ${topic} into a real itinerary with timing, highlights, and signature experiences.`,
      button: "Start Planning",
      headerCta: "Explore",
    };
  }
  if (category === "venue") {
    return {
      label: "008 / Tonight",
      heading: `Visit ${brand}`,
      body: `Turn interest into foot traffic with the right mood, proof, and a clear reason to show up at ${topic}.`,
      button: "Plan A Visit",
      headerCta: "Visit",
    };
  }

  return {
    label: "008 / Launch",
    heading: `Build With ${brand}`,
    body: `Turn interest into action with a sharper rollout path, clearer differentiation, and a premium first impression for ${topic}.`,
    button: "Start Project",
    headerCta: "Learn More",
  };
}

function buildCopySection(label, heading, body, alignment, animation) {
  return { kind: "copy", label, heading, body, alignment, animation };
}

function buildCardSection(label, heading, cards, alignment, animation) {
  return { kind: "cards", label, heading, cards: cards.slice(0, 4), alignment, animation };
}

function buildFaqSection(faqItems, alignment = "left", animation = "fade-up") {
  const items = faqItems && faqItems.length
    ? faqItems
    : [
        {
          question: "How should this page guide the visitor?",
          answer: "Move from impact to proof to action with a clear, premium sense of momentum.",
        },
        {
          question: "What makes the experience feel credible?",
          answer: "Real data should anchor hero and proof sections whenever available, with informed fallback copy used sparingly elsewhere.",
        },
        {
          question: "What should happen at the end of the page?",
          answer: "The final section should convert attention into the clearest next step for the topic.",
        },
      ];
  return {
    kind: "faq",
    label: "007 / Questions",
    heading: "What Visitors Need To Know",
    items: items.slice(0, 3),
    alignment,
    animation,
  };
}

function buildSections(category, topic, research, pageMode, dramatic, features, stats) {
  const proofCards = (research?.proofPoints || []).map((item, index) => ({
    title: index === 0 ? "Verified signal" : `Proof point ${String(index + 1).padStart(2, "0")}`,
    body: item,
  }));
  const factCards = (research?.facts || []).slice(0, 4).map((fact) => ({
    title: fact.label,
    body: fact.value,
  }));
  const statsCards = stats.map((stat) => ({
    title: stat.label,
    body: `${stat.value}${stat.suffix ? ` ${stat.suffix}` : ""}`,
  }));

  if (pageMode === "editorial") {
    return [
      buildCopySection("001 / Opening Frame", dramatic.introStatement, dramatic.introSubtext, "center", "fade-up"),
      buildCopySection("002 / Presence", features[0].heading, features[0].body, "left", "slide-left"),
      buildCopySection("003 / Narrative", features[1].heading, features[1].body, "right", "clip-reveal"),
      buildCardSection("004 / Proof", "Research Signals", proofCards.length ? proofCards : statsCards, "left", "stagger-up"),
      { kind: "stats", label: "005 / Metrics", heading: "Numbers That Hold Weight", stats, alignment: "center", animation: "stagger-up" },
      buildCardSection("006 / Archive", "Signature Facts", factCards.length ? factCards : statsCards, "right", "slide-right"),
      buildCopySection("007 / Legacy", dramatic.closingStatement, `The page resolves by framing ${topic} as something remembered, not merely viewed.`, "center", "fade-up"),
    ];
  }

  if (pageMode === "hybrid") {
    return [
      buildCopySection("001 / Positioning", dramatic.introStatement, dramatic.introSubtext, "center", "fade-up"),
      buildCopySection("002 / Distinction", features[0].heading, features[0].body, "left", "slide-left"),
      buildCopySection("003 / Experience", features[1].heading, features[1].body, "right", "slide-right"),
      { kind: "stats", label: "004 / Metrics", heading: "Real Signals", stats, alignment: "center", animation: "stagger-up" },
      buildCardSection("005 / Proof", "Why It Converts", proofCards.length ? proofCards : (factCards.length ? factCards : statsCards), "left", "clip-reveal"),
      buildCardSection("006 / Details", "Research Highlights", factCards.length ? factCards : statsCards, "right", "stagger-up"),
      buildFaqSection(research?.faqCandidates || [], "left", "fade-up"),
    ];
  }

  return [
    buildCopySection("001 / Hook", dramatic.introStatement, dramatic.introSubtext, "center", "fade-up"),
    buildCopySection("002 / Value", features[0].heading, features[0].body, "left", "slide-left"),
    buildCopySection("003 / Differentiation", features[1].heading, features[1].body, "right", "slide-right"),
    { kind: "stats", label: "004 / Proof", heading: "Measured Confidence", stats, alignment: "center", animation: "stagger-up" },
    buildCardSection("005 / Trust", "Research-Backed Highlights", proofCards.length ? proofCards : (factCards.length ? factCards : statsCards), "left", "clip-reveal"),
    buildCardSection("006 / Decision", "What Makes It Distinct", factCards.length ? factCards : statsCards, "right", "stagger-up"),
    buildFaqSection(research?.faqCandidates || [], "left", "fade-up"),
  ];
}

function buildContentProfile(businessProfile, pageMode) {
  const { topic, brand, research, sourceContext, category } = businessProfile;
  const researchStats = extractResearchStats(research, category);
  const bestSnippet = pickBestSnippet(research, 320);
  const dramatic = generateDramaticCopy(category, topic, brand, research);
  const features = buildFeaturesFromResearch(category, topic, research);
  const theme = buildTheme(category, sourceContext);
  const stats = buildStatEntries(category, researchStats);
  const cta = buildCtaProfile(category, topic, brand, pageMode);
  const heroSub =
    bestSnippet
    || research?.summary
    || `${topic} is presented as a cinematic, research-informed experience designed to convert attention into action.`;

  let heroKicker = "RESEARCH-LED DIGITAL LAUNCH";
  if (category === "car") heroKicker = pageMode === "editorial" ? "PERFORMANCE MONOGRAPH" : "AERODYNAMIC FUTURE PERFORMANCE";
  if (category === "person") heroKicker = pageMode === "conversion" ? "IDENTITY. PROOF. IMPACT." : "THE DEFINITIVE PORTRAIT";
  if (category === "place") heroKicker = pageMode === "conversion" ? "DESTINATION WITH INTENT" : "DESTINATION UNVEILED";
  if (category === "venue") heroKicker = pageMode === "editorial" ? "ROOM. LIGHT. SIGNAL." : "NEIGHBORHOOD NIGHTLIFE";

  return {
    category,
    pageMode,
    theme,
    heroTitle: topic,
    heroKicker,
    heroSub,
    tagline: dramatic.tagline,
    introStatement: dramatic.introStatement,
    introSubtext: dramatic.introSubtext,
    closingStatement: dramatic.closingStatement,
    stats,
    sections: buildSections(category, topic, research, pageMode, dramatic, features, stats),
    cta,
    trustLine:
      research && research.sources?.length
        ? `${research.sources.length} live sources${sourceContext?.url ? " plus the source site" : ""} informed the hero, proof, and spec sections.`
        : "Built with best-effort category research and premium design defaults.",
  };
}

function normalizeEditableCardEntry(card = {}) {
  return {
    title: String(card.title || "").trim(),
    body: String(card.body || "").trim(),
  };
}

function normalizeEditableStatEntry(stat = {}, fallback = {}) {
  return {
    value: String(stat.value ?? fallback.value ?? "").trim(),
    decimals: String(stat.decimals ?? fallback.decimals ?? "0").trim() || "0",
    suffix: String(stat.suffix ?? fallback.suffix ?? "").trim(),
    label: String(stat.label ?? fallback.label ?? "").trim(),
  };
}

function buildEditableContent(profile) {
  return {
    hero: {
      kicker: String(profile.heroKicker || "").trim(),
      title: String(profile.heroTitle || "").trim(),
      sub: String(profile.heroSub || "").trim(),
      trustLine: String(profile.trustLine || "").trim(),
    },
    marqueeText: String(profile.tagline || "").trim(),
    sections: profile.sections.map((section) => ({
      kind: section.kind,
      label: String(section.label || "").trim(),
      heading: String(section.heading || "").trim(),
      body: String(section.body || "").trim(),
      button: String(section.button || "").trim(),
      stats: Array.isArray(section.stats) ? section.stats.map((stat) => normalizeEditableStatEntry(stat)) : [],
      cards: Array.isArray(section.cards) ? section.cards.map((card) => normalizeEditableCardEntry(card)) : [],
      items: Array.isArray(section.items)
        ? section.items.map((item) => ({
            question: String(item.question || "").trim(),
            answer: String(item.answer || "").trim(),
          }))
        : [],
    })),
    cta: {
      label: String(profile.cta?.label || "").trim(),
      heading: String(profile.cta?.heading || "").trim(),
      body: String(profile.cta?.body || "").trim(),
      button: String(profile.cta?.button || "").trim(),
      headerCta: String(profile.cta?.headerCta || "").trim(),
    },
  };
}

function applyContentOverrides(profile, overrides) {
  if (!overrides || typeof overrides !== "object") return profile;

  const next = {
    ...profile,
    heroKicker: cleanOptionalString(overrides.hero?.kicker) || profile.heroKicker,
    heroTitle: cleanOptionalString(overrides.hero?.title) || profile.heroTitle,
    heroSub: cleanOptionalString(overrides.hero?.sub) || profile.heroSub,
    trustLine: cleanOptionalString(overrides.hero?.trustLine) || profile.trustLine,
    tagline: cleanOptionalString(overrides.marqueeText) || profile.tagline,
    sections: profile.sections.map((section, index) => {
      const sectionOverride = overrides.sections?.[index];
      if (!sectionOverride || typeof sectionOverride !== "object") return { ...section };
      const merged = {
        ...section,
        label: cleanOptionalString(sectionOverride.label) || section.label,
        heading: cleanOptionalString(sectionOverride.heading) || section.heading,
        body: cleanOptionalString(sectionOverride.body) || section.body,
        button: cleanOptionalString(sectionOverride.button) || section.button,
      };
      if (Array.isArray(section.stats) && Array.isArray(sectionOverride.stats)) {
        merged.stats = section.stats.map((stat, statIndex) =>
          normalizeEditableStatEntry(sectionOverride.stats[statIndex], stat)
        );
      }
      if (Array.isArray(section.cards) && Array.isArray(sectionOverride.cards)) {
        merged.cards = section.cards.map((card, cardIndex) => ({
          title: cleanOptionalString(sectionOverride.cards[cardIndex]?.title) || card.title,
          body: cleanOptionalString(sectionOverride.cards[cardIndex]?.body) || card.body,
        }));
      }
      if (Array.isArray(section.items) && Array.isArray(sectionOverride.items)) {
        merged.items = section.items.map((item, itemIndex) => ({
          question: cleanOptionalString(sectionOverride.items[itemIndex]?.question) || item.question,
          answer: cleanOptionalString(sectionOverride.items[itemIndex]?.answer) || item.answer,
        }));
      }
      return merged;
    }),
    cta: {
      ...profile.cta,
      label: cleanOptionalString(overrides.cta?.label) || profile.cta.label,
      heading: cleanOptionalString(overrides.cta?.heading) || profile.cta.heading,
      body: cleanOptionalString(overrides.cta?.body) || profile.cta.body,
      button: cleanOptionalString(overrides.cta?.button) || profile.cta.button,
      headerCta: cleanOptionalString(overrides.cta?.headerCta) || profile.cta.headerCta,
    },
  };

  return next;
}

function estimateSectionWeight(section) {
  let weight = 1;
  weight += Math.min((section.heading || "").length / 60, 1.4);
  weight += Math.min((section.body || "").length / 180, 2);
  if (section.cards?.length) {
    weight += section.cards.reduce((sum, card) => sum + Math.min(((card.title || "").length + (card.body || "").length) / 220, 0.8), 0);
  }
  if (section.items?.length) {
    weight += section.items.reduce((sum, item) => sum + Math.min(((item.question || "").length + (item.answer || "").length) / 220, 0.8), 0);
  }
  if (section.stats?.length) weight += section.stats.length * 0.25;
  if (section.kind === "cta") weight += 0.4;
  return Math.max(1, weight);
}

function buildSectionTiming(sections) {
  const start = 10;
  const end = 100;
  const total = end - start;
  const weights = sections.map((section) => estimateSectionWeight(section));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || sections.length || 1;
  let cursor = start;
  return sections.map((section, index) => {
    const remaining = end - cursor;
    const sectionsLeft = sections.length - index;
    const reservedMinimum = Math.max(0, (sectionsLeft - 1) * 6);
    const proportional = (weights[index] / weightTotal) * total;
    const span = Math.max(6, Math.min(18, proportional, remaining - reservedMinimum));
    const timing = {
      enter: Number(cursor.toFixed(2)),
      leave: Number((index === sections.length - 1 ? end : cursor + span).toFixed(2)),
    };
    cursor = timing.leave;
    return timing;
  });
}

function renderCardMarkup(cards) {
  return cards
    .map(
      (card) => `
          <article class="stat info-card">
            <span class="stat-label">${escapeHtml(card.title)}</span>
            <p class="card-body">${escapeHtml(card.body)}</p>
          </article>`
    )
    .join("");
}

function renderCinematicVideoMarkup(layer, className = "") {
  if (!layer?.enabled || !layer.video?.available || !layer.video?.url) return "";
  const classes = ["cinematic-video", className].filter(Boolean).join(" ");
  const sourceType = /\.webm$/i.test(layer.video.url)
    ? "video/webm"
    : /\.ogg$/i.test(layer.video.url)
      ? "video/ogg"
      : "video/mp4";
  return `
      <video class="${classes}" data-cinematic-video="true" data-loop-mode="${escapeHtml(layer.loopMode)}" data-playback-speed="${escapeHtml(layer.speed)}" autoplay muted playsinline preload="auto">
        <source src="${escapeHtml(layer.video.url)}" type="${sourceType}" />
      </video>`;
}

function renderHeroCinematicMarkup(layer) {
  if (!layer?.enabled) return "";
  const parallaxClass = layer.parallax ? " cinematic-parallax" : "";
  if (layer.layout === "full-background") {
    return `
    <div class="hero-cinematic hero-cinematic-full${parallaxClass}" data-cinematic-parallax="${layer.parallax ? "true" : "false"}">
${renderCinematicVideoMarkup(layer)}
    </div>`;
  }
  return `
    <div class="hero-cinematic hero-cinematic-card${parallaxClass}" data-cinematic-parallax="${layer.parallax ? "true" : "false"}">
${renderCinematicVideoMarkup(layer)}
    </div>`;
}

function renderSectionCinematicMarkup(layer, section, index) {
  if (!layer?.enabled) return "";
  const layoutClass = layer.layout === "full-background" ? "section-cinematic-full" : "section-cinematic-card";
  const sideClass = layer.layout === "full-background"
    ? ""
    : section.alignment === "right"
      ? "section-cinematic-left"
      : section.alignment === "center"
      ? "section-cinematic-center"
        : "section-cinematic-right";
  const className = ["section-cinematic", layoutClass, sideClass, layer.parallax ? "cinematic-parallax" : ""].filter(Boolean).join(" ");
  return `
      <div class="${className}" data-cinematic-layer="${index}" data-cinematic-parallax="${layer.parallax ? "true" : "false"}">
${renderCinematicVideoMarkup(layer)}
      </div>`;
}

function renderSectionMarkup(section, timing, index, totalSections, cinematicLayer = null) {
  const alignClass = `align-${section.alignment || "left"}`;
  const commonAttrs = `class="scroll-section section-${escapeHtml(section.kind)} ${alignClass}" data-enter="${timing.enter}" data-leave="${timing.leave}" data-animation="${escapeHtml(section.animation || "fade-up")}" data-editor-section="${index}" data-editor-kind="${escapeHtml(section.kind)}"`;

  if (section.kind === "stats") {
    return `
    <section ${commonAttrs}>
${renderSectionCinematicMarkup(cinematicLayer, section, index)}
      <div class="section-inner section-inner-wide">
        <p class="section-label">${escapeHtml(section.label)}</p>
        <h2 class="section-heading">${escapeHtml(section.heading)}</h2>
        <div class="stats-grid">
${section.stats
  .map(
    (stat) => `          <div class="stat">
            <span class="stat-number" data-value="${escapeHtml(stat.value)}" data-decimals="${escapeHtml(stat.decimals)}">0</span>
            <span class="stat-suffix">${escapeHtml(stat.suffix)}</span>
            <span class="stat-label">${escapeHtml(stat.label)}</span>
          </div>`
  )
  .join("\n")}
        </div>
      </div>
    </section>`;
  }

  if (section.kind === "cards") {
    return `
    <section ${commonAttrs}>
${renderSectionCinematicMarkup(cinematicLayer, section, index)}
      <div class="section-inner section-inner-wide">
        <p class="section-label">${escapeHtml(section.label)}</p>
        <h2 class="section-heading">${escapeHtml(section.heading)}</h2>
        <div class="stats-grid cards-grid">
${renderCardMarkup(section.cards)}
        </div>
      </div>
    </section>`;
  }

  if (section.kind === "faq") {
    return `
    <section ${commonAttrs}>
${renderSectionCinematicMarkup(cinematicLayer, section, index)}
      <div class="section-inner section-inner-wide">
        <p class="section-label">${escapeHtml(section.label)}</p>
        <h2 class="section-heading">${escapeHtml(section.heading)}</h2>
        <div class="stats-grid cards-grid faq-grid">
${renderCardMarkup(
  section.items.map((item) => ({
    title: item.question,
    body: item.answer,
  }))
)}
        </div>
      </div>
    </section>`;
  }

  const extra = index === totalSections - 1 ? ` id="cta" data-persist="true"` : "";
  const button = section.kind === "cta" ? `<a class="cta-button" href="#">${escapeHtml(section.button)}</a>` : "";
  return `
    <section ${commonAttrs}${extra}>
${renderSectionCinematicMarkup(cinematicLayer, section, index)}
      <div class="section-inner">
        <p class="section-label">${escapeHtml(section.label)}</p>
        <h2 class="section-heading">${escapeHtml(section.heading)}</h2>
        <p class="section-body">${escapeHtml(section.body)}</p>
        ${button}
      </div>
    </section>`;
}

function writeScaffoldFiles({
  siteDir,
  topic,
  brand,
  pageMode,
  frameCount,
  frameExtension,
  research,
  sourceContext,
  contentOverrides = null,
  siteUrl = null,
  cinematicLayers = null,
  experienceUpgrades = null,
}) {
  const businessProfile = buildBusinessProfile(topic, brand, sourceContext, research);
  const profile = applyContentOverrides(buildContentProfile(businessProfile, pageMode), contentOverrides);
  const editableContent = buildEditableContent(profile);
  const headline = escapeHtml(String(profile.heroTitle || topic).toUpperCase());
  const safeTopic = escapeHtml(topic);
  const safeBrand = escapeHtml(brand);
  const normalizedSiteUrl = normalizePublicSiteUrl(siteUrl);
  const seoTitle = buildSeoTitle(topic, brand);
  const seoDescription = buildSeoDescription({ topic, profile, sourceContext, research });
  const seoKeywords = buildSeoKeywords({
    topic,
    brand,
    category: businessProfile.category,
    pageMode,
    research,
  });
  const canonicalImageUrl = buildCanonicalAssetUrl(normalizedSiteUrl, "media/start-frame.webp");
  const robotsDirectives = buildRobotsDirectives(normalizedSiteUrl);
  const structuredData = buildStructuredData({
    topic,
    brand,
    category: businessProfile.category,
    siteUrl: normalizedSiteUrl,
    seoTitle,
    seoDescription,
    heroImageUrl: canonicalImageUrl,
    sourceContext,
    research,
  });
  const productionArtifacts = writeProductionArtifacts({
    siteDir,
    siteUrl: normalizedSiteUrl,
  });
  const themeColor = businessProfile.palette?.[0] || profile.theme.accent;
  const faviconSvg = buildFaviconSvg({
    brand,
    accentColor: themeColor,
    backgroundColor: profile.theme.bg,
  });
  const logoMarkup = sourceContext?.logoUrl
    ? `<div class="brand-lockup"><img class="brand-logo" src="${escapeHtml(sourceContext.logoUrl)}" alt="${safeBrand} logo" /><span class="brand-text">${safeBrand}</span></div>`
    : `<span class="brand-text">${safeBrand}</span>`;
  const taglineRepeated = escapeHtml(profile.tagline) + " \u00B7 " + escapeHtml(profile.tagline) + " \u00B7 " + escapeHtml(profile.tagline);
  const renderedSections = [
    ...profile.sections,
    {
      kind: "cta",
      label: profile.cta.label,
      heading: profile.cta.heading,
      body: profile.cta.body,
      alignment: "left",
      animation: "fade-up",
      button: profile.cta.button,
    },
  ];
  const timings = buildSectionTiming(renderedSections);
  const normalizedCinematicLayers = {
    hero: cinematicLayers?.hero || { enabled: false },
    sections: Array.isArray(cinematicLayers?.sections) ? cinematicLayers.sections : [],
  };
  const normalizedExperienceUpgrades = normalizeExperienceUpgrades(experienceUpgrades);
  const hasExperienceControls = normalizedExperienceUpgrades.guidedScroll.enabled || normalizedExperienceUpgrades.audio.enabled;
  const serializedExperienceUpgrades = JSON.stringify(normalizedExperienceUpgrades).replace(/</g, "\\u003c");
  const sectionsHtml = renderedSections
    .map((section, index) =>
      renderSectionMarkup(
        section,
        timings[index],
        index,
        renderedSections.length,
        normalizedCinematicLayers.sections[index] || null
      )
    )
    .join("\n");
  const scrollHeight = Math.max(1300, 240 + renderedSections.length * 165);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(seoTitle)}</title>
  <meta name="description" content="${escapeHtml(seoDescription)}" />
  <meta name="robots" content="${escapeHtml(robotsDirectives)}" />
  <meta name="theme-color" content="${escapeHtml(themeColor)}" />
  <meta name="keywords" content="${escapeHtml(seoKeywords.join(", "))}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(seoTitle)}" />
  <meta property="og:description" content="${escapeHtml(seoDescription)}" />
  <meta property="og:site_name" content="${safeBrand}" />
  <meta property="og:locale" content="en_US" />
  ${normalizedSiteUrl ? `<meta property="og:url" content="${escapeHtml(normalizedSiteUrl)}" />` : ""}
  ${canonicalImageUrl ? `<meta property="og:image" content="${escapeHtml(canonicalImageUrl)}" />
  <meta property="og:image:alt" content="${escapeHtml(seoTitle)}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(seoTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(seoDescription)}" />
  ${canonicalImageUrl ? `<meta name="twitter:image" content="${escapeHtml(canonicalImageUrl)}" />` : ""}
  ${normalizedSiteUrl ? `<link rel="canonical" href="${escapeHtml(normalizedSiteUrl)}" />` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=DM+Serif+Display:ital@0;1&family=Manrope:wght@400;500;700;800&family=Oswald:wght@500;700&family=Syne:wght@500;700;800&display=swap" rel="stylesheet" />
  <link rel="icon" type="image/svg+xml" href="favicon.svg" />
  <link rel="stylesheet" href="css/style.css" />
  <script type="application/ld+json">${escapeJsonForHtml(structuredData)}</script>
</head>
<body>
  <div id="loader">
    <span class="loader-brand">${safeBrand}</span>
    <div class="loader-track"><div id="loader-bar"></div></div>
    <span id="loader-percent">0%</span>
  </div>

  <header class="site-header">
    <div class="brand">${logoMarkup}</div>
    <a href="#cta">${escapeHtml(profile.cta.headerCta)}</a>
  </header>

  ${hasExperienceControls ? `<div class="experience-controls" data-experience-controls="true"></div>` : ""}

  <section class="hero-standalone" data-editor-hero="true">
${renderHeroCinematicMarkup(normalizedCinematicLayers.hero)}
    <p class="hero-kicker">${escapeHtml(profile.heroKicker)}</p>
    <h1>${headline}</h1>
    <p class="hero-sub">${escapeHtml(profile.heroSub)}</p>
    <p class="hero-trust">${escapeHtml(profile.trustLine)}</p>
  </section>

  <div class="media-stage">
    <div class="canvas-wrap is-active"><canvas id="canvas"></canvas></div>
  </div>
  <div id="dark-overlay"></div>

  <div class="marquee-wrap" data-scroll-speed="-30">
    <p class="marquee-text">${taglineRepeated}</p>
  </div>

  <main id="scroll-container" style="--scroll-length:${scrollHeight}vh;">
${sectionsHtml}
  </main>

  <script src="https://cdn.jsdelivr.net/npm/lenis@1/dist/lenis.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/ScrollTrigger.min.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --bg: ${profile.theme.bg};
  --bg-elevated: ${profile.theme.bgElevated};
  --text: ${profile.theme.text};
  --muted: ${profile.theme.muted};
  --accent: ${profile.theme.accent};
  --accent-soft: ${profile.theme.accentSoft};
  --accent-alt: ${profile.theme.accentAlt};
  --hero-glow: ${profile.theme.heroGlow};
  --hero-glow-alt: ${profile.theme.heroGlowAlt};
  --font-display: ${profile.theme.displayFont};
  --font-body: ${profile.theme.bodyFont};
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; background: var(--bg); color: var(--text); }
body { font-family: var(--font-body); overflow-x: hidden; }

body.guided-mode-active {
  cursor: ns-resize;
}

#loader {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  gap: 1rem;
  place-content: center;
  background: #000;
  transition: opacity 0.4s ease;
}

.loader-brand {
  font-family: var(--font-display);
  letter-spacing: 0.12em;
  font-size: clamp(1.8rem, 5vw, 3rem);
}

.loader-track {
  width: min(70vw, 460px);
  height: 6px;
  border-radius: 999px;
  background: #1f1f1f;
}

#loader-bar {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9d2f18, var(--accent));
}

#loader-percent {
  text-align: right;
  color: var(--muted);
}

.site-header {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 40;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  mix-blend-mode: difference;
}

.site-header a,
.brand,
.brand-text {
  color: #fff;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  font-size: 0.78rem;
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
}

.brand-logo {
  width: auto;
  height: 2.5rem;
  object-fit: contain;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.25));
}

.experience-controls { position: fixed; inset: 0; pointer-events: none; z-index: 55; }

.experience-button {
  position: fixed;
  bottom: 1.25rem;
  border: 1px solid rgba(255, 255, 255, 0.14);
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
    linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05)),
    rgba(10, 9, 15, 0.8);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
  pointer-events: auto;
}

.experience-button[data-experience-slot="guided"] { left: 1.25rem; }
.experience-button[data-experience-slot="sound"] { right: 1.25rem; }
.experience-button[data-experience-active="true"] {
  border-color: rgba(255, 255, 255, 0.28);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
}

.hero-standalone {
  min-height: 100svh;
  padding: clamp(1.4rem, 4vw, 4rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1.2rem;
  position: relative;
  z-index: 15;
  perspective: 1600px;
  background:
    radial-gradient(circle at 18% 22%, var(--hero-glow) 0%, transparent 34%),
    radial-gradient(circle at 82% 16%, var(--hero-glow-alt) 0%, transparent 30%),
    linear-gradient(160deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 34%),
    linear-gradient(135deg, var(--bg) 0%, #030405 100%);
}

.hero-depth-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.depth-orb,
.depth-ring,
.depth-beam {
  position: absolute;
  display: block;
  will-change: transform;
}

.depth-orb {
  border-radius: 999px;
  filter: blur(8px);
}

.depth-orb-a {
  width: min(28vw, 22rem);
  height: min(28vw, 22rem);
  top: 10vh;
  left: 8vw;
  background: radial-gradient(circle, rgba(246, 107, 162, 0.22), rgba(246, 107, 162, 0.02) 60%, transparent 72%);
  transform: translate3d(calc(var(--depth-x, 0) * -18px), calc(var(--depth-y, 0) * -24px), 90px);
}

.depth-orb-b {
  width: min(22vw, 18rem);
  height: min(22vw, 18rem);
  right: 10vw;
  bottom: 16vh;
  background: radial-gradient(circle, rgba(244, 177, 77, 0.18), rgba(244, 177, 77, 0.02) 58%, transparent 72%);
  transform: translate3d(calc(var(--depth-x, 0) * 24px), calc(var(--depth-y, 0) * 16px), 70px);
}

.depth-ring {
  width: min(42vw, 38rem);
  height: min(42vw, 38rem);
  right: 18vw;
  top: 8vh;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 0 50px rgba(255, 255, 255, 0.04);
  transform: rotate(18deg) translate3d(calc(var(--depth-x, 0) * 12px), calc(var(--depth-y, 0) * -12px), 20px);
}

.depth-beam {
  inset: 12vh auto auto 42vw;
  width: min(28vw, 24rem);
  height: 65vh;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0));
  clip-path: polygon(38% 0, 64% 0, 100% 100%, 0 100%);
  opacity: 0.25;
  transform: translate3d(calc(var(--depth-x, 0) * 20px), calc(var(--depth-y, 0) * -10px), 10px);
}

.hero-standalone > *:not(.hero-cinematic) {
  position: relative;
  z-index: 2;
}

.hero-cinematic,
.section-cinematic {
  position: absolute;
  overflow: hidden;
  border-radius: 1.6rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background:
    linear-gradient(160deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
    rgba(5, 8, 10, 0.34);
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.34);
  transition: transform 180ms ease-out;
  will-change: transform;
}

.hero-cinematic::after,
.section-cinematic::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(8, 10, 15, 0.04), rgba(8, 10, 15, 0.28)),
    radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 28%);
}

.hero-cinematic-full {
  inset: 0;
  border-radius: 0;
  border: 0;
  box-shadow: none;
  background: rgba(0, 0, 0, 0.12);
}

.hero-cinematic-full::after {
  background:
    linear-gradient(90deg, rgba(7, 8, 12, 0.82) 0%, rgba(7, 8, 12, 0.46) 38%, rgba(7, 8, 12, 0.28) 62%, rgba(7, 8, 12, 0.62) 100%),
    radial-gradient(circle at 20% 20%, rgba(255,255,255,0.1), transparent 26%);
}

.hero-frame-glare {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at calc(52% + var(--depth-x, 0) * 16%), calc(28% + var(--depth-y, 0) * 14%), rgba(255, 255, 255, 0.22), transparent 24%),
    linear-gradient(120deg, rgba(255, 255, 255, 0.06), transparent 40%);
  mix-blend-mode: screen;
  pointer-events: none;
}

.hero-cinematic-card {
  inset: 8vh 5vw 12vh 49vw;
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

.section-cinematic {
  top: 50%;
  transform: translateY(-50%);
  z-index: 0;
}

.section-cinematic-card {
  width: min(34vw, 32rem);
  aspect-ratio: 16 / 10;
}

.section-cinematic-card.cinematic-parallax,
.section-cinematic-center.cinematic-parallax {
  transform:
    translate3d(calc(var(--parallax-x, 0) * 16px), calc(-50% + var(--parallax-y, 0) * -14px), 48px)
    rotateX(calc(var(--parallax-y, 0) * -4deg))
    rotateY(calc(var(--parallax-x, 0) * 6deg));
}

.section-cinematic-right {
  right: 5vw;
}

.section-cinematic-left {
  left: 5vw;
}

.section-cinematic-center {
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(72vw, 56rem);
  aspect-ratio: 16 / 7;
}

.section-cinematic-full {
  inset: clamp(1rem, 3vw, 2rem) 4vw;
  transform: none;
  top: 0;
  border-radius: 2rem;
}

.section-cinematic-full::after {
  background:
    linear-gradient(180deg, rgba(7, 9, 13, 0.68), rgba(7, 9, 13, 0.38)),
    radial-gradient(circle at 50% 12%, rgba(255,255,255,0.14), transparent 24%);
}

.cinematic-video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.hero-kicker {
  letter-spacing: 0.18em;
  font-size: 0.75rem;
  color: var(--muted);
}

h1 {
  font-family: var(--font-display);
  font-size: clamp(3rem, 11vw, 12rem);
  letter-spacing: 0.03em;
  line-height: 0.95;
  overflow-wrap: anywhere;
}

.hero-sub {
  max-width: 54ch;
  color: #d2d2cc;
  font-size: clamp(1rem, 2vw, 1.3rem);
}

.hero-trust {
  max-width: 52ch;
  color: var(--accent-soft);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.74rem;
}

.media-stage,
.canvas-wrap,
#dark-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.media-stage,
.canvas-wrap {
  z-index: 5;
}

.media-stage {
  clip-path: circle(0% at 50% 50%);
}

#dark-overlay {
  z-index: 10;
  background: #000;
  opacity: 0;
}

#canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.canvas-wrap {
  opacity: 1;
}

.marquee-wrap {
  position: fixed;
  top: 74vh;
  left: 0;
  width: 100%;
  z-index: 12;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
}

.marquee-text {
  width: max-content;
  font-family: var(--font-display);
  font-size: clamp(3.2rem, 13vw, 11rem);
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.16);
}

#scroll-container {
  position: relative;
  height: var(--scroll-length, 1400vh);
  z-index: 20;
}

.scroll-section {
  position: absolute;
  width: 100%;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  padding-block: clamp(2rem, 7vh, 6rem);
  isolation: isolate;
}

.align-left { padding-left: 5vw; padding-right: 55vw; }
.align-right { padding-left: 55vw; padding-right: 5vw; }
.align-center { padding: 0 10vw; text-align: center; }

.section-inner {
  width: min(40vw, 42rem);
  max-width: 100%;
  display: grid;
  gap: 1rem;
  position: relative;
  z-index: 2;
}

.section-inner-wide {
  width: min(88vw, 1120px);
  max-width: min(88vw, 1120px);
}

.section-dramatic-intro .section-inner,
.section-closing .section-inner {
  max-width: 70ch;
  margin-inline: auto;
  text-align: center;
}

.section-dramatic-intro .section-heading {
  font-size: clamp(2.5rem, 7vw, 5.5rem);
  line-height: 1.05;
}

.section-closing .section-heading {
  font-size: clamp(2rem, 5vw, 4rem);
  line-height: 1.1;
}

.section-label {
  font-size: 0.72rem;
  letter-spacing: 0.17em;
  color: var(--muted);
  text-transform: uppercase;
}

.section-heading {
  font-family: var(--font-display);
  font-size: clamp(2.5rem, 6vw, 5rem);
  line-height: 0.95;
}

.section-body {
  font-size: clamp(1rem, 1.6vw, 1.25rem);
  color: #d2d2cc;
  line-height: 1.6;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

.stat {
  display: grid;
  gap: 0.5rem;
  padding: 1.1rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 1.1rem;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
    rgba(7, 10, 14, 0.54);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.22);
}

.stat-number {
  font-family: var(--font-display);
  font-size: clamp(3rem, 8vw, 6rem);
  line-height: 0.95;
}

.stat-suffix {
  margin-left: 0.25rem;
  font-size: clamp(1rem, 2vw, 1.6rem);
  color: #f5b8a9;
}

.stat-label {
  font-size: 0.75rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

.cards-grid {
  align-items: stretch;
}

.info-card {
  align-content: start;
}

.card-body {
  margin: 0;
  color: #e4e7eb;
  font-size: clamp(0.96rem, 1.4vw, 1.15rem);
  line-height: 1.55;
}

.cta-button {
  margin-top: 0.4rem;
  justify-self: start;
  border: 1px solid var(--accent);
  padding: 0.9rem 1.3rem;
  text-decoration: none;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #fff;
  background: linear-gradient(135deg, #7a2413, #d9431e);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
}

@media (max-width: 900px) {
  .experience-button {
    bottom: 0.9rem;
    width: 3rem;
    height: 3rem;
    font-size: 1.05rem;
  }
  .experience-button[data-experience-slot="guided"] { left: 0.9rem; }
  .experience-button[data-experience-slot="sound"] { right: 0.9rem; }
  .align-left,
  .align-right,
  .align-center {
    padding-left: 7vw;
    padding-right: 7vw;
    text-align: center;
  }
  .section-inner {
    max-width: 86vw;
    width: 86vw;
    margin-inline: auto;
    background: rgba(0, 0, 0, 0.58);
    padding: 1rem;
    border-radius: 0.5rem;
  }
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
  .hero-standalone {
    min-height: auto;
    padding-top: 6rem;
    perspective: none;
  }
  .stats-grid {
    grid-template-columns: 1fr;
    text-align: center;
  }
  .brand-logo {
    height: 2rem;
  }
  .hero-depth-grid {
    opacity: 0.75;
  }
  .cta-button { justify-self: center; }
}
`;

  const js = `const EXPERIENCE_UPGRADES = ${serializedExperienceUpgrades};
const FRAME_COUNT = ${frameCount};
const FRAME_SPEED = 1.0;
const FRAME_PATH = (index) => \`frames/frame_\${String(index + 1).padStart(4, "0")}.${frameExtension}\`;
const FRAME_WINDOW = 8;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const loader = document.getElementById("loader");
const loaderBar = document.getElementById("loader-bar");
const loaderPercent = document.getElementById("loader-percent");
const scrollContainer = document.getElementById("scroll-container");
const mediaStage = document.querySelector(".media-stage");
const canvasWrap = document.querySelector(".canvas-wrap");
const hero = document.querySelector(".hero-standalone");
const darkOverlay = document.getElementById("dark-overlay");
const cinematicVideos = Array.from(document.querySelectorAll("[data-cinematic-video]"));
const experienceControls = document.querySelector("[data-experience-controls]");

const frames = new Array(FRAME_COUNT);
const frameLoads = new Set();
let currentFrame = 0;
let fallbackReady = false;
let runtimeReady = false;
let lenis = null;
let guidedModeRaf = 0;
let guidedModeActive = false;
let guidedModeDismissed = false;
let guidedModeStartedAt = 0;
let guidedModePhase = "down";
let guidedModePauseUntil = 0;
let guidedResumeTimer = 0;
let lastKnownScrollY = 0;
let ambientAudioContext = null;
let ambientAudioNodes = [];
let ambientPulseTimer = 0;
let ambientAudioEnabled = false;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}

function drawFrame(index) {
  const img = frames[index];
  if (!img) return;
  drawImageToCanvas(img);
}

function drawImageToCanvas(img) {
  if (!img) return;
  const cw = canvas.width;
  const ch = canvas.height;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(cw / iw, ch / ih) * 0.83;
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function setLoaderProgress(pct, label = null) {
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  loaderBar.style.width = safePct + "%";
  loaderPercent.textContent = label || (safePct + "%");
}

function finishLoader() {
  if (runtimeReady) return;
  runtimeReady = true;
  setLoaderProgress(100);
  loader.style.opacity = "0";
  setTimeout(() => {
    loader.style.display = "none";
  }, 400);
}

function getNearestLoadedFrame(index) {
  if (frames[index]) return frames[index];
  for (let distance = 1; distance < FRAME_COUNT; distance += 1) {
    if (frames[index - distance]) return frames[index - distance];
    if (frames[index + distance]) return frames[index + distance];
  }
  return null;
}

function ensureFrame(index) {
  if (index < 0 || index >= FRAME_COUNT || frames[index] || frameLoads.has(index)) return;
  frameLoads.add(index);
  const img = new Image();
  img.onload = () => {
    frames[index] = img;
    if (index === 0) {
      fallbackReady = true;
      drawFrame(0);
      finishLoader();
    }
  };
  img.onerror = () => {
    frameLoads.delete(index);
  };
  img.src = FRAME_PATH(index);
}

function ensureFrameWindow(center) {
  for (let offset = -FRAME_WINDOW; offset <= FRAME_WINDOW; offset += 1) {
    ensureFrame(center + offset);
  }
}

function drawFallbackFrame(index) {
  const frame = getNearestLoadedFrame(index);
  if (!frame) return;
  drawImageToCanvas(frame);
}

function activateFallback() {
  if (!fallbackReady) {
    ensureFrame(0);
  }
  ensureFrameWindow(currentFrame);
  drawFallbackFrame(currentFrame);
  if (fallbackReady) finishLoader();
}

function setupMedia() {
  setLoaderProgress(8, "8%");
  ensureFrame(0);
  ensureFrameWindow(0);
  setLoaderProgress(45, "45%");
}

function setupSmoothScroll() {
  lenis = new Lenis({
    duration: 1.2,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

function ensureExperienceControls() {
  if (!experienceControls) return {};
  if (!experienceControls.querySelector("[data-guided-mode-btn]") && EXPERIENCE_UPGRADES.guidedScroll.enabled) {
    const guidedButton = document.createElement("button");
    guidedButton.type = "button";
    guidedButton.className = "experience-button";
    guidedButton.setAttribute("data-guided-mode-btn", "true");
    guidedButton.setAttribute("data-experience-slot", "guided");
    guidedButton.textContent = "↕";
    experienceControls.appendChild(guidedButton);
  }
  if (!experienceControls.querySelector("[data-sound-toggle-btn]") && EXPERIENCE_UPGRADES.audio.enabled) {
    const soundButton = document.createElement("button");
    soundButton.type = "button";
    soundButton.className = "experience-button";
    soundButton.setAttribute("data-sound-toggle-btn", "true");
    soundButton.setAttribute("data-experience-slot", "sound");
    soundButton.textContent = "♪";
    experienceControls.appendChild(soundButton);
  }
  return {
    guidedModeButton: experienceControls.querySelector("[data-guided-mode-btn]"),
    soundToggleButton: experienceControls.querySelector("[data-sound-toggle-btn]"),
  };
}

function updateGuidedModeUi(guidedModeButton) {
  if (!guidedModeButton) return;
  guidedModeButton.textContent = "↕";
  guidedModeButton.dataset.experienceActive = guidedModeActive ? "true" : "false";
  guidedModeButton.setAttribute("aria-label", guidedModeActive ? "Guided mode on" : guidedModeDismissed ? "Resume guided mode" : "Guided mode off");
  guidedModeButton.title = guidedModeButton.getAttribute("aria-label");
  document.body.classList.toggle("guided-mode-active", guidedModeActive);
}

function stopGuidedMode(guidedModeButton, markDismissed = true) {
  guidedModeActive = false;
  if (markDismissed) guidedModeDismissed = true;
  if (guidedModeRaf) cancelAnimationFrame(guidedModeRaf);
  guidedModeRaf = 0;
  guidedModePauseUntil = 0;
  updateGuidedModeUi(guidedModeButton);
}

function guidedModeStep() {
  if (!guidedModeActive || !lenis) return;
  if (guidedModePauseUntil && performance.now() < guidedModePauseUntil) {
    guidedModeRaf = requestAnimationFrame(guidedModeStep);
    return;
  }
  if (guidedModePauseUntil && performance.now() >= guidedModePauseUntil) {
    guidedModePauseUntil = 0;
    guidedModePhase = "up";
    guidedModeStartedAt = 0;
  }
  if (!guidedModeStartedAt) guidedModeStartedAt = performance.now();
  const duration = guidedModePhase === "down"
    ? EXPERIENCE_UPGRADES.guidedScroll.downDurationMs
    : EXPERIENCE_UPGRADES.guidedScroll.upDurationMs;
  const elapsed = performance.now() - guidedModeStartedAt;
  const progress = Math.min(1, elapsed / duration);
  const eased = 1 - Math.pow(1 - progress, 2.2);
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const isNearBottom = window.scrollY >= Math.max(0, maxScroll - 8);
  if (guidedModePhase === "down" && isNearBottom) {
    guidedModePauseUntil = performance.now() + EXPERIENCE_UPGRADES.guidedScroll.endPauseMs;
    lenis.scrollTo(maxScroll, { immediate: true, force: true });
    guidedModeRaf = requestAnimationFrame(guidedModeStep);
    return;
  }
  const target = guidedModePhase === "down" ? maxScroll : 0;
  const origin = guidedModePhase === "down" ? 0 : maxScroll;
  lenis.scrollTo(origin + (target - origin) * eased, { immediate: true, force: true });
  if (progress >= 1) {
    if (guidedModePhase === "down") {
      guidedModePhase = "up";
      guidedModeStartedAt = 0;
      guidedModeRaf = requestAnimationFrame(guidedModeStep);
      return;
    }
    stopGuidedMode(window.__uwGuidedModeButton, false);
    return;
  }
  guidedModeRaf = requestAnimationFrame(guidedModeStep);
}

function startGuidedMode(guidedModeButton) {
  if (!EXPERIENCE_UPGRADES.guidedScroll.enabled || !lenis || guidedModeActive) return;
  if (guidedResumeTimer) {
    window.clearTimeout(guidedResumeTimer);
    guidedResumeTimer = 0;
  }
  guidedModeActive = true;
  guidedModeStartedAt = 0;
  guidedModePauseUntil = 0;
  guidedModePhase = window.scrollY >= Math.max(0, document.documentElement.scrollHeight - window.innerHeight - 8) ? "up" : "down";
  window.__uwGuidedModeButton = guidedModeButton || null;
  updateGuidedModeUi(guidedModeButton);
  guidedModeRaf = requestAnimationFrame(guidedModeStep);
}

function scheduleGuidedResume(guidedModeButton) {
  if (!EXPERIENCE_UPGRADES.guidedScroll.enabled) return;
  if (guidedResumeTimer) window.clearTimeout(guidedResumeTimer);
  guidedResumeTimer = window.setTimeout(() => {
    if (!guidedModeActive) {
      guidedModeDismissed = false;
      startGuidedMode(guidedModeButton);
    }
  }, EXPERIENCE_UPGRADES.guidedScroll.resumeDelayMs);
}

function bindGuidedMode(guidedModeButton) {
  if (!guidedModeButton || guidedModeButton.dataset.bound === "true") return;
  guidedModeButton.dataset.bound = "true";
  const interrupt = () => {
    if (guidedModeActive) stopGuidedMode(guidedModeButton, true);
    scheduleGuidedResume(guidedModeButton);
  };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach((eventName) => {
    window.addEventListener(eventName, interrupt, { passive: true });
  });
  window.addEventListener("scroll", () => {
    const currentScrollY = window.scrollY;
    const delta = Math.abs(currentScrollY - lastKnownScrollY);
    lastKnownScrollY = currentScrollY;
    if (!guidedModeActive && delta > 2) scheduleGuidedResume(guidedModeButton);
  }, { passive: true });
  guidedModeButton.addEventListener("click", () => {
    if (guidedModeActive) {
      stopGuidedMode(guidedModeButton, true);
      scheduleGuidedResume(guidedModeButton);
      return;
    }
    guidedModeDismissed = false;
    startGuidedMode(guidedModeButton);
  });
  window.addEventListener("load", () => {
    window.setTimeout(() => {
      if (!guidedModeDismissed) startGuidedMode(guidedModeButton);
    }, EXPERIENCE_UPGRADES.guidedScroll.initialDelayMs);
  }, { once: true });
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

async function enableAmbientAudio(soundToggleButton) {
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
    ambientPulseTimer = window.setInterval(playAmbientPulse, 6800);
  }
  ambientAudioEnabled = true;
  if (soundToggleButton) {
    soundToggleButton.textContent = "♪";
    soundToggleButton.dataset.experienceActive = "true";
    soundToggleButton.setAttribute("aria-label", "Sound on");
    soundToggleButton.title = "Sound on";
  }
}

function disableAmbientAudio(soundToggleButton) {
  if (ambientPulseTimer) {
    window.clearInterval(ambientPulseTimer);
    ambientPulseTimer = 0;
  }
  ambientAudioNodes.forEach((node) => {
    try { if (typeof node.stop === "function") node.stop(); } catch {}
    try { if (typeof node.disconnect === "function") node.disconnect(); } catch {}
  });
  ambientAudioNodes = [];
  ambientAudioEnabled = false;
  if (soundToggleButton) {
    soundToggleButton.textContent = "♪";
    soundToggleButton.dataset.experienceActive = "false";
    soundToggleButton.setAttribute("aria-label", "Sound off");
    soundToggleButton.title = "Sound off";
  }
}

function bindSoundToggle(soundToggleButton) {
  if (!soundToggleButton || soundToggleButton.dataset.bound === "true") return;
  soundToggleButton.dataset.bound = "true";
  soundToggleButton.addEventListener("click", async () => {
    if (ambientAudioEnabled) {
      disableAmbientAudio(soundToggleButton);
      return;
    }
    try {
      await enableAmbientAudio(soundToggleButton);
    } catch {
      soundToggleButton.textContent = "Sound Unavailable";
    }
  });
}

function setupHeroDepth() {
  if (!EXPERIENCE_UPGRADES.depthHero.enabled || !hero) return;
  if (!hero.querySelector(".hero-depth-grid")) {
    const depthGrid = document.createElement("div");
    depthGrid.className = "hero-depth-grid";
    depthGrid.setAttribute("aria-hidden", "true");
    depthGrid.innerHTML = '<span class="depth-orb depth-orb-a"></span><span class="depth-orb depth-orb-b"></span><span class="depth-ring"></span><span class="depth-beam"></span>';
    hero.insertBefore(depthGrid, hero.firstChild);
  }
  const cinematicNode = hero.querySelector(".hero-cinematic-card");
  if (cinematicNode && !cinematicNode.querySelector(".hero-frame-glare")) {
    const glare = document.createElement("div");
    glare.className = "hero-frame-glare";
    glare.setAttribute("aria-hidden", "true");
    cinematicNode.appendChild(glare);
  }
  hero.addEventListener("pointermove", (event) => {
    const bounds = hero.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
    hero.style.setProperty("--depth-x", x.toFixed(3));
    hero.style.setProperty("--depth-y", y.toFixed(3));
  });
  hero.addEventListener("pointerleave", () => {
    hero.style.setProperty("--depth-x", "0");
    hero.style.setProperty("--depth-y", "0");
  });
}

function setupLoopingVideo(video, loopMode = "loop", rate = 1) {
  if (!video) return;
  const speed = Math.min(2.5, Math.max(0.25, Number(rate) || 1));
  let reverseFrame = null;
  let reversing = false;
  let lastTick = 0;

  const stopReverse = () => {
    if (reverseFrame) cancelAnimationFrame(reverseFrame);
    reverseFrame = null;
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
    reverseFrame = requestAnimationFrame(reverseStep);
  };

  const startReverse = () => {
    if (loopMode !== "boomerang" || reversing) return;
    if (video.duration && video.currentTime >= video.duration - 0.02) {
      video.currentTime = Math.max(0, video.duration - 0.02);
    }
    reversing = true;
    video.pause();
    reverseFrame = requestAnimationFrame(reverseStep);
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
      if (!reversing) return;
      stopReverse();
    });
  }
}

function setupCinematicParallax() {
  const bindings = [
    { wrapper: document.querySelector(".hero-cinematic.cinematic-parallax"), host: hero },
    ...Array.from(document.querySelectorAll(".section-cinematic.cinematic-parallax")).map((wrapper) => ({
      wrapper,
      host: wrapper.closest(".scroll-section"),
    })),
  ];

  bindings.forEach(({ wrapper, host }) => {
    if (!wrapper || !host || wrapper.dataset.parallaxBound === "true") return;
    wrapper.dataset.parallaxBound = "true";
    const reset = () => {
      wrapper.style.setProperty("--parallax-x", "0");
      wrapper.style.setProperty("--parallax-y", "0");
    };
    host.addEventListener("pointermove", (event) => {
      const bounds = host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
      const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
      wrapper.style.setProperty("--parallax-x", x.toFixed(3));
      wrapper.style.setProperty("--parallax-y", y.toFixed(3));
    });
    host.addEventListener("pointerleave", reset);
    reset();
  });
}

function placeSections() {
  document.querySelectorAll(".scroll-section").forEach((section) => {
    const enter = Number(section.dataset.enter || 0);
    const leave = Number(section.dataset.leave || 100);
    section.style.top = ((enter + leave) / 2) + "%";
  });
}

function setupFrameBinding() {
  ScrollTrigger.create({
    trigger: scrollContainer,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      const accelerated = Math.min(self.progress * FRAME_SPEED, 1);
      const nextFrame = Math.min(Math.floor(accelerated * (FRAME_COUNT - 1)), FRAME_COUNT - 1);
      if (nextFrame !== currentFrame) {
        currentFrame = nextFrame;
        ensureFrameWindow(currentFrame);
        requestAnimationFrame(() => drawFallbackFrame(currentFrame));
      }
    }
  });
}

function sectionTimeline(section) {
  const type = section.dataset.animation || "fade-up";
  const children = section.querySelectorAll(".section-label, .section-heading, .section-body, .cta-button, .stat");
  const tl = gsap.timeline({ paused: true });
  const common = { opacity: 0, stagger: 0.12, duration: 0.9, ease: "power3.out" };

  switch (type) {
    case "slide-left":
      tl.from(children, { ...common, x: -80 });
      break;
    case "slide-right":
      tl.from(children, { ...common, x: 80 });
      break;
    case "clip-reveal":
      tl.from(children, { ...common, clipPath: "inset(100% 0 0 0)", duration: 1.15, ease: "power4.out" });
      break;
    case "stagger-up":
      tl.from(children, { ...common, y: 60, duration: 0.8 });
      break;
    default:
      tl.from(children, { ...common, y: 50 });
  }
  return tl;
}

function setupSectionAnimations() {
  document.querySelectorAll(".scroll-section").forEach((section) => {
    const tl = sectionTimeline(section);
    const persist = section.dataset.persist === "true";
    ScrollTrigger.create({
      trigger: scrollContainer,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => {
        const p = self.progress;
        const enter = Number(section.dataset.enter) / 100;
        const leave = Number(section.dataset.leave) / 100;
        const visible = p >= enter && p <= leave;
        const keepVisible = persist && p > leave;
        section.style.opacity = visible || keepVisible ? "1" : "0";
        if (visible) tl.play();
        else if (!keepVisible) tl.reverse();
      }
    });
  });
}

function setupCounters() {
  document.querySelectorAll(".stat-number").forEach((el) => {
    const target = Number(el.dataset.value || 0);
    const decimals = Number(el.dataset.decimals || 0);
    const state = { value: 0 };
    gsap.to(state, {
      value: target,
      duration: 2,
      ease: "power1.out",
      scrollTrigger: {
        trigger: el.closest(".scroll-section"),
        start: "top 70%",
        toggleActions: "play none none reverse"
      },
      onUpdate: () => {
        el.textContent = state.value.toFixed(decimals);
      }
    });
  });
}

function setupMarquee() {
  document.querySelectorAll(".marquee-wrap").forEach((wrap) => {
    const speed = Number(wrap.dataset.scrollSpeed || -25);
    gsap.to(wrap.querySelector(".marquee-text"), {
      xPercent: speed,
      ease: "none",
      scrollTrigger: {
        trigger: scrollContainer,
        start: "top top",
        end: "bottom bottom",
        scrub: true
      }
    });

    ScrollTrigger.create({
      trigger: scrollContainer,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => {
        wrap.style.opacity = self.progress > 0.18 && self.progress < 0.9 ? "1" : "0";
      }
    });
  });
}

function setupDarkOverlay() {
  const enter = 0.58;
  const leave = 0.70;
  const fadeRange = 0.05;
  ScrollTrigger.create({
    trigger: scrollContainer,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      const p = self.progress;
      let opacity = 0;
      if (p >= enter - fadeRange && p <= enter) opacity = (p - (enter - fadeRange)) / fadeRange;
      else if (p > enter && p < leave) opacity = 0.9;
      else if (p >= leave && p <= leave + fadeRange) opacity = 0.9 * (1 - (p - leave) / fadeRange);
      darkOverlay.style.opacity = String(Math.max(0, opacity));
    }
  });
}

function setupHeroTransition() {
  ScrollTrigger.create({
    trigger: scrollContainer,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      const p = self.progress;
      hero.style.opacity = String(Math.max(0, 1 - p * 15));
      const wipe = Math.min(1, Math.max(0, (p - 0.01) / 0.06));
      mediaStage.style.clipPath = \`circle(\${wipe * 75}% at 50% 50%)\`;
      hero.style.setProperty("--scroll-shift-y", \`\${wipe * 2.5}vh\`);
    }
  });
}

function setupCinematicVideos() {
  cinematicVideos.forEach((video) => {
    setupLoopingVideo(
      video,
      String(video.dataset.loopMode || "loop"),
      Number(video.dataset.playbackSpeed || 1)
    );
  });
}

window.addEventListener("resize", () => {
  resizeCanvas();
  drawFallbackFrame(currentFrame);
});

resizeCanvas();
setupMedia();
setupSmoothScroll();
const { guidedModeButton, soundToggleButton } = ensureExperienceControls();
bindGuidedMode(guidedModeButton);
bindSoundToggle(soundToggleButton);
setupHeroDepth();
placeSections();
setupFrameBinding();
setupSectionAnimations();
setupCounters();
setupMarquee();
setupDarkOverlay();
setupHeroTransition();
setupCinematicVideos();
setupCinematicParallax();
`;

  writeFileSync(join(siteDir, "index.html"), html);
  writeFileSync(join(siteDir, "favicon.svg"), faviconSvg);
  writeFileSync(join(siteDir, "css/style.css"), css);
  writeFileSync(join(siteDir, "js/app.js"), js);
  return {
    category: profile.category,
    pageMode: profile.pageMode,
    sectionKinds: renderedSections.map((section) => section.kind),
    trustLine: profile.trustLine,
    editableContent,
    cinematicLayers: normalizedCinematicLayers,
    experienceUpgrades: normalizedExperienceUpgrades,
    seo: {
      title: seoTitle,
      description: seoDescription,
      keywords: seoKeywords,
      canonicalUrl: normalizedSiteUrl,
      ogImageUrl: canonicalImageUrl,
      robotsDirectives,
      structuredData,
      ...productionArtifacts,
    },
  };
}

function runFrameExtraction(videoPath, framesDir) {
  const metadata = readVideoMetadata(videoPath);
  const settings = chooseExtractionSettings(metadata);
  const vf = `fps=${settings.fps},scale=${settings.width}:-1`;

  const frameExtension = "webp";
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      vf,
      "-c:v",
      "libwebp",
      "-quality",
      "72",
      "-compression_level",
      "6",
      "-preset",
      "picture",
      join(framesDir, `frame_%04d.${frameExtension}`),
    ],
    { stdio: "inherit" }
  );
  if (ffmpeg.status !== 0) {
    throw new Error("ffmpeg frame extraction failed.");
  }

  const frameRegex = new RegExp(`^frame_\\d+\\.${frameExtension}$`);
  const frameFiles = readdirSync(framesDir).filter((name) => frameRegex.test(name)).sort();
  if (frameFiles.length < 40) {
    throw new Error(`Frame extraction produced too few frames (${frameFiles.length}).`);
  }

  return { metadata, settings, frameCount: frameFiles.length, frameExtension };
}

function buildPromptContext(businessProfile) {
  const sourceContext = businessProfile?.sourceContext;
  const details = [];
  const palette = summarizePalette(sourceContext?.palette);
  if (sourceContext?.title) details.push(`brand reference ${sourceContext.title}`);
  if (sourceContext?.description) details.push(`site cues ${clipText(sourceContext.description, 180)}`);
  if (businessProfile?.logoUrl) details.push("preserve the brand mark silhouette and venue identity cues");
  if (businessProfile?.referenceMedia?.some((url) => /\.mp4(\?|$)/i.test(url))) details.push("inspired by the source site's aerial or venue video coverage");
  if (palette) details.push(`palette cues ${palette}`);
  return details.length ? `, ${details.join(", ")}` : "";
}

function createPrompts(businessProfile) {
  const { topic, category } = businessProfile;
  const promptContext = buildPromptContext(businessProfile);

  if (category === "person") {
    const startPrompt =
      `Cinematic portrait of ${topic}, dramatic studio lighting, dark moody background, ` +
      `editorial photography style, sharp focus on face and expression, no text, no logos, ultra detailed${promptContext}`;

    const endPrompt =
      `Same ${topic} subject. Show a dynamic action or iconic pose that captures their essence, ` +
      `dramatic lighting with motion blur accents, dark atmospheric background, ` +
      `no text, no logos, editorial photography, ultra detailed${promptContext}.`;

    const motionPrompt =
      `Cinematic portrait animation. Start from first frame. Smooth transition to the dynamic action pose. ` +
      `Elegant camera movement, dramatic lighting shifts, no sudden warping, no text, dark atmospheric background${promptContext}.`;

    return { startPrompt, endPrompt, motionPrompt };
  }

  if (category === "place") {
    const startPrompt =
      `Cinematic wide establishing shot of ${topic}, real cityscape or destination geography, golden hour lighting, dramatic atmosphere, ` +
      `architectural detail, landscape photography, authentic location cues, no character illustration, no text, no logos, ultra detailed 8k${promptContext}`;

    const endPrompt =
      `Same ${topic} location, different dramatic perspective. Aerial or intimate detail view revealing ` +
      `hidden character of the place, atmospheric lighting, moody sky, ` +
      `no people, no character illustration, no text, no logos, landscape photography, ultra detailed${promptContext}.`;

    const motionPrompt =
      `Cinematic location reveal. Start from first frame. Smooth drone-like camera movement exploring the space. ` +
      `Atmospheric particles, shifting light, no sudden warping, no text, no people, cinematic landscape${promptContext}.`;

    return { startPrompt, endPrompt, motionPrompt };
  }

  if (category === "venue") {
    const startPrompt =
      `Cinematic hospitality hero shot of ${topic}, authentic venue exterior or interior, moody practical lighting, ` +
      `real neighborhood context, premium editorial photography, no text overlay, no posters, ultra detailed${promptContext}`;

    const endPrompt =
      `Same ${topic} venue in a more immersive perspective. Show signature atmosphere, seating, bar program or food presentation, ` +
      `crowd energy suggested naturally without turning into generic stock food photography, no text overlay, ultra detailed${promptContext}.`;

    const motionPrompt =
      `Cinematic venue animation. Start from the establishing frame and move into the room with subtle camera drift, light changes, and lived-in energy. ` +
      `Keep the business grounded in its real location and brand identity, avoid generic product deconstruction, no text${promptContext}.`;

    return { startPrompt, endPrompt, motionPrompt };
  }

  // Car / product / generic
  const startPrompt =
    `Professional studio hero shot of ${topic}, centered, cinematic lighting, ` +
    `matte black seamless background, no logos, no text, no humans, no reflections, ultra detailed product photography${promptContext}`;

  const endPrompt =
    `Same ${topic} subject and camera angle. Show a futuristic deconstruction state with key components ` +
    `separated and suspended in a controlled exploded-view composition. Keep matte black seamless background, ` +
    `no logos, no text, no humans, no reflections, studio lighting, ultra detailed${promptContext}.`;

  const motionPrompt =
    `Cinematic product animation. Start from first frame. Move smoothly toward the final exploded-view composition. ` +
    `Controlled mechanical motion, no sudden warping, no camera shake, no text, no humans, black seamless background${promptContext}.`;

  return { startPrompt, endPrompt, motionPrompt };
}

function ensureCommandAvailable(command, args = ["--version"]) {
  const check = spawnSync(command, args, { stdio: "ignore" });
  return check.status === 0;
}

function runPlaywrightQa({ siteDir, sourceContext }) {
  if (!ensureCommandAvailable("npx", ["--version"])) {
    return { ran: false, reason: "npx unavailable" };
  }

  const indexPath = resolve(siteDir, "index.html");
  const qaDir = join(siteDir, "qa");
  mkdirSync(qaDir, { recursive: true });

  const jobs = [
    {
      name: "generatedDesktop",
      args: ["playwright", "screenshot", "--browser=chromium", "--viewport-size=1440,900", "--wait-for-timeout=1500", `file://${indexPath}`, join(qaDir, "generated-desktop.png")],
    },
    {
      name: "generatedMobile",
      args: ["playwright", "screenshot", "--browser=chromium", "--viewport-size=393,852", "--wait-for-timeout=1500", `file://${indexPath}`, join(qaDir, "generated-mobile.png")],
    },
  ];

  if (sourceContext?.url) {
    jobs.push(
      {
        name: "liveDesktop",
        args: ["playwright", "screenshot", "--browser=chromium", "--viewport-size=1440,900", "--wait-for-timeout=1500", sourceContext.url, join(qaDir, "live-desktop.png")],
      },
      {
        name: "liveMobile",
        args: ["playwright", "screenshot", "--browser=chromium", "--viewport-size=393,852", "--wait-for-timeout=1500", sourceContext.url, join(qaDir, "live-mobile.png")],
      }
    );
  }

  const results = [];
  for (const job of jobs) {
    const run = spawnSync("npx", job.args, { encoding: "utf-8" });
    results.push({
      name: job.name,
      ok: run.status === 0,
      output: clipText(`${run.stdout || ""} ${run.stderr || ""}`, 400),
    });
  }

  return {
    ran: true,
    dir: qaDir,
    results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const parsedTopic = parseTopicInput(String(options.topic || "").trim());
  const topic = parsedTopic.topic;
  if (!topic) {
    throw new Error("--topic is required");
  }

  ensureBinary("ffmpeg");
  ensureBinary("ffprobe");

  const slug = String(options.slug || slugify(topic));
  const outDir = resolve(String(options["out-dir"] || "generated-sites"));
  const siteDir = resolve(outDir, slug);
  const mediaDir = join(siteDir, "media");
  const framesDir = join(siteDir, "frames");
  const cssDir = join(siteDir, "css");
  const jsDir = join(siteDir, "js");

  mkdirSync(siteDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(framesDir, { recursive: true });
  mkdirSync(cssDir, { recursive: true });
  mkdirSync(jsDir, { recursive: true });

  const sourceUrl = cleanOptionalString(options["source-url"]) || parsedTopic.sourceUrl;
  const siteUrl = normalizePublicSiteUrl(options["site-url"]);
  if (options["site-url"] && !siteUrl) {
    throw new Error(`Invalid --site-url: ${options["site-url"]}`);
  }
  const sourceContext = (await fetchSourceContext(sourceUrl)) || {
    url: sourceUrl,
    title: null,
    description: null,
    pageText: null,
    palette: [],
    imageUrls: [],
    logoUrl: null,
  };
  const brand = String(options.brand || sourceContext?.title || deriveBrandLabel(topic)).trim();
  const pageMode = normalizePageMode(options["page-mode"]);
  const paletteOverride = normalizePaletteOverride(options.color);
  if (paletteOverride.length > 0) {
    sourceContext.palette = paletteOverride;
  }

  const startModel = String(options["start-model"] || DEFAULT_START_MODEL);
  const endModel = String(options["end-model"] || DEFAULT_END_MODEL);
  const videoModel = String(options["video-model"] || DEFAULT_VIDEO_MODEL);
  const duration = Number(options.duration || 5);
  const normalizedDuration = normalizeVideoDuration(duration);

  const searxngUrl = String(options["searxng-url"] || DEFAULT_SEARXNG_URL);
  const skipResearch = options["no-research"] === true;
  let research = null;

  if (!skipResearch) {
    console.log("Researching topic...");
    try {
      research = await researchTopic(topic, searxngUrl, sourceContext);
    } catch (researchError) {
      console.warn(`Research step failed: ${researchError.message}. Continuing with template content.`);
    }
  }

  const businessProfile = buildBusinessProfile(topic, brand, sourceContext, research);
  const defaults = createPrompts(businessProfile);
  const changeRequest = cleanOptionalString(options["change-request"]);
  const contentOverrides = cleanOptionalString(options["content-overrides"])
    ? JSON.parse(String(options["content-overrides"]))
    : null;
  const previewProfile = applyContentOverrides(buildContentProfile(businessProfile, pageMode), contentOverrides);
  const rawCinematicLayers = cleanOptionalString(options["cinematic-layers"])
    ? JSON.parse(String(options["cinematic-layers"]))
    : null;
  const rawExperienceUpgrades = cleanOptionalString(options["experience-upgrades"])
    ? JSON.parse(String(options["experience-upgrades"]))
    : null;
  const startPrompt = applyChangeRequest(String(options["start-prompt"] || defaults.startPrompt), changeRequest);
  const endPrompt = applyChangeRequest(String(options["end-prompt"] || defaults.endPrompt), changeRequest);
  const motionPrompt = applyChangeRequest(String(options["motion-prompt"] || defaults.motionPrompt), changeRequest);

  const metadata = {
    topic,
    brand,
    businessProfile,
    sourceUrl,
    siteUrl,
    pageMode,
    models: { startModel, endModel, videoModel },
    paletteOverride,
    changeRequest,
    editSourceSlug: cleanOptionalString(options["edit-source-slug"]),
    contentOverrides,
    experienceUpgrades: rawExperienceUpgrades,
    videoDurationSeconds: normalizedDuration,
    prompts: { startPrompt, endPrompt, motionPrompt },
    generatedAt: new Date().toISOString(),
  };

  let videoPath;
  let startImageUrl = null;
  let endImageUrl = null;
  let videoUrl = null;
  const startPath = join(mediaDir, "start-frame.webp");
  const endPath = join(mediaDir, "end-frame.webp");
  const outputVideoPath = join(mediaDir, "transition.mp4");
  const providedStartImage = cleanOptionalString(options["start-image"]);
  const providedEndImage = cleanOptionalString(options["end-image"]);
  const providedVideoUrl = cleanOptionalString(options["video-url"]);

  if (options["video-path"] || providedVideoUrl) {
    if (providedStartImage) {
      metadata.existingStartImage = await materializeImageAsset(providedStartImage, startPath);
    }
    if (providedEndImage) {
      metadata.existingEndImage = await materializeImageAsset(providedEndImage, endPath);
    }

    if (providedVideoUrl) {
      videoPath = outputVideoPath;
      await downloadToFile(providedVideoUrl, videoPath);
      metadata.usedExistingVideo = true;
      metadata.existingVideoUrl = providedVideoUrl;
      console.log(`Using existing video URL: ${providedVideoUrl}`);
    } else {
      videoPath = resolve(String(options["video-path"]));
      if (!existsSync(videoPath)) {
        throw new Error(`--video-path not found: ${videoPath}`);
      }
      metadata.usedExistingVideo = true;
      metadata.existingVideoPath = videoPath;
      console.log(`Using existing video: ${videoPath}`);
    }

    if (!providedStartImage || !providedEndImage) {
      console.log("Deriving edge frames from provided video...");
      extractVideoEdgeFrames(
        videoPath,
        providedStartImage ? null : startPath,
        providedEndImage ? null : endPath
      );
      if (!providedStartImage) metadata.derivedStartImageFromVideo = true;
      if (!providedEndImage) metadata.derivedEndImageFromVideo = true;
    }
  } else {
    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      throw new Error("FAL_KEY environment variable is required when --video-path is not provided.");
    }

    if (providedStartImage) {
      metadata.existingStartImage = await materializeImageAsset(providedStartImage, startPath);
      startImageUrl = isValidHttpUrl(metadata.existingStartImage) ? metadata.existingStartImage : null;
      console.log(`Using existing start image: ${metadata.existingStartImage}`);
    } else {
      console.log(`Generating start frame with ${startModel}...`);
      const startResult = await runFalWithInputVariants(
        startModel,
        [
          {
            prompt: startPrompt,
            num_images: 1,
            aspect_ratio: "16:9",
            resolution: "1K",
            output_format: "png",
            limit_generations: true,
          },
          {
            prompt: startPrompt,
            num_images: 1,
            aspect_ratio: "16:9",
            output_format: "png",
          },
        ],
        falKey,
        "start frame"
      );
      startImageUrl = pickImageUrl(startResult);
      await downloadImageAsWebp(startImageUrl, startPath);
    }

    if (providedEndImage) {
      metadata.existingEndImage = await materializeImageAsset(providedEndImage, endPath);
      endImageUrl = isValidHttpUrl(metadata.existingEndImage) ? metadata.existingEndImage : null;
      console.log(`Using existing end image: ${metadata.existingEndImage}`);
    } else {
      const startImageInput = startImageUrl || imagePathToDataUri(startPath);
      console.log(`Generating end frame with ${endModel}...`);
      const endResult = await runFalWithInputVariants(
        endModel,
        [
          {
            prompt: endPrompt,
            image_urls: [startImageInput],
            num_images: 1,
            aspect_ratio: "16:9",
            resolution: "1K",
            output_format: "png",
            limit_generations: true,
          },
          {
            prompt: endPrompt,
            image_url: startImageInput,
            num_images: 1,
            aspect_ratio: "16:9",
            output_format: "png",
          },
          {
            prompt: endPrompt,
            image_urls: [startImageInput],
            num_images: 1,
            output_format: "png",
          },
        ],
        falKey,
        "end frame"
      );
      endImageUrl = pickImageUrl(endResult);
      await downloadImageAsWebp(endImageUrl, endPath);
    }

    console.log(`Generating transition video with ${videoModel}...`);
    const videoResult = await runFalWithInputVariants(
      videoModel,
      [
        {
          prompt: motionPrompt,
          start_image_url: startImageUrl || imagePathToDataUri(startPath),
          end_image_url: endImageUrl || imagePathToDataUri(endPath),
          duration: normalizedDuration,
          generate_audio: false,
        },
        {
          prompt: motionPrompt,
          image_url: startImageUrl || imagePathToDataUri(startPath),
          duration: normalizedDuration,
          generate_audio: false,
        },
        {
          prompt: motionPrompt,
          start_image_url: startImageUrl || imagePathToDataUri(startPath),
          duration: normalizedDuration,
          generate_audio: false,
        },
      ],
      falKey,
      "video"
    );
    videoUrl = pickVideoUrl(videoResult);
    videoPath = outputVideoPath;

    console.log("Downloading media assets...");
    await downloadToFile(videoUrl, videoPath);
  }

  console.log("Extracting frames...");
  const extraction = runFrameExtraction(videoPath, framesDir);

  const cinematicLayers = await materializeCinematicLayers(rawCinematicLayers, mediaDir, previewProfile.sections.length);

  console.log("Scaffolding website...");
  const scaffold = writeScaffoldFiles({
    siteDir,
    topic,
    brand,
    pageMode,
    frameCount: extraction.frameCount,
    frameExtension: extraction.frameExtension,
    research,
    sourceContext,
    contentOverrides,
    siteUrl,
    cinematicLayers,
    experienceUpgrades: rawExperienceUpgrades,
  });

  metadata.startImageUrl = startImageUrl;
  metadata.endImageUrl = endImageUrl;
  metadata.videoUrl = videoUrl;
  metadata.localVideo = videoPath;
  metadata.videoMeta = extraction.metadata;
  metadata.frameExtraction = extraction.settings;
  metadata.frameCount = extraction.frameCount;
  metadata.frameExtension = extraction.frameExtension;
  metadata.category = scaffold.category;
  metadata.sectionKinds = scaffold.sectionKinds;
  metadata.trustLine = scaffold.trustLine;
  metadata.editableContent = scaffold.editableContent;
  metadata.cinematicLayers = scaffold.cinematicLayers;
  metadata.experienceUpgrades = scaffold.experienceUpgrades;
  metadata.seo = scaffold.seo;
  metadata.sourceContext = sourceContext;
  metadata.research = research || {
    category: scaffold.category,
    summary: null,
    facts: [],
    proofPoints: [],
    faqCandidates: [],
    sources: [],
    coverage: { snippetCount: 0, attributeCount: 0, sourceCount: 0, factCount: 0 },
    confidence: "low",
    inferredFallbackUsed: true,
    researchedFields: [],
  };

  if (options.qa === true) {
    console.log("Running Playwright QA...");
    metadata.qa = runPlaywrightQa({ siteDir, sourceContext });
  }

  writeFileSync(join(siteDir, "pipeline-metadata.json"), JSON.stringify(metadata, null, 2));

  console.log("");
  console.log("Done.");
  console.log(`Site folder: ${siteDir}`);
  console.log(`Frames: ${extraction.frameCount}`);
  console.log(`Preview: cd ${siteDir} && python3 -m http.server 8000`);
  console.log(`Open: http://localhost:8000`);
  console.log(`Main file: ${join(siteDir, "index.html")}`);
  if (startImageUrl && endImageUrl && videoUrl) {
    console.log(`Source URLs:`);
    console.log(`  Start image: ${startImageUrl}`);
    console.log(`  End image:   ${endImageUrl}`);
    console.log(`  Video:       ${videoUrl}`);
  } else {
    console.log(`Video source: ${basename(videoPath)}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
