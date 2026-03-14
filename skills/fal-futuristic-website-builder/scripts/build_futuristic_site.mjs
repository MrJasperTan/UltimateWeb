#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_START_MODEL = "fal-ai/nano-banana-2";
const DEFAULT_END_MODEL = "fal-ai/nano-banana-2/edit";
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";
const FAL_BASE_URL = "https://queue.fal.run";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "../../..");

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
  --video-path       Existing video path; skips fal media generation
  --start-prompt     Override first-frame prompt
  --end-prompt       Override last-frame prompt
  --motion-prompt    Override video motion prompt
  --start-model      Override start image model
  --end-model        Override end image model
  --video-model      Override video model
  --duration         Video duration seconds (default: 5)
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
    options[key] = next;
    i += 1;
  }
  return options;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildContentProfile(topic, brand) {
  const isCar = /(corvette|stingray|car|supercar|vehicle|sedan|truck|automotive|auto)/i.test(topic);

  if (isCar) {
    return {
      heroKicker: "AERODYNAMIC FUTURE PERFORMANCE",
      heroSub: `From reveal frame to full road form, ${topic} fuses track-ready engineering with street precision.`,
      sectionOneLabel: "001 / Chassis",
      sectionOneHeading: "Carbon-Tuned Geometry",
      sectionOneBody: "Low center of gravity, structural stiffness, and aero-balanced surfaces keep handling sharp at every speed band.",
      sectionTwoLabel: "002 / Powertrain",
      sectionTwoHeading: "Precision V8 Delivery",
      sectionTwoBody: "Power is mapped for immediate response while maintaining control through corner exit, launch, and sustained acceleration.",
      stats: [
        { value: "495", decimals: "0", suffix: "hp", label: "Peak output" },
        { value: "2.9", decimals: "1", suffix: "s", label: "0-60 launch" },
        { value: "194", decimals: "0", suffix: "mph", label: "Top speed class" },
      ],
      ctaLabel: "003 / Configuration",
      ctaHeading: `Configure ${brand}`,
      ctaBody: `Choose performance package, wheel architecture, aero setup, and signature finish for your ${topic}.`,
      ctaButton: "Open Configurator",
    };
  }

  return {
    heroKicker: "FUTURE FORGED PRODUCT SYSTEM",
    heroSub: `${topic} is presented as a cinematic product journey, from first silhouette to fully activated form.`,
    sectionOneLabel: "001 / Form",
    sectionOneHeading: "Engineered Exterior Language",
    sectionOneBody: "Surface geometry, material choices, and contour flow are tuned for visual impact and functional performance.",
    sectionTwoLabel: "002 / Experience",
    sectionTwoHeading: "High-Response Interaction",
    sectionTwoBody: "Every touchpoint is designed for clarity, speed, and confident operation in demanding real-world use.",
    stats: [
      { value: "24", decimals: "0", suffix: "mo", label: "Product roadmap" },
      { value: "98.6", decimals: "1", suffix: "%", label: "Satisfaction target" },
      { value: "6", decimals: "0", suffix: "x", label: "Iteration velocity" },
    ],
    ctaLabel: "003 / Launch",
    ctaHeading: `Build With ${brand}`,
    ctaBody: `Define final configuration, deployment strategy, and rollout milestones for your ${topic} experience.`,
    ctaButton: "Start Project",
  };
}

function writeScaffoldFiles({ siteDir, topic, brand, frameCount, frameExtension }) {
  const profile = buildContentProfile(topic, brand);
  const headline = escapeHtml(topic.toUpperCase());
  const safeTopic = escapeHtml(topic);
  const safeBrand = escapeHtml(brand);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTopic} | ${safeBrand}</title>
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <div id="loader">
    <span class="loader-brand">${safeBrand}</span>
    <div class="loader-track"><div id="loader-bar"></div></div>
    <span id="loader-percent">0%</span>
  </div>

  <header class="site-header">
    <span class="brand">${safeBrand}</span>
    <a href="#cta">Configure</a>
  </header>

  <section class="hero-standalone">
    <p class="hero-kicker">${escapeHtml(profile.heroKicker)}</p>
    <h1>${headline}</h1>
    <p class="hero-sub">${escapeHtml(profile.heroSub)}</p>
  </section>

  <div class="canvas-wrap"><canvas id="canvas"></canvas></div>
  <div id="dark-overlay"></div>

  <div class="marquee-wrap" data-scroll-speed="-30">
    <p class="marquee-text">${headline} ${headline}</p>
  </div>

  <main id="scroll-container">
    <section class="scroll-section align-left" data-enter="20" data-leave="34" data-animation="slide-left">
      <div class="section-inner">
        <p class="section-label">${escapeHtml(profile.sectionOneLabel)}</p>
        <h2 class="section-heading">${escapeHtml(profile.sectionOneHeading)}</h2>
        <p class="section-body">${escapeHtml(profile.sectionOneBody)}</p>
      </div>
    </section>

    <section class="scroll-section align-right" data-enter="34" data-leave="50" data-animation="clip-reveal">
      <div class="section-inner">
        <p class="section-label">${escapeHtml(profile.sectionTwoLabel)}</p>
        <h2 class="section-heading">${escapeHtml(profile.sectionTwoHeading)}</h2>
        <p class="section-body">${escapeHtml(profile.sectionTwoBody)}</p>
      </div>
    </section>

    <section class="scroll-section section-stats" data-enter="50" data-leave="68" data-animation="stagger-up">
      <div class="stats-grid">
        <div class="stat">
          <span class="stat-number" data-value="${escapeHtml(profile.stats[0].value)}" data-decimals="${escapeHtml(profile.stats[0].decimals)}">0</span>
          <span class="stat-suffix">${escapeHtml(profile.stats[0].suffix)}</span>
          <span class="stat-label">${escapeHtml(profile.stats[0].label)}</span>
        </div>
        <div class="stat">
          <span class="stat-number" data-value="${escapeHtml(profile.stats[1].value)}" data-decimals="${escapeHtml(profile.stats[1].decimals)}">0</span>
          <span class="stat-suffix">${escapeHtml(profile.stats[1].suffix)}</span>
          <span class="stat-label">${escapeHtml(profile.stats[1].label)}</span>
        </div>
        <div class="stat">
          <span class="stat-number" data-value="${escapeHtml(profile.stats[2].value)}" data-decimals="${escapeHtml(profile.stats[2].decimals)}">0</span>
          <span class="stat-suffix">${escapeHtml(profile.stats[2].suffix)}</span>
          <span class="stat-label">${escapeHtml(profile.stats[2].label)}</span>
        </div>
      </div>
    </section>

    <section id="cta" class="scroll-section align-left" data-enter="68" data-leave="100" data-animation="fade-up" data-persist="true">
      <div class="section-inner">
        <p class="section-label">${escapeHtml(profile.ctaLabel)}</p>
        <h2 class="section-heading">${escapeHtml(profile.ctaHeading)}</h2>
        <p class="section-body">${escapeHtml(profile.ctaBody)}</p>
        <a class="cta-button" href="#">${escapeHtml(profile.ctaButton)}</a>
      </div>
    </section>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/lenis@1/dist/lenis.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/ScrollTrigger.min.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --bg: #070707;
  --bg-elevated: #101010;
  --text: #f3f3ee;
  --muted: #a3a39d;
  --accent: #e24a2b;
  --font-display: "Bebas Neue", "Arial Narrow", sans-serif;
  --font-body: "IBM Plex Sans", "Segoe UI", sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; background: var(--bg); color: var(--text); }
body { font-family: var(--font-body); overflow-x: hidden; }

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
.brand {
  color: #fff;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  font-size: 0.78rem;
}

.hero-standalone {
  height: 100vh;
  padding: clamp(1.4rem, 4vw, 4rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1.2rem;
  position: relative;
  z-index: 15;
  background: radial-gradient(circle at 20% 20%, #2c0e0b 0%, #070707 55%);
}

.hero-kicker {
  letter-spacing: 0.18em;
  font-size: 0.75rem;
  color: var(--muted);
}

h1 {
  font-family: var(--font-display);
  font-size: clamp(4rem, 14vw, 12rem);
  letter-spacing: 0.03em;
  line-height: 0.95;
}

.hero-sub {
  max-width: 54ch;
  color: #d2d2cc;
  font-size: clamp(1rem, 2vw, 1.3rem);
}

.canvas-wrap,
#dark-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.canvas-wrap {
  z-index: 5;
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
  height: 920vh;
  z-index: 20;
}

.scroll-section {
  position: absolute;
  width: 100%;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
}

.align-left { padding-left: 5vw; padding-right: 55vw; }
.align-right { padding-left: 55vw; padding-right: 5vw; }

.section-inner {
  max-width: 40vw;
  display: grid;
  gap: 1rem;
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
}

.section-stats {
  padding: 0 7vw;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

.stat {
  display: grid;
  gap: 0.5rem;
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
}

@media (max-width: 900px) {
  #scroll-container { height: 600vh; }
  .align-left,
  .align-right {
    padding-left: 7vw;
    padding-right: 7vw;
    text-align: center;
  }
  .section-inner {
    max-width: 86vw;
    margin-inline: auto;
    background: rgba(0, 0, 0, 0.58);
    padding: 1rem;
    border-radius: 0.5rem;
  }
  .stats-grid {
    grid-template-columns: 1fr;
    text-align: center;
  }
  .cta-button { justify-self: center; }
}
`;

  const js = `const FRAME_COUNT = ${frameCount};
const FRAME_SPEED = 2.0;
const FRAME_PATH = (index) => \`frames/frame_\${String(index + 1).padStart(4, "0")}.${frameExtension}\`;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const loader = document.getElementById("loader");
const loaderBar = document.getElementById("loader-bar");
const loaderPercent = document.getElementById("loader-percent");
const scrollContainer = document.getElementById("scroll-container");
const canvasWrap = document.querySelector(".canvas-wrap");
const hero = document.querySelector(".hero-standalone");
const darkOverlay = document.getElementById("dark-overlay");

const frames = new Array(FRAME_COUNT);
let loaded = 0;
let currentFrame = 0;

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
  const cw = canvas.width;
  const ch = canvas.height;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(cw / iw, ch / ih) * 0.86;
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function updateLoader() {
  const pct = Math.round((loaded / FRAME_COUNT) * 100);
  loaderBar.style.width = pct + "%";
  loaderPercent.textContent = pct + "%";
  if (loaded >= FRAME_COUNT) {
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
    }, 400);
    drawFrame(0);
  }
}

function preloadFrames() {
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    const img = new Image();
    img.onload = () => {
      frames[i] = img;
      loaded += 1;
      updateLoader();
      if (i === 0) drawFrame(0);
    };
    img.onerror = () => {
      loaded += 1;
      updateLoader();
    };
    img.src = FRAME_PATH(i);
  }
}

function setupSmoothScroll() {
  const lenis = new Lenis({
    duration: 1.2,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
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
        requestAnimationFrame(() => drawFrame(currentFrame));
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
        if (visible) tl.play();
        else if (!(persist && p > leave)) tl.reverse();
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
  const enter = 0.5;
  const leave = 0.68;
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
      canvasWrap.style.clipPath = \`circle(\${wipe * 75}% at 50% 50%)\`;
    }
  });
}

window.addEventListener("resize", () => {
  resizeCanvas();
  drawFrame(currentFrame);
});

resizeCanvas();
preloadFrames();
setupSmoothScroll();
placeSections();
setupFrameBinding();
setupSectionAnimations();
setupCounters();
setupMarquee();
setupDarkOverlay();
setupHeroTransition();
`;

  writeFileSync(join(siteDir, "index.html"), html);
  writeFileSync(join(siteDir, "css/style.css"), css);
  writeFileSync(join(siteDir, "js/app.js"), js);
}

function runFrameExtraction(videoPath, framesDir) {
  const metadata = readVideoMetadata(videoPath);
  const settings = chooseExtractionSettings(metadata);
  const vf = `fps=${settings.fps},scale=${settings.width}:-1`;

  const frameExtension = "png";
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vf", vf, "-c:v", "png", join(framesDir, `frame_%04d.${frameExtension}`)],
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

function createPrompts(topic) {
  const startPrompt =
    `Professional studio hero shot of ${topic}, centered, cinematic lighting, ` +
    `matte black seamless background, no logos, no text, no humans, no reflections, ultra detailed product photography`;

  const endPrompt =
    `Same ${topic} subject and camera angle. Show a futuristic deconstruction state with key components ` +
    `separated and suspended in a controlled exploded-view composition. Keep matte black seamless background, ` +
    `no logos, no text, no humans, no reflections, studio lighting, ultra detailed.`;

  const motionPrompt =
    `Cinematic product animation. Start from first frame. Move smoothly toward the final exploded-view composition. ` +
    `Controlled mechanical motion, no sudden warping, no camera shake, no text, no humans, black seamless background.`;

  return { startPrompt, endPrompt, motionPrompt };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const topic = String(options.topic || "").trim();
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

  const brand = String(options.brand || topic.split(" ").slice(0, 2).join(" ")).trim();
  const defaults = createPrompts(topic);
  const startPrompt = String(options["start-prompt"] || defaults.startPrompt);
  const endPrompt = String(options["end-prompt"] || defaults.endPrompt);
  const motionPrompt = String(options["motion-prompt"] || defaults.motionPrompt);

  const startModel = String(options["start-model"] || DEFAULT_START_MODEL);
  const endModel = String(options["end-model"] || DEFAULT_END_MODEL);
  const videoModel = String(options["video-model"] || DEFAULT_VIDEO_MODEL);
  const duration = Number(options.duration || 5);
  const normalizedDuration = normalizeVideoDuration(duration);

  const metadata = {
    topic,
    brand,
    models: { startModel, endModel, videoModel },
    videoDurationSeconds: normalizedDuration,
    prompts: { startPrompt, endPrompt, motionPrompt },
    generatedAt: new Date().toISOString(),
  };

  let videoPath;
  let startImageUrl = null;
  let endImageUrl = null;
  let videoUrl = null;

  if (options["video-path"]) {
    videoPath = resolve(String(options["video-path"]));
    if (!existsSync(videoPath)) {
      throw new Error(`--video-path not found: ${videoPath}`);
    }
    metadata.usedExistingVideo = true;
    metadata.existingVideoPath = videoPath;
    console.log(`Using existing video: ${videoPath}`);
  } else {
    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      throw new Error("FAL_KEY environment variable is required when --video-path is not provided.");
    }

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

    console.log(`Generating end frame with ${endModel}...`);
    const endResult = await runFalWithInputVariants(
      endModel,
      [
        {
          prompt: endPrompt,
          image_urls: [startImageUrl],
          num_images: 1,
          aspect_ratio: "16:9",
          resolution: "1K",
          output_format: "png",
          limit_generations: true,
        },
        {
          prompt: endPrompt,
          image_url: startImageUrl,
          num_images: 1,
          aspect_ratio: "16:9",
          output_format: "png",
        },
        {
          prompt: endPrompt,
          image_urls: [startImageUrl],
          num_images: 1,
          output_format: "png",
        },
      ],
      falKey,
      "end frame"
    );
    endImageUrl = pickImageUrl(endResult);

    console.log(`Generating transition video with ${videoModel}...`);
    const videoResult = await runFalWithInputVariants(
      videoModel,
      [
        {
          prompt: motionPrompt,
          start_image_url: startImageUrl,
          end_image_url: endImageUrl,
          duration: normalizedDuration,
          generate_audio: false,
        },
        {
          prompt: motionPrompt,
          image_url: startImageUrl,
          duration: normalizedDuration,
          generate_audio: false,
        },
        {
          prompt: motionPrompt,
          start_image_url: startImageUrl,
          duration: normalizedDuration,
          generate_audio: false,
        },
      ],
      falKey,
      "video"
    );
    videoUrl = pickVideoUrl(videoResult);

    const startPath = join(mediaDir, "start-frame.png");
    const endPath = join(mediaDir, "end-frame.png");
    videoPath = join(mediaDir, "transition.mp4");

    console.log("Downloading media assets...");
    await downloadToFile(startImageUrl, startPath);
    await downloadToFile(endImageUrl, endPath);
    await downloadToFile(videoUrl, videoPath);
  }

  console.log("Extracting frames...");
  const extraction = runFrameExtraction(videoPath, framesDir);

  console.log("Scaffolding website...");
  writeScaffoldFiles({
    siteDir,
    topic,
    brand,
    frameCount: extraction.frameCount,
    frameExtension: extraction.frameExtension,
  });

  metadata.startImageUrl = startImageUrl;
  metadata.endImageUrl = endImageUrl;
  metadata.videoUrl = videoUrl;
  metadata.localVideo = videoPath;
  metadata.videoMeta = extraction.metadata;
  metadata.frameExtraction = extraction.settings;
  metadata.frameCount = extraction.frameCount;
  metadata.frameExtension = extraction.frameExtension;
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
