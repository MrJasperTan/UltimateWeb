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
  --video-path       Existing video path; skips fal media generation
  --start-prompt     Override first-frame prompt
  --end-prompt       Override last-frame prompt
  --motion-prompt    Override video motion prompt
  --start-model      Override start image model
  --end-model        Override end image model
  --video-model      Override video model
  --duration         Video duration seconds (default: 5)
  --page-mode        Site mode: conversion, editorial, or hybrid (default: conversion)
  --searxng-url      SearXNG instance URL for topic research (default: http://192.168.0.166:8888)
  --no-research       Skip topic research step
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

function normalizePageMode(rawMode) {
  const mode = String(rawMode || "conversion").trim().toLowerCase();
  if (!PAGE_MODES.has(mode)) {
    throw new Error(`Invalid --page-mode "${rawMode}". Expected one of: conversion, editorial, hybrid.`);
  }
  return mode;
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

const DEFAULT_SEARXNG_URL = "http://192.168.0.166:8888";

async function researchTopic(topic, searxngUrl) {
  const queries = [
    `${topic} specifications features`,
    `${topic} review details`,
    `${topic} facts stats`,
  ];

  const allResults = [];
  const sources = [];

  for (const query of queries) {
    try {
      const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo,brave,startpage,wikipedia`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const results = data.results.slice(0, 5);
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
  research.category = detectCategory(topic);
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

function buildResearchSummary(topic, snippets) {
  const best = pickBestSnippet({ snippets }, 240);
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

  return null;
}

function extractNumber(text, regex) {
  const match = text.match(regex);
  return match ? match[1].replace(/,/g, "") : null;
}

function pickBestSnippet(research, maxLen) {
  if (!research || !research.snippets || research.snippets.length === 0) return null;
  // Return the longest snippet up to maxLen as it likely has the most info
  const sorted = [...research.snippets].sort((a, b) => b.length - a.length);
  const best = sorted[0];
  return best.length > maxLen ? best.slice(0, maxLen) + "..." : best;
}

function detectCategory(topic) {
  if (/(corvette|stingray|car|supercar|vehicle|sedan|truck|automotive|auto|tesla|porsche|ferrari|lamborghini|bmw|mercedes|mustang|camaro|mclaren|bugatti|aston\s*martin)/i.test(topic)) {
    return "car";
  }
  if (/(city|town|village|country|island|mountain|lake|river|park|monument|landmark|tower|bridge|canyon|beach|resort|temple|palace|cathedral|museum|airport|harbor|port|district|borough|prefecture|province|state of|tokyo|kyoto|osaka|paris|london|new york|los angeles|dubai|rome|venice|barcelona|amsterdam|berlin|sydney|singapore|hong kong|bangkok|istanbul|cairo|mumbai|delhi|beijing|shanghai|seattle|chicago|miami|las vegas|san francisco|hawaii|bali|maldives|santorini|machu picchu|grand canyon|niagara|yellowstone|yosemite|everest|kilimanjaro|alps|sahara|amazon|patagonia|japan|france|italy|spain|germany|australia|brazil|mexico|india|china|egypt|greece|thailand|vietnam|morocco|peru|argentina|colombia|portugal|turkey|iceland|norway|switzerland|austria|croatia|czech|ireland|scotland|england|canada|alaska|africa|europe|asia|antarctica)/i.test(topic)) {
    return "place";
  }
  // Common person indicators — names with titles, or well-known figure patterns
  if (/(dr\.?|mr\.?|mrs\.?|ms\.?|president|ceo|chef|coach|captain|king|queen|prince|princess|saint|st\.)/i.test(topic)) {
    return "person";
  }
  // If it looks like a proper name (2-4 capitalized words, no product-like terms)
  const words = topic.trim().split(/\s+/);
  const allCapitalized = words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z]/.test(w));
  const noProductWords = !/\d{4}|edition|pro|max|ultra|plus|series|model|version|gen\b/i.test(topic);
  if (allCapitalized && noProductWords) {
    return "person";
  }
  return "generic";
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
  const snippets = (research && research.snippets) || [];

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

function buildTheme(category) {
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

  return themes[category] || themes.generic;
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

function buildContentProfile(topic, brand, research, pageMode) {
  const category = detectCategory(topic);
  const researchStats = extractResearchStats(research, category);
  const bestSnippet = pickBestSnippet(research, 180);
  const dramatic = generateDramaticCopy(category, topic, brand, research);
  const features = buildFeaturesFromResearch(category, topic, research);
  const theme = buildTheme(category);
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

  return {
    category,
    pageMode,
    theme,
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
        ? `${research.sources.length} live sources informed the hero, proof, and spec sections.`
        : "Built with best-effort category research and premium design defaults.",
  };
}

function buildSectionTiming(count) {
  const start = 10;
  const end = 100;
  const span = (end - start) / count;
  return Array.from({ length: count }, (_, index) => ({
    enter: Number((start + index * span).toFixed(2)),
    leave: Number((start + (index + 1) * span).toFixed(2)),
  }));
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

function renderSectionMarkup(section, timing, index, totalSections) {
  const alignClass = `align-${section.alignment || "left"}`;
  const commonAttrs = `class="scroll-section section-${escapeHtml(section.kind)} ${alignClass}" data-enter="${timing.enter}" data-leave="${timing.leave}" data-animation="${escapeHtml(section.animation || "fade-up")}"`;

  if (section.kind === "stats") {
    return `
    <section ${commonAttrs}>
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
      <div class="section-inner">
        <p class="section-label">${escapeHtml(section.label)}</p>
        <h2 class="section-heading">${escapeHtml(section.heading)}</h2>
        <p class="section-body">${escapeHtml(section.body)}</p>
        ${button}
      </div>
    </section>`;
}

function writeScaffoldFiles({ siteDir, topic, brand, pageMode, frameCount, frameExtension, research }) {
  const profile = buildContentProfile(topic, brand, research, pageMode);
  const headline = escapeHtml(topic.toUpperCase());
  const safeTopic = escapeHtml(topic);
  const safeBrand = escapeHtml(brand);
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
  const timings = buildSectionTiming(renderedSections.length);
  const sectionsHtml = renderedSections
    .map((section, index) => renderSectionMarkup(section, timings[index], index, renderedSections.length))
    .join("\n");
  const scrollHeight = Math.max(1300, 240 + renderedSections.length * 165);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTopic} | ${safeBrand}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=DM+Serif+Display:ital@0;1&family=Manrope:wght@400;500;700;800&family=Oswald:wght@500;700&family=Syne:wght@500;700;800&display=swap" rel="stylesheet" />
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
    <a href="#cta">${escapeHtml(profile.cta.headerCta)}</a>
  </header>

  <section class="hero-standalone">
    <p class="hero-kicker">${escapeHtml(profile.heroKicker)}</p>
    <h1>${headline}</h1>
    <p class="hero-sub">${escapeHtml(profile.heroSub)}</p>
    <p class="hero-trust">${escapeHtml(profile.trustLine)}</p>
  </section>

  <div class="canvas-wrap"><canvas id="canvas"></canvas></div>
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
  background:
    radial-gradient(circle at 18% 22%, var(--hero-glow) 0%, transparent 34%),
    radial-gradient(circle at 82% 16%, var(--hero-glow-alt) 0%, transparent 30%),
    linear-gradient(160deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 34%),
    linear-gradient(135deg, var(--bg) 0%, #030405 100%);
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

.hero-trust {
  max-width: 52ch;
  color: var(--accent-soft);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.74rem;
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
  height: var(--scroll-length, 1400vh);
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
.align-center { padding: 0 10vw; text-align: center; }

.section-inner {
  max-width: 40vw;
  display: grid;
  gap: 1rem;
}

.section-inner-wide {
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
  .align-left,
  .align-right,
  .align-center {
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
  return {
    category: profile.category,
    pageMode: profile.pageMode,
    sectionKinds: renderedSections.map((section) => section.kind),
    trustLine: profile.trustLine,
  };
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
  const category = detectCategory(topic);

  if (category === "person") {
    const startPrompt =
      `Cinematic portrait of ${topic}, dramatic studio lighting, dark moody background, ` +
      `editorial photography style, sharp focus on face and expression, no text, no logos, ultra detailed`;

    const endPrompt =
      `Same ${topic} subject. Show a dynamic action or iconic pose that captures their essence, ` +
      `dramatic lighting with motion blur accents, dark atmospheric background, ` +
      `no text, no logos, editorial photography, ultra detailed.`;

    const motionPrompt =
      `Cinematic portrait animation. Start from first frame. Smooth transition to the dynamic action pose. ` +
      `Elegant camera movement, dramatic lighting shifts, no sudden warping, no text, dark atmospheric background.`;

    return { startPrompt, endPrompt, motionPrompt };
  }

  if (category === "place") {
    const startPrompt =
      `Cinematic wide establishing shot of ${topic}, golden hour lighting, dramatic atmosphere, ` +
      `architectural detail, landscape photography, no people, no text, no logos, ultra detailed 8k`;

    const endPrompt =
      `Same ${topic} location, different dramatic perspective. Aerial or intimate detail view revealing ` +
      `hidden character of the place, atmospheric lighting, moody sky, ` +
      `no people, no text, no logos, landscape photography, ultra detailed.`;

    const motionPrompt =
      `Cinematic location reveal. Start from first frame. Smooth drone-like camera movement exploring the space. ` +
      `Atmospheric particles, shifting light, no sudden warping, no text, no people, cinematic landscape.`;

    return { startPrompt, endPrompt, motionPrompt };
  }

  // Car / product / generic
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
  const pageMode = normalizePageMode(options["page-mode"]);
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
    pageMode,
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

  const searxngUrl = String(options["searxng-url"] || DEFAULT_SEARXNG_URL);
  const skipResearch = options["no-research"] === true;
  let research = null;

  if (!skipResearch) {
    console.log("Researching topic...");
    try {
      research = await researchTopic(topic, searxngUrl);
    } catch (researchError) {
      console.warn(`Research step failed: ${researchError.message}. Continuing with template content.`);
    }
  }

  console.log("Scaffolding website...");
  const scaffold = writeScaffoldFiles({
    siteDir,
    topic,
    brand,
    pageMode,
    frameCount: extraction.frameCount,
    frameExtension: extraction.frameExtension,
    research,
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
