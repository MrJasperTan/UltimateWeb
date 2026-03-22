const editorTitle = document.getElementById("editor-title");
const editorSubtitle = document.getElementById("editor-subtitle");
const statusText = document.getElementById("status-text");
const jobText = document.getElementById("job-text");
const publishButton = document.getElementById("publish-btn");
const experienceSettingsButton = document.getElementById("experience-settings-btn");
const cinematicLayersButton = document.getElementById("cinematic-layers-btn");
const seoSettingsButton = document.getElementById("seo-settings-btn");
const fullPreviewButton = document.getElementById("full-preview-btn");
const previewShell = document.getElementById("preview-shell");
const siteFrame = document.getElementById("site-frame");
const handleLayer = document.getElementById("handle-layer");
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalCloseButton = document.getElementById("modal-close-btn");
const modalCancelButton = document.getElementById("modal-cancel-btn");
const modalSaveButton = document.getElementById("modal-save-btn");
const experienceUpsellList = document.getElementById("experience-upsell-list");
const experiencePackageSummary = document.getElementById("experience-package-summary");

const configuredApiBase = String(window.ULTIMATEWEB_API_BASE || "").trim().replace(/\/+$/, "");
const urlParams = new URLSearchParams(window.location.search);
const siteSlug = String(urlParams.get("slug") || "").trim();

const EXPERIENCE_UPGRADES = [
  {
    name: "Guided Autoscroll",
    badge: "Attention Grabber",
    impact: "Forces the visitor to see the strongest moments first.",
    note: "Runs as a short guided mode and stops immediately when the user interacts.",
  },
  {
    name: "Immersive Audio",
    badge: "Atmosphere",
    impact: "Adds cinematic sound design, ambient music, or branded motion cues.",
    note: "Best shipped as optional audio with a clean sound-on entry point.",
  },
  {
    name: "3D Depth Parallax",
    badge: "Visual Pop",
    impact: "Creates a coming-out-of-the-screen effect with layered depth and motion.",
    note: "High perceived value without needing a heavy 3D production pipeline.",
  },
  {
    name: "Sticky Story Scenes",
    badge: "Premium Flow",
    impact: "Turns ordinary sections into paced full-screen scenes.",
    note: "Excellent for launches, hospitality, automotive, travel, and founder brands.",
  },
  {
    name: "Motion Typography",
    badge: "Editorial",
    impact: "Makes key messaging land harder with staged, scroll-linked text reveals.",
    note: "Useful when the copy needs to feel bold without redesigning the whole page.",
  },
  {
    name: "Smart Sticky CTA",
    badge: "Conversion",
    impact: "Keeps the primary action visible and adapts the call to action by section.",
    note: "Usually the easiest upsell to justify because it ties directly to leads.",
  },
];

let siteConfig = null;
let editableContent = null;
let mediaDraft = null;
let cinematicDraft = null;
let experienceDraft = null;
let seoDraft = null;
let activeModal = null;
let pollTimer = null;
let handleTimer = null;
let siteSourceHtml = "";
let siteSourcePreviewUrl = "";
const previewObjectUrls = new Set();
const inlineExperienceState = {
  frameWindow: null,
  guidedBootTimer: 0,
  guidedResumeTimer: 0,
  guidedRaf: 0,
  guidedActive: false,
  guidedDismissed: false,
  guidedStartedAt: 0,
  guidedPhase: "down",
  guidedOrigin: 0,
  guidedPauseUntil: 0,
  lastKnownScrollY: 0,
  guidedButton: null,
  soundButton: null,
  audioContext: null,
  audioNodes: [],
  audioPulseTimer: 0,
  audioEnabled: false,
  listenersBound: false,
};

function toApiUrl(path) {
  if (configuredApiBase) return `${configuredApiBase}${path}`;
  return path;
}

function toPublicAssetUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  if (configuredApiBase && path.startsWith("/")) return `${configuredApiBase}${path}`;
  return path;
}

function resolveAbsoluteUrl(path) {
  const value = String(path || "").trim();
  if (!value) return "";
  try {
    return new URL(value, configuredApiBase || window.location.origin).toString();
  } catch {
    return value;
  }
}

function getSitePreviewUrl(config) {
  const explicitUrl = String(config?.siteUrl || "").trim();
  const normalizedExplicitUrl = /^(undefined|null)$/i.test(explicitUrl) ? "" : explicitUrl;
  if (normalizedExplicitUrl) return toPublicAssetUrl(normalizedExplicitUrl);
  const fallbackSlug = String(config?.slug || siteSlug || "").trim();
  if (fallbackSlug) return toPublicAssetUrl(`/generated-sites/${encodeURIComponent(fallbackSlug)}/index.html`);
  return "";
}

function getPreviewBaseHref(previewUrl) {
  try {
    const url = new URL(resolveAbsoluteUrl(previewUrl));
    const pathname = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return resolveAbsoluteUrl(previewUrl);
  }
}

function rewritePreviewAssetUrls(html, previewUrl) {
  const baseHref = getPreviewBaseHref(previewUrl);
  return String(html || "")
    .replace(/(<link[^>]+href=["'])(?![a-z]+:|\/|#)([^"']+)(["'][^>]*>)/gi, `$1${baseHref}$2$3`)
    .replace(/(<script[^>]+src=["'])(?![a-z]+:|\/|#)([^"']+)(["'][^>]*>)/gi, `$1${baseHref}$2$3`)
    .replace(/(<img[^>]+src=["'])(?![a-z]+:|\/|#)([^"']+)(["'][^>]*>)/gi, `$1${baseHref}$2$3`)
    .replace(/(<source[^>]+src=["'])(?![a-z]+:|\/|#)([^"']+)(["'][^>]*>)/gi, `$1${baseHref}$2$3`)
    .replace(/(<video[^>]+src=["'])(?![a-z]+:|\/|#)([^"']+)(["'][^>]*>)/gi, `$1${baseHref}$2$3`);
}

function buildPreviewSrcdoc(html, previewUrl) {
  const baseHref = getPreviewBaseHref(previewUrl);
  const rewrittenHtml = rewritePreviewAssetUrls(html, previewUrl);
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  if (/<head[^>]*>/i.test(rewrittenHtml)) {
    return rewrittenHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${rewrittenHtml}</body></html>`;
}

async function apiFetch(path, options = {}) {
  return fetch(toApiUrl(path), {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
  });
  if (!response.ok) {
    throw new Error(`Failed to load preview (${response.status})`);
  }
  return response.text();
}

function upsertMetaTag(doc, attribute, key, content) {
  let selector = "";
  if (attribute === "name") selector = `meta[name="${key}"]`;
  if (attribute === "property") selector = `meta[property="${key}"]`;
  let node = selector ? doc.head.querySelector(selector) : null;
  if (!content) {
    node?.remove();
    return;
  }
  if (!node) {
    node = doc.createElement("meta");
    node.setAttribute(attribute, key);
    doc.head.appendChild(node);
  }
  node.setAttribute("content", content);
}

function upsertLinkTag(doc, rel, href) {
  let node = doc.head.querySelector(`link[rel="${rel}"]`);
  if (!href) {
    node?.remove();
    return;
  }
  if (!node) {
    node = doc.createElement("link");
    node.setAttribute("rel", rel);
    doc.head.appendChild(node);
  }
  node.setAttribute("href", href);
}

function buildStandalonePreviewCinematicLayers() {
  const serializeLayer = (layer) => ({
    enabled: Boolean(layer?.enabled),
    label: String(layer?.label || "").trim(),
    layout: String(layer?.layout || "card") === "full-background" ? "full-background" : "card",
    loopMode: String(layer?.loopMode || "loop") === "boomerang" ? "boomerang" : "loop",
    speed: Math.min(2.5, Math.max(0.25, Number(layer?.speed || 1) || 1)),
    parallax: Boolean(layer?.parallax),
    url: buildPreviewVideoUrl(layer) || "",
  });

  return {
    hero: serializeLayer(cinematicDraft?.hero),
    sections: Array.isArray(cinematicDraft?.sections) ? cinematicDraft.sections.map((layer) => serializeLayer(layer)) : [],
  };
}

function buildStandalonePreviewRuntimeScript(previewData) {
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
    .hero-cinematic-card.cinematic-parallax {
      transform-style: preserve-3d;
      transform:
        translate3d(calc(var(--parallax-x, 0) * 20px), calc(var(--scroll-shift-y, 0px) + var(--parallax-y, 0) * -18px), 70px)
        rotateX(calc(var(--parallax-y, 0) * -5deg))
        rotateY(calc(var(--parallax-x, 0) * 7deg));
    }
      .section-cinematic { top: 50%; transform: translateY(-50%); }
      .section-cinematic-card { width: min(34vw, 32rem); aspect-ratio: 16 / 10; }
    .section-cinematic-card.cinematic-parallax,
    .section-cinematic-center.cinematic-parallax {
      transform:
        translate3d(calc(var(--parallax-x, 0) * 16px), calc(-50% + var(--parallax-y, 0) * -14px), 48px)
        rotateX(calc(var(--parallax-y, 0) * -4deg))
        rotateY(calc(var(--parallax-x, 0) * 6deg));
    }
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
      .experience-controls {
        position: fixed;
        right: 1.25rem;
        bottom: 1.25rem;
        z-index: 55;
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        justify-content: end;
      }
      .experience-button {
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 999px;
        padding: 0.85rem 1.1rem;
        color: #fff;
        font: inherit;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05)),
          rgba(10,9,15,0.8);
        backdrop-filter: blur(14px);
        box-shadow: 0 18px 40px rgba(0,0,0,0.24);
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
      .scroll-section { isolation: isolate; }
      .section-inner { position: relative; z-index: 2; }
      @media (max-width: 900px) {
        .experience-controls {
          left: 0.9rem; right: 0.9rem; bottom: 0.9rem; justify-content: stretch;
        }
        .experience-button {
          flex: 1 1 0; text-align: center; padding: 0.8rem 0.9rem; font-size: 0.72rem;
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
      controls.appendChild(button);
    }
    if (settings.audio?.enabled && !controls.querySelector("[data-sound-toggle-btn]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "experience-button";
      button.setAttribute("data-sound-toggle-btn", "true");
      button.textContent = "Enable Sound";
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
    button.textContent = guidedModeActive ? "Guided Mode: On" : guidedModeDismissed ? "Resume Guided Mode" : "Guided Mode: Off";
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
        stopGuidedMode(button, false);
        return;
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
    const interrupt = () => {
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
        stopGuidedMode(button, true);
        scheduleGuidedResume(button);
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
    if (button) button.textContent = "Sound: On";
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
    if (button) button.textContent = "Enable Sound";
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

  function getSectionPlacementClass(sectionNode, layer) {
    if (layer.layout === "full-background") return "section-cinematic section-cinematic-full";
    if (sectionNode.classList.contains("align-right")) return "section-cinematic section-cinematic-card section-cinematic-left";
    if (sectionNode.classList.contains("align-center")) return "section-cinematic section-cinematic-card section-cinematic-center";
    return "section-cinematic section-cinematic-card section-cinematic-right";
  }

  function renderLayer(layer, options = {}) {
    if (!layer || !layer.enabled || !layer.url) return null;
    const wrapper = document.createElement("div");
    wrapper.className = options.type === "hero"
      ? "hero-cinematic " + (layer.layout === "full-background" ? "hero-cinematic-full" : "hero-cinematic-card")
      : getSectionPlacementClass(options.sectionNode, layer);
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
    return wrapper;
  }

  function applyContent() {
    const content = draft.editableContent || {};
    updateText(".hero-kicker", content.hero && content.hero.kicker);
    updateText(".hero-standalone h1", content.hero && content.hero.title);
    updateText(".hero-sub", content.hero && content.hero.sub);
    updateText(".hero-trust", content.hero && content.hero.trustLine);
    updateText(".marquee-text", content.marqueeText);
    updateText(".site-header a[href="#cta"]", content.cta && content.cta.headerCta);

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
      const heroLayer = renderLayer(layers.hero, { type: "hero" });
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

function injectStandalonePreviewRuntime(html, previewData) {
  const runtimeScript = buildStandalonePreviewRuntimeScript(previewData);
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${runtimeScript}</body>`);
  }
  return `${html}${runtimeScript}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, detail = "") {
  statusText.textContent = message;
  jobText.textContent = detail;
}

function ensureEditableContent(raw) {
  const content = raw || {};
  return {
    hero: {
      kicker: String(content.hero?.kicker || "").trim(),
      title: String(content.hero?.title || "").trim(),
      sub: String(content.hero?.sub || "").trim(),
      trustLine: String(content.hero?.trustLine || "").trim(),
    },
    marqueeText: String(content.marqueeText || "").trim(),
    sections: Array.isArray(content.sections)
      ? content.sections.map((section) => ({
          kind: String(section.kind || "copy").trim(),
          label: String(section.label || "").trim(),
          heading: String(section.heading || "").trim(),
          body: String(section.body || "").trim(),
          button: String(section.button || "").trim(),
          stats: Array.isArray(section.stats)
            ? section.stats.map((stat) => ({
                value: String(stat.value ?? "").trim(),
                decimals: String(stat.decimals ?? "0").trim() || "0",
                suffix: String(stat.suffix ?? "").trim(),
                label: String(stat.label ?? "").trim(),
              }))
            : [],
          cards: Array.isArray(section.cards)
            ? section.cards.map((card) => ({
                title: String(card.title || "").trim(),
                body: String(card.body || "").trim(),
              }))
            : [],
          items: Array.isArray(section.items)
            ? section.items.map((item) => ({
                question: String(item.question || "").trim(),
                answer: String(item.answer || "").trim(),
              }))
            : [],
        }))
      : [],
    cta: {
      label: String(content.cta?.label || "").trim(),
      heading: String(content.cta?.heading || "").trim(),
      body: String(content.cta?.body || "").trim(),
      button: String(content.cta?.button || "").trim(),
      headerCta: String(content.cta?.headerCta || "").trim(),
    },
  };
}

function ensureCinematicLayer(rawLayer, fallbackLabel) {
  const video = rawLayer?.video || {};
  return {
    enabled: Boolean(rawLayer?.enabled && video?.url),
    label: String(rawLayer?.label || fallbackLabel || "").trim(),
    layout: String(rawLayer?.layout || "card").trim() === "full-background" ? "full-background" : "card",
    loopMode: String(rawLayer?.loopMode || "loop").trim() === "boomerang" ? "boomerang" : "loop",
    speed: Number(rawLayer?.speed) > 0 ? Number(rawLayer.speed) : 1,
    parallax: Boolean(rawLayer?.parallax),
    sourceUrl: String(video?.url || "").trim(),
    filename: String(video?.filename || "").trim(),
    file: null,
  };
}

function ensureCinematicLayers(rawLayers, sections) {
  const sectionCount = Array.isArray(sections) ? sections.length : 0;
  return {
    hero: ensureCinematicLayer(rawLayers?.hero, "Hero"),
    sections: Array.from({ length: sectionCount }, (_, index) =>
      ensureCinematicLayer(rawLayers?.sections?.[index], getSectionDisplayLabel(sections[index], index))
    ),
  };
}

function resetMediaDraft() {
  mediaDraft = {
    startPrompt: siteConfig?.startPrompt || "",
    endPrompt: siteConfig?.endPrompt || "",
    videoPrompt: siteConfig?.videoPrompt || "",
    startImageFile: null,
    endImageFile: null,
    videoFile: null,
  };
}

function resetCinematicDraft() {
  releaseAllPreviewUrls();
  cinematicDraft = ensureCinematicLayers(siteConfig?.cinematicLayers, editableContent?.sections || []);
}

function ensureExperienceDraft(raw) {
  const guided = raw?.guidedScroll || {};
  const audio = raw?.audio || {};
  const depth = raw?.depthHero || {};
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

function resetExperienceDraft() {
  experienceDraft = ensureExperienceDraft(siteConfig?.experienceUpgrades);
}

function resetSeoDraft() {
  seoDraft = {
    publicSiteUrl: siteConfig?.publicSiteUrl || "",
  };
}

function extractSectionsFromPreview(frameDocument) {
  return Array.from(frameDocument.querySelectorAll(".scroll-section"))
    .filter((node) => node.id !== "cta")
    .map((node) => ({
      kind: String(node.dataset.editorKind || "copy").trim(),
      label: String(node.querySelector(".section-label")?.textContent || "").trim(),
      heading: String(node.querySelector(".section-heading")?.textContent || "").trim(),
      body: String(node.querySelector(".section-body")?.textContent || "").trim(),
      button: String(node.querySelector(".cta-button")?.textContent || "").trim(),
      stats: [],
      cards: [],
      items: [],
    }));
}

function openModal(config) {
  activeModal = config;
  modalTitle.textContent = config.title;
  modalBody.innerHTML = config.body;
  modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  activeModal = null;
  modalBody.innerHTML = "";
  modalBackdrop.classList.add("hidden");
}

function createTextField(name, label, value, rows = 3) {
  return `
    <label>
      <span>${label}</span>
      <textarea name="${name}" rows="${rows}">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function createFileField(name, label, note) {
  return `
    <label>
      <span>${label}</span>
      <input type="file" name="${name}" />
      <small>${note}</small>
    </label>
  `;
}

function createSelectField(name, label, value, options) {
  return `
    <label>
      <span>${label}</span>
      <select name="${name}">
        ${options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
      </select>
    </label>
  `;
}

function buildPreviewVideoUrl(layer) {
  if (layer?.file instanceof File) {
    if (!layer.previewObjectUrl) {
      layer.previewObjectUrl = URL.createObjectURL(layer.file);
      previewObjectUrls.add(layer.previewObjectUrl);
    }
    return layer.previewObjectUrl;
  }
  return toPublicAssetUrl(layer?.sourceUrl || "");
}

function revokeLayerPreviewUrl(layer) {
  if (!layer?.previewObjectUrl) return;
  URL.revokeObjectURL(layer.previewObjectUrl);
  previewObjectUrls.delete(layer.previewObjectUrl);
  layer.previewObjectUrl = "";
}

function releaseAllPreviewUrls() {
  previewObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  previewObjectUrls.clear();
}

function renderCinematicPreviewMedia(layer) {
  const previewUrl = buildPreviewVideoUrl(layer);
  if (!previewUrl) {
    return `<p>No cinematic video selected.</p>`;
  }
  return `<video src="${escapeHtml(previewUrl)}" controls muted playsinline></video>`;
}

function renderCinematicLayerEditor(slotKey, title, layer) {
  const reuseNote = layer.sourceUrl
    ? `Current video: ${escapeHtml(layer.filename || layer.sourceUrl.split("/").pop() || "configured asset")}`
    : "No current cinematic video configured.";
  return `
    <div class="stack-card${layer.enabled ? "" : " is-disabled"}">
      <label class="field-toggle">
        <input type="checkbox" name="enabled-${slotKey}" ${layer.enabled ? "checked" : ""} />
        <span>${escapeHtml(title)}</span>
      </label>
      ${renderCinematicPreviewMedia(layer)}
      <small>${reuseNote}</small>
      <div class="field-row compact">
        ${createSelectField(`layout-${slotKey}`, "Layout", layer.layout, [
          { value: "card", label: "Card" },
          { value: "full-background", label: "Full Background" },
        ])}
        ${createSelectField(`loopMode-${slotKey}`, "Playback", layer.loopMode, [
          { value: "loop", label: "Loop" },
          { value: "boomerang", label: "Boomerang" },
        ])}
        <label>
          <span>Speed</span>
          <input type="number" name="speed-${slotKey}" min="0.25" max="2.5" step="0.1" value="${escapeHtml(layer.speed || 1)}" />
        </label>
      </div>
      <label class="field-toggle">
        <input type="checkbox" name="parallax-${slotKey}" ${layer.parallax ? "checked" : ""} />
        <span>Parallax Depth</span>
      </label>
      <label>
        <span>Replace Video</span>
        <input type="file" name="video-${slotKey}" accept="video/*" />
        <small>Leave empty to keep the current video for this slot.</small>
      </label>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderExperienceUpsells() {
  if (!experienceUpsellList || !experiencePackageSummary) return;

  experienceUpsellList.innerHTML = EXPERIENCE_UPGRADES
    .map((upgrade) => `
      <button class="experience-upsell-item" type="button" data-open-experience-settings="true">
        <div class="experience-upsell-meta">
          <h3>${escapeHtml(upgrade.name)}</h3>
          <span class="experience-upsell-badge">${escapeHtml(upgrade.badge)}</span>
        </div>
        <p><strong>Impact:</strong> ${escapeHtml(upgrade.impact)}</p>
        <p>${escapeHtml(upgrade.note)}</p>
      </button>
    `)
    .join("");

  const siteName = String(editableContent?.hero?.title || siteConfig?.title || "this site").trim();
  experiencePackageSummary.innerHTML = `
    <span class="experience-package-badge">Signature Package</span>
    <h3>Sell the full motion stack</h3>
    <p><strong>Best bundle for ${escapeHtml(siteName)}:</strong> Guided Autoscroll, Immersive Audio, 3D Depth Parallax, Sticky Story Scenes, Motion Typography, and Smart Sticky CTA.</p>
    <p>Recommended workflow: sell the baseline build first, then upsell these as premium immersion and conversion upgrades.</p>
    <button class="experience-package-action" type="button" data-open-experience-settings="true">Configure Experience</button>
  `;

  experienceUpsellList.querySelectorAll("[data-open-experience-settings]").forEach((button) => {
    button.addEventListener("click", openExperienceModal);
  });
  experiencePackageSummary.querySelectorAll("[data-open-experience-settings]").forEach((button) => {
    button.addEventListener("click", openExperienceModal);
  });
}

function renderMediaCard(title, media, kind) {
  if (!media?.available) {
    return `<article class="media-card"><h3>${title}</h3><p>No current ${kind}.</p></article>`;
  }
  const mediaUrl = toPublicAssetUrl(media.url);
  const preview = kind === "video"
    ? `<video src="${mediaUrl}" controls muted playsinline></video>`
    : `<img src="${mediaUrl}" alt="${escapeHtml(title)}" />`;
  return `
    <article class="media-card">
      <h3>${title}</h3>
      <p>${escapeHtml(media.filename || "")}</p>
      ${preview}
    </article>
  `;
}

function openHeroModal() {
  const hero = editableContent.hero;
  openModal({
    type: "hero",
    title: "Hero",
    body: `
      <div class="field-grid">
        ${createTextField("kicker", "Kicker", hero.kicker, 2)}
        ${createTextField("title", "Title", hero.title, 2)}
        ${createTextField("sub", "Subtitle", hero.sub, 4)}
        ${createTextField("trustLine", "Trust Line", hero.trustLine, 3)}
      </div>
    `,
  });
}

function openMarqueeModal() {
  openModal({
    type: "marquee",
    title: "Scrolling Banner",
    body: `
      <div class="field-grid">
        ${createTextField("marqueeText", "Banner Text", editableContent.marqueeText, 3)}
      </div>
    `,
  });
}

function getSectionDisplayLabel(section, index) {
  const label = String(section?.label || "").trim();
  if (label) return label;
  const heading = String(section?.heading || "").trim();
  if (heading) return heading;
  return `Section ${index + 1}`;
}

function getSectionShortLabel(section, index) {
  const label = String(section?.label || "").trim();
  const leadingNumber = label.match(/^\d+/)?.[0];
  if (leadingNumber) return leadingNumber;
  return String(index + 1);
}

function openSectionModal(index) {
  const section = editableContent.sections[index];
  if (!section) return;
  let extraFields = "";

  if (section.kind === "stats") {
    extraFields = `
      <div class="stack-list">
        ${section.stats.map((stat, statIndex) => `
          <div class="stack-card">
            <p class="field-note">Stat ${statIndex + 1}</p>
            <div class="field-grid two-col">
              <label><span>Value</span><input type="text" name="stat-value-${statIndex}" value="${escapeHtml(stat.value)}" /></label>
              <label><span>Suffix</span><input type="text" name="stat-suffix-${statIndex}" value="${escapeHtml(stat.suffix)}" /></label>
            </div>
            <label><span>Label</span><input type="text" name="stat-label-${statIndex}" value="${escapeHtml(stat.label)}" /></label>
          </div>
        `).join("")}
      </div>
    `;
  } else if (section.kind === "cards") {
    extraFields = `
      <div class="stack-list">
        ${section.cards.map((card, cardIndex) => `
          <div class="stack-card">
            <p class="field-note">Card ${cardIndex + 1}</p>
            <label><span>Title</span><input type="text" name="card-title-${cardIndex}" value="${escapeHtml(card.title)}" /></label>
            ${createTextField(`card-body-${cardIndex}`, "Body", card.body, 4)}
          </div>
        `).join("")}
      </div>
    `;
  } else if (section.kind === "faq") {
    extraFields = `
      <div class="stack-list">
        ${section.items.map((item, itemIndex) => `
          <div class="stack-card">
            <p class="field-note">Question ${itemIndex + 1}</p>
            ${createTextField(`faq-question-${itemIndex}`, "Question", item.question, 3)}
            ${createTextField(`faq-answer-${itemIndex}`, "Answer", item.answer, 4)}
          </div>
        `).join("")}
      </div>
    `;
  }

  openModal({
    type: "section",
    index,
    title: getSectionDisplayLabel(section, index),
    body: `
      <div class="field-grid">
        ${createTextField("label", "Label", section.label, 2)}
        ${createTextField("heading", "Heading", section.heading, 3)}
        ${section.kind === "stats" || section.kind === "cards" || section.kind === "faq" ? "" : createTextField("body", "Body", section.body, 5)}
        ${section.kind === "cta" ? createTextField("button", "Button", section.button, 2) : ""}
      </div>
      ${extraFields}
    `,
  });
}

function openCtaModal() {
  const section = editableContent.cta;
  openModal({
    type: "cta",
    title: "Call To Action",
    body: `
      <div class="field-grid">
        ${createTextField("label", "Label", section.label, 2)}
        ${createTextField("heading", "Heading", section.heading, 3)}
        ${createTextField("body", "Body", section.body, 4)}
        ${createTextField("button", "Button", section.button, 2)}
        ${createTextField("headerCta", "Header Link", section.headerCta, 2)}
      </div>
    `,
  });
}

function openMediaModal() {
  openModal({
    type: "media",
    title: "Start, End, and Video Media",
    body: `
      <div class="media-preview-grid">
        ${renderMediaCard("Start image", siteConfig.media?.startImage, "image")}
        ${renderMediaCard("End image", siteConfig.media?.endImage, "image")}
        ${renderMediaCard("Video", siteConfig.media?.video, "video")}
      </div>
      <div class="field-grid">
        ${createTextField("startPrompt", "Start Image Prompt", mediaDraft.startPrompt, 4)}
        ${createTextField("endPrompt", "End Image Prompt", mediaDraft.endPrompt, 4)}
        ${createTextField("videoPrompt", "Video Prompt", mediaDraft.videoPrompt, 4)}
      </div>
      <div class="field-grid two-col">
        ${createFileField("startImage", "Replace Start Image", "Leave empty to keep the current start image.")}
        ${createFileField("endImage", "Replace End Image", "Leave empty to keep the current end image.")}
      </div>
      <div class="field-grid">
        ${createFileField("video", "Replace Video", "Leave empty to keep the current video.")}
      </div>
    `,
  });
}

function openSeoModal() {
  openModal({
    type: "seo",
    title: "SEO Settings",
    body: `
      <div class="field-grid">
        <label>
          <span>Public Site URL</span>
          <input type="url" name="publicSiteUrl" inputmode="url" placeholder="https://yourdomain.com/page/" value="${escapeHtml(seoDraft?.publicSiteUrl || "")}" />
          <small>Set this when the page has a real public URL. Every publish automatically refreshes canonical, robots, sitemap, and structured data.</small>
        </label>
      </div>
    `,
  });
}

function openExperienceModal() {
  openModal({
    type: "experience",
    title: "Experience Upgrades",
    body: `
      <div class="stack-list">
        <div class="stack-card">
          <label class="field-toggle">
            <input type="checkbox" name="guided-enabled" ${experienceDraft.guidedScroll.enabled ? "checked" : ""} />
            <span>Guided Autoscroll</span>
          </label>
          <p class="field-note">Use this for cinematic pass-through experiences. Apply Changes updates the editor preview, and publish carries the same settings into the next edited version.</p>
          <div class="field-grid two-col">
            <label><span>Start Delay (seconds)</span><input type="number" name="guided-delay" min="0" step="0.25" value="${escapeHtml((experienceDraft.guidedScroll.initialDelayMs / 1000).toFixed(2))}" /></label>
            <label><span>Resume Delay (seconds)</span><input type="number" name="guided-resume-delay" min="0.25" step="0.25" value="${escapeHtml((experienceDraft.guidedScroll.resumeDelayMs / 1000).toFixed(2))}" /></label>
            <label><span>Scroll Down Duration (seconds)</span><input type="number" name="guided-down-duration" min="5" step="0.25" value="${escapeHtml((experienceDraft.guidedScroll.downDurationMs / 1000).toFixed(2))}" /></label>
            <label><span>Return Duration (seconds)</span><input type="number" name="guided-up-duration" min="3" step="0.25" value="${escapeHtml((experienceDraft.guidedScroll.upDurationMs / 1000).toFixed(2))}" /></label>
            <label><span>End Pause (seconds)</span><input type="number" name="guided-end-pause" min="0" step="0.25" value="${escapeHtml((experienceDraft.guidedScroll.endPauseMs / 1000).toFixed(2))}" /></label>
          </div>
        </div>
        <div class="stack-card">
          <label class="field-toggle">
            <input type="checkbox" name="audio-enabled" ${experienceDraft.audio.enabled ? "checked" : ""} />
            <span>Immersive Audio Toggle</span>
          </label>
          <p class="field-note">Adds an optional ambient sound layer with a visitor-controlled sound button.</p>
        </div>
        <div class="stack-card">
          <label class="field-toggle">
            <input type="checkbox" name="depth-enabled" ${experienceDraft.depthHero.enabled ? "checked" : ""} />
            <span>3D Depth Hero</span>
          </label>
          <p class="field-note">Enables layered hero depth, motion response, and added visual pop on the final page.</p>
        </div>
      </div>
    `,
  });
}

function openCinematicModal() {
  const sectionsMarkup = cinematicDraft.sections
    .map((layer, index) =>
      renderCinematicLayerEditor(`section-${index}`, getSectionDisplayLabel(editableContent.sections[index], index), layer)
    )
    .join("");

  openModal({
    type: "cinematic",
    title: "Cinematic Layers",
    body: `
      <div class="stack-list">
        ${renderCinematicLayerEditor("hero", "Hero", cinematicDraft.hero)}
        ${sectionsMarkup}
      </div>
      <p class="field-note">These motion layers preserve the existing copy and layout. Publishing creates a new cinematic version with the selected video treatment.</p>
    `,
  });
}

function applyModalChanges() {
  if (!activeModal) return;
  const formData = new FormData();
  modalBody.querySelectorAll("input, textarea, select").forEach((field) => {
    if (!field.name) return;
    if (field.type === "file") {
      if (field.files?.[0]) formData.append(field.name, field.files[0]);
      return;
    }
    if (field.type === "checkbox") {
      if (field.checked) formData.append(field.name, "on");
      return;
    }
    formData.append(field.name, field.value);
  });

  if (activeModal.type === "hero") {
    editableContent.hero.kicker = String(formData.get("kicker") || "").trim();
    editableContent.hero.title = String(formData.get("title") || "").trim();
    editableContent.hero.sub = String(formData.get("sub") || "").trim();
    editableContent.hero.trustLine = String(formData.get("trustLine") || "").trim();
  }

  if (activeModal.type === "marquee") {
    editableContent.marqueeText = String(formData.get("marqueeText") || "").trim();
  }

  if (activeModal.type === "section") {
    const section = editableContent.sections[activeModal.index];
    section.label = String(formData.get("label") || "").trim();
    section.heading = String(formData.get("heading") || "").trim();
    if (formData.has("body")) section.body = String(formData.get("body") || "").trim();
    if (formData.has("button")) section.button = String(formData.get("button") || "").trim();
    section.stats.forEach((stat, index) => {
      stat.value = String(formData.get(`stat-value-${index}`) || "").trim();
      stat.suffix = String(formData.get(`stat-suffix-${index}`) || "").trim();
      stat.label = String(formData.get(`stat-label-${index}`) || "").trim();
    });
    section.cards.forEach((card, index) => {
      card.title = String(formData.get(`card-title-${index}`) || "").trim();
      card.body = String(formData.get(`card-body-${index}`) || "").trim();
    });
    section.items.forEach((item, index) => {
      item.question = String(formData.get(`faq-question-${index}`) || "").trim();
      item.answer = String(formData.get(`faq-answer-${index}`) || "").trim();
    });
  }

  if (activeModal.type === "cta") {
    editableContent.cta.label = String(formData.get("label") || "").trim();
    editableContent.cta.heading = String(formData.get("heading") || "").trim();
    editableContent.cta.body = String(formData.get("body") || "").trim();
    editableContent.cta.button = String(formData.get("button") || "").trim();
    editableContent.cta.headerCta = String(formData.get("headerCta") || "").trim();
  }

  if (activeModal.type === "media") {
    mediaDraft.startPrompt = String(formData.get("startPrompt") || "").trim();
    mediaDraft.endPrompt = String(formData.get("endPrompt") || "").trim();
    mediaDraft.videoPrompt = String(formData.get("videoPrompt") || "").trim();
    mediaDraft.startImageFile = formData.get("startImage") instanceof File ? formData.get("startImage") : null;
    mediaDraft.endImageFile = formData.get("endImage") instanceof File ? formData.get("endImage") : null;
    mediaDraft.videoFile = formData.get("video") instanceof File ? formData.get("video") : null;
  }

  if (activeModal.type === "cinematic") {
    const applyLayerChanges = (slotKey, target) => {
      const nextFile = formData.get(`video-${slotKey}`);
      target.enabled = formData.get(`enabled-${slotKey}`) === "on";
      target.layout = String(formData.get(`layout-${slotKey}`) || "card").trim() === "full-background" ? "full-background" : "card";
      target.loopMode = String(formData.get(`loopMode-${slotKey}`) || "loop").trim() === "boomerang" ? "boomerang" : "loop";
      target.speed = Math.min(2.5, Math.max(0.25, Number(formData.get(`speed-${slotKey}`) || 1) || 1));
      target.parallax = formData.get(`parallax-${slotKey}`) === "on";
      if (nextFile instanceof File && nextFile.size > 0) {
        revokeLayerPreviewUrl(target);
        target.file = nextFile;
        target.filename = nextFile.name;
      }
      if (!target.enabled) {
        revokeLayerPreviewUrl(target);
        target.file = null;
      }
    };

    applyLayerChanges("hero", cinematicDraft.hero);
    cinematicDraft.sections.forEach((layer, index) => {
      applyLayerChanges(`section-${index}`, layer);
    });
    setStatus("Cinematic layer settings updated.", "Publish to generate the new motion-enhanced version.");
  }

  if (activeModal.type === "seo") {
    seoDraft.publicSiteUrl = String(formData.get("publicSiteUrl") || "").trim();
  }

  if (activeModal.type === "experience") {
    experienceDraft.guidedScroll.enabled = formData.get("guided-enabled") === "on";
    experienceDraft.guidedScroll.initialDelayMs = Math.max(0, (Number(formData.get("guided-delay") || 6) || 6) * 1000);
    experienceDraft.guidedScroll.resumeDelayMs = Math.max(250, (Number(formData.get("guided-resume-delay") || 2) || 2) * 1000);
    experienceDraft.guidedScroll.downDurationMs = Math.max(5000, (Number(formData.get("guided-down-duration") || 112.5) || 112.5) * 1000);
    experienceDraft.guidedScroll.upDurationMs = Math.max(3000, (Number(formData.get("guided-up-duration") || 56.25) || 56.25) * 1000);
    experienceDraft.guidedScroll.endPauseMs = Math.max(0, (Number(formData.get("guided-end-pause") || 3) || 3) * 1000);
    experienceDraft.audio.enabled = formData.get("audio-enabled") === "on";
    experienceDraft.depthHero.enabled = formData.get("depth-enabled") === "on";
    setStatus("Experience upgrade settings updated.", "These settings are applied when you publish the next edited version.");
  }

  applyPreview();
  closeModal();
}

function updateElementText(element, value) {
  if (element) element.textContent = value;
}

function ensureCinematicPreviewStyles(frameDocument) {
  if (!frameDocument || frameDocument.getElementById("uw-editor-cinematic-preview-style")) return;
  const style = frameDocument.createElement("style");
  style.id = "uw-editor-cinematic-preview-style";
  style.textContent = `
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
    .hero-cinematic-card.cinematic-parallax {
      transform-style: preserve-3d;
      transform:
        translate3d(calc(var(--parallax-x, 0) * 20px), calc(var(--scroll-shift-y, 0px) + var(--parallax-y, 0) * -18px), 70px)
        rotateX(calc(var(--parallax-y, 0) * -5deg))
        rotateY(calc(var(--parallax-x, 0) * 7deg));
    }
    .section-cinematic { top: 50%; transform: translateY(-50%); }
    .section-cinematic-card { width: min(34vw, 32rem); aspect-ratio: 16 / 10; }
    .section-cinematic-card.cinematic-parallax,
    .section-cinematic-center.cinematic-parallax {
      transform:
        translate3d(calc(var(--parallax-x, 0) * 16px), calc(-50% + var(--parallax-y, 0) * -14px), 48px)
        rotateX(calc(var(--parallax-y, 0) * -4deg))
        rotateY(calc(var(--parallax-x, 0) * 6deg));
    }
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
    .scroll-section { isolation: isolate; }
    .section-inner { position: relative; z-index: 2; }
    @media (max-width: 900px) {
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
    }
  `;
  frameDocument.head.appendChild(style);
}

function ensureExperiencePreviewStyles(frameDocument) {
  if (!frameDocument || frameDocument.getElementById("uw-editor-experience-preview-style")) return;
  const style = frameDocument.createElement("style");
  style.id = "uw-editor-experience-preview-style";
  style.textContent = `
    body.guided-mode-active { cursor: ns-resize; }
    .experience-controls {
      position: fixed;
      right: 1.25rem;
      bottom: 1.25rem;
      z-index: 55;
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      justify-content: end;
    }
    .experience-button {
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 999px;
      padding: 0.85rem 1.1rem;
      color: #fff;
      font: inherit;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05)),
        rgba(10,9,15,0.8);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0,0,0,0.24);
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
    .hero-cinematic-card,
    .hero-frame-stage {
      transform-style: preserve-3d;
      transform:
        translate3d(calc(var(--depth-x, 0) * 20px), calc(var(--scroll-shift-y, 0px) + var(--depth-y, 0) * -18px), 70px)
        rotateX(calc(var(--depth-y, 0) * -5deg))
        rotateY(calc(var(--depth-x, 0) * 7deg));
    }
    @media (max-width: 900px) {
      .experience-controls {
        left: 0.9rem; right: 0.9rem; bottom: 0.9rem; justify-content: stretch;
      }
      .experience-button {
        flex: 1 1 0; text-align: center; padding: 0.8rem 0.9rem; font-size: 0.72rem;
      }
      .hero-standalone { perspective: none; }
      .hero-depth-grid { opacity: 0.75; }
      .hero-frame-stage { transform: none; }
    }
  `;
  frameDocument.head.appendChild(style);
}

function setupPreviewCinematicVideo(video) {
  if (!video || video.dataset.editorCinematicBound === "true") return;
  video.dataset.editorCinematicBound = "true";
  const loopMode = String(video.dataset.loopMode || "loop");
  const speed = Math.min(2.5, Math.max(0.25, Number(video.dataset.playbackSpeed || 1) || 1));
  let reversing = false;
  let reverseFrame = 0;
  let lastTick = 0;

  const stopReverse = () => {
    if (reverseFrame) cancelAnimationFrame(reverseFrame);
    reverseFrame = 0;
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
      if (reversing) stopReverse();
    });
  }
}

function getSectionCinematicPlacementClass(sectionNode, layer) {
  if (layer.layout === "full-background") return "section-cinematic section-cinematic-full";
  if (sectionNode.classList.contains("align-right")) return "section-cinematic section-cinematic-card section-cinematic-left";
  if (sectionNode.classList.contains("align-center")) return "section-cinematic section-cinematic-card section-cinematic-center";
  return "section-cinematic section-cinematic-card section-cinematic-right";
}

function setupPreviewParallax(wrapper, hostNode) {
  if (!wrapper || !hostNode || wrapper.dataset.editorParallaxBound === "true") return;
  wrapper.dataset.editorParallaxBound = "true";

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

function renderPreviewCinematicLayer(frameDocument, layer, options = {}) {
  if (!layer?.enabled) return null;
  const wrapper = frameDocument.createElement("div");
  wrapper.className = options.type === "hero"
    ? `hero-cinematic ${layer.layout === "full-background" ? "hero-cinematic-full" : "hero-cinematic-card"}`
    : getSectionCinematicPlacementClass(options.sectionNode, layer);
  if (layer.parallax) wrapper.classList.add("cinematic-parallax");
  if (options.index !== undefined) wrapper.dataset.cinematicLayer = String(options.index);
  const video = frameDocument.createElement("video");
  video.className = "cinematic-video";
  video.setAttribute("data-cinematic-video", "true");
  video.dataset.loopMode = layer.loopMode || "loop";
  video.dataset.playbackSpeed = String(layer.speed || 1);
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const source = frameDocument.createElement("source");
  source.src = buildPreviewVideoUrl(layer);
  source.type = /\.webm$/i.test(source.src) ? "video/webm" : /\.ogg$/i.test(source.src) ? "video/ogg" : "video/mp4";
  video.appendChild(source);
  wrapper.appendChild(video);
  setupPreviewCinematicVideo(video);
  if (layer.parallax) {
    setupPreviewParallax(wrapper, options.type === "hero" ? options.hostNode : options.sectionNode);
  }
  return wrapper;
}

function toggleLegacyHeroMedia(frameDocument, enabled) {
  const nodes = [
    frameDocument.querySelector(".hero-standalone .hero-frame-stage"),
    frameDocument.querySelector(".hero-standalone .hero-depth-grid"),
    frameDocument.querySelector(".video-stage"),
  ].filter(Boolean);

  nodes.forEach((node) => {
    if (!node.dataset.editorOriginalDisplay) {
      node.dataset.editorOriginalDisplay = node.style.display || "";
    }
    node.style.display = enabled ? "none" : node.dataset.editorOriginalDisplay;
  });
}

function applyCinematicPreview(frameDocument) {
  ensureCinematicPreviewStyles(frameDocument);

  const heroNode = frameDocument.querySelector(".hero-standalone");
  if (heroNode) {
    heroNode.querySelectorAll(".hero-cinematic").forEach((node) => node.remove());
    const heroLayer = renderPreviewCinematicLayer(frameDocument, cinematicDraft.hero, { type: "hero", hostNode: heroNode });
    toggleLegacyHeroMedia(frameDocument, Boolean(cinematicDraft.hero?.enabled));
    if (heroLayer) {
      heroNode.insertBefore(heroLayer, heroNode.firstChild);
    }
  }

  const sectionNodes = Array.from(frameDocument.querySelectorAll(".scroll-section")).filter((node) => node.id !== "cta");
  sectionNodes.forEach((sectionNode, index) => {
    sectionNode.querySelectorAll(".section-cinematic").forEach((node) => node.remove());
    const layer = cinematicDraft.sections[index];
    const cinematicNode = renderPreviewCinematicLayer(frameDocument, layer, { sectionNode, index });
    if (cinematicNode) {
      sectionNode.insertBefore(cinematicNode, sectionNode.firstChild);
    }
  });
}

function stopInlinePreviewAudio(frameWindow, button = inlineExperienceState.soundButton) {
  if (inlineExperienceState.audioPulseTimer) frameWindow.clearInterval(inlineExperienceState.audioPulseTimer);
  inlineExperienceState.audioPulseTimer = 0;
  inlineExperienceState.audioNodes.forEach((node) => {
    try { if (typeof node.stop === "function") node.stop(); } catch {}
    try { if (typeof node.disconnect === "function") node.disconnect(); } catch {}
  });
  inlineExperienceState.audioNodes = [];
  inlineExperienceState.audioEnabled = false;
  if (button) button.textContent = "Enable Sound";
}

function updateInlineGuidedModeUi(frameDocument) {
  if (inlineExperienceState.guidedButton) {
    inlineExperienceState.guidedButton.textContent = inlineExperienceState.guidedActive
      ? "Guided Mode: On"
      : inlineExperienceState.guidedDismissed
        ? "Resume Guided Mode"
        : "Guided Mode: Off";
  }
  frameDocument.body.classList.toggle("guided-mode-active", inlineExperienceState.guidedActive);
}

function stopInlineGuidedMode(frameDocument, markDismissed = true) {
  const frameWindow = frameDocument.defaultView;
  inlineExperienceState.guidedActive = false;
  if (markDismissed) inlineExperienceState.guidedDismissed = true;
  if (inlineExperienceState.guidedRaf) frameWindow.cancelAnimationFrame(inlineExperienceState.guidedRaf);
  inlineExperienceState.guidedRaf = 0;
  const scroller = frameDocument.scrollingElement || frameDocument.documentElement;
  inlineExperienceState.guidedOrigin = scroller.scrollTop;
  inlineExperienceState.guidedPauseUntil = 0;
  updateInlineGuidedModeUi(frameDocument);
}

function stepInlineGuidedMode(frameDocument) {
  if (!inlineExperienceState.guidedActive) return;
  const frameWindow = frameDocument.defaultView;
  const settings = experienceDraft?.guidedScroll || {};
  const scroller = frameDocument.scrollingElement || frameDocument.documentElement;
  const now = frameWindow.performance.now();
  if (inlineExperienceState.guidedPauseUntil && now < inlineExperienceState.guidedPauseUntil) {
    inlineExperienceState.guidedRaf = frameWindow.requestAnimationFrame(() => stepInlineGuidedMode(frameDocument));
    return;
  }
  if (inlineExperienceState.guidedPauseUntil && now >= inlineExperienceState.guidedPauseUntil) {
    inlineExperienceState.guidedPauseUntil = 0;
    inlineExperienceState.guidedPhase = "up";
    inlineExperienceState.guidedOrigin = scroller.scrollTop;
    inlineExperienceState.guidedStartedAt = 0;
  }
  if (!inlineExperienceState.guidedStartedAt) inlineExperienceState.guidedStartedAt = now;
  const duration = inlineExperienceState.guidedPhase === "down"
    ? Number(settings.downDurationMs || 112500)
    : Number(settings.upDurationMs || 56250);
  const progress = Math.min(1, (now - inlineExperienceState.guidedStartedAt) / duration);
  const eased = 1 - Math.pow(1 - progress, 2.2);
  const maxScroll = Math.max(0, scroller.scrollHeight - frameWindow.innerHeight);
  const isNearBottom = scroller.scrollTop >= Math.max(0, maxScroll - 8);
  if (inlineExperienceState.guidedPhase === "down" && isNearBottom) {
    inlineExperienceState.guidedPauseUntil = now + Number(settings.endPauseMs || 3000);
    scroller.scrollTop = maxScroll;
    inlineExperienceState.guidedRaf = frameWindow.requestAnimationFrame(() => stepInlineGuidedMode(frameDocument));
    return;
  }
  const target = inlineExperienceState.guidedPhase === "down" ? maxScroll : 0;
  scroller.scrollTop = inlineExperienceState.guidedOrigin + (target - inlineExperienceState.guidedOrigin) * eased;
  if (progress >= 1) {
    if (inlineExperienceState.guidedPhase === "down") {
      inlineExperienceState.guidedPauseUntil = now + Number(settings.endPauseMs || 3000);
      inlineExperienceState.guidedOrigin = scroller.scrollTop;
    } else {
      stopInlineGuidedMode(frameDocument, false);
      return;
    }
  }
  inlineExperienceState.guidedRaf = frameWindow.requestAnimationFrame(() => stepInlineGuidedMode(frameDocument));
}

function startInlineGuidedMode(frameDocument) {
  const settings = experienceDraft?.guidedScroll || {};
  if (!settings.enabled || inlineExperienceState.guidedActive) return;
  const frameWindow = frameDocument.defaultView;
  if (inlineExperienceState.guidedResumeTimer) {
    frameWindow.clearTimeout(inlineExperienceState.guidedResumeTimer);
    inlineExperienceState.guidedResumeTimer = 0;
  }
  inlineExperienceState.guidedActive = true;
  inlineExperienceState.guidedStartedAt = 0;
  inlineExperienceState.guidedPauseUntil = 0;
  const scroller = frameDocument.scrollingElement || frameDocument.documentElement;
  inlineExperienceState.guidedOrigin = scroller.scrollTop;
  inlineExperienceState.guidedPhase = scroller.scrollTop >= Math.max(0, scroller.scrollHeight - frameWindow.innerHeight - 8) ? "up" : "down";
  updateInlineGuidedModeUi(frameDocument);
  inlineExperienceState.guidedRaf = frameWindow.requestAnimationFrame(() => stepInlineGuidedMode(frameDocument));
}

function scheduleInlineGuidedResume(frameDocument) {
  const settings = experienceDraft?.guidedScroll || {};
  if (!settings.enabled) return;
  const frameWindow = frameDocument.defaultView;
  if (inlineExperienceState.guidedResumeTimer) frameWindow.clearTimeout(inlineExperienceState.guidedResumeTimer);
  inlineExperienceState.guidedResumeTimer = frameWindow.setTimeout(() => {
    if (!inlineExperienceState.guidedActive) {
      inlineExperienceState.guidedDismissed = false;
      startInlineGuidedMode(frameDocument);
    }
  }, Number(settings.resumeDelayMs || 2000));
}

function prepareManagedExperienceButton(frameDocument, controls, selector, dataAttribute, defaultLabel) {
  let button = controls.querySelector(selector);
  if (button && button.dataset.uwManaged !== "true") {
    const clone = button.cloneNode(true);
    button.replaceWith(clone);
    button = clone;
  }
  if (!button) {
    button = frameDocument.createElement("button");
    button.type = "button";
    button.className = "experience-button";
    controls.appendChild(button);
  }
  button.dataset.uwManaged = "true";
  button.setAttribute(dataAttribute, "true");
  button.style.display = "";
  if (!button.textContent.trim()) button.textContent = defaultLabel;
  return button;
}

function bindInlineExperienceControls(frameDocument) {
  const frameWindow = frameDocument.defaultView;
  if (inlineExperienceState.frameWindow !== frameWindow) {
    stopInlinePreviewAudio(inlineExperienceState.frameWindow || frameWindow, null);
    inlineExperienceState.frameWindow = frameWindow;
    inlineExperienceState.guidedBootTimer = 0;
    inlineExperienceState.guidedResumeTimer = 0;
    inlineExperienceState.guidedRaf = 0;
    inlineExperienceState.guidedActive = false;
    inlineExperienceState.guidedDismissed = false;
    inlineExperienceState.guidedStartedAt = 0;
    inlineExperienceState.guidedPhase = "down";
    inlineExperienceState.guidedOrigin = 0;
    inlineExperienceState.guidedPauseUntil = 0;
    inlineExperienceState.lastKnownScrollY = 0;
    inlineExperienceState.guidedButton = null;
    inlineExperienceState.soundButton = null;
    inlineExperienceState.audioContext = null;
    inlineExperienceState.listenersBound = false;
  }

  if (!inlineExperienceState.listenersBound) {
    const interrupt = () => {
      if (inlineExperienceState.guidedActive) stopInlineGuidedMode(frameDocument, true);
      scheduleInlineGuidedResume(frameDocument);
    };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach((eventName) => {
      frameWindow.addEventListener(eventName, interrupt, { passive: true });
    });
    frameWindow.addEventListener("scroll", () => {
      const scroller = frameDocument.scrollingElement || frameDocument.documentElement;
      const currentScrollY = scroller.scrollTop;
      const delta = Math.abs(currentScrollY - inlineExperienceState.lastKnownScrollY);
      inlineExperienceState.lastKnownScrollY = currentScrollY;
      if (!inlineExperienceState.guidedActive && delta > 2) scheduleInlineGuidedResume(frameDocument);
    }, { passive: true });
    inlineExperienceState.listenersBound = true;
  }

  if (inlineExperienceState.guidedButton && inlineExperienceState.guidedButton.dataset.bound !== "true") {
    inlineExperienceState.guidedButton.dataset.bound = "true";
    inlineExperienceState.guidedButton.addEventListener("click", () => {
      if (inlineExperienceState.guidedActive) {
        stopInlineGuidedMode(frameDocument, true);
        scheduleInlineGuidedResume(frameDocument);
        return;
      }
      inlineExperienceState.guidedDismissed = false;
      startInlineGuidedMode(frameDocument);
    });
  }

  if (inlineExperienceState.soundButton && inlineExperienceState.soundButton.dataset.bound !== "true") {
    inlineExperienceState.soundButton.dataset.bound = "true";
    inlineExperienceState.soundButton.addEventListener("click", async () => {
      const AudioContextClass = frameWindow.AudioContext || frameWindow.webkitAudioContext;
      if (!AudioContextClass) {
        inlineExperienceState.soundButton.textContent = "Sound Unavailable";
        return;
      }
      if (inlineExperienceState.audioEnabled) {
        stopInlinePreviewAudio(frameWindow);
        return;
      }
      try {
        if (!inlineExperienceState.audioContext) inlineExperienceState.audioContext = new AudioContextClass();
        await inlineExperienceState.audioContext.resume();
        const createVoice = (type, frequency, gainValue) => {
          const oscillator = inlineExperienceState.audioContext.createOscillator();
          const filter = inlineExperienceState.audioContext.createBiquadFilter();
          const gain = inlineExperienceState.audioContext.createGain();
          oscillator.type = type;
          oscillator.frequency.value = frequency;
          filter.type = "lowpass";
          filter.frequency.value = 420;
          filter.Q.value = 0.7;
          gain.gain.value = gainValue;
          oscillator.connect(filter);
          filter.connect(gain);
          gain.connect(inlineExperienceState.audioContext.destination);
          oscillator.start();
          inlineExperienceState.audioNodes.push(oscillator, filter, gain);
          return { filter };
        };
        const bass = createVoice("triangle", 55, 0.018);
        const pad = createVoice("sawtooth", 110, 0.008);
        createVoice("sine", 220, 0.0035);
        const lfo = inlineExperienceState.audioContext.createOscillator();
        const lfoGain = inlineExperienceState.audioContext.createGain();
        lfo.type = "sine";
        lfo.frequency.value = 0.07;
        lfoGain.gain.value = 110;
        lfo.connect(lfoGain);
        lfoGain.connect(bass.filter.frequency);
        lfoGain.connect(pad.filter.frequency);
        lfo.start();
        inlineExperienceState.audioNodes.push(lfo, lfoGain);
        const pulse = () => {
          const pulseOsc = inlineExperienceState.audioContext.createOscillator();
          const pulseGain = inlineExperienceState.audioContext.createGain();
          pulseOsc.type = "sine";
          pulseOsc.frequency.setValueAtTime(220, inlineExperienceState.audioContext.currentTime);
          pulseOsc.frequency.exponentialRampToValueAtTime(110, inlineExperienceState.audioContext.currentTime + 1.8);
          pulseGain.gain.setValueAtTime(0.0001, inlineExperienceState.audioContext.currentTime);
          pulseGain.gain.exponentialRampToValueAtTime(0.018, inlineExperienceState.audioContext.currentTime + 0.2);
          pulseGain.gain.exponentialRampToValueAtTime(0.0001, inlineExperienceState.audioContext.currentTime + 1.8);
          pulseOsc.connect(pulseGain);
          pulseGain.connect(inlineExperienceState.audioContext.destination);
          pulseOsc.start();
          pulseOsc.stop(inlineExperienceState.audioContext.currentTime + 2);
        };
        pulse();
        inlineExperienceState.audioPulseTimer = frameWindow.setInterval(pulse, 6800);
        inlineExperienceState.audioEnabled = true;
        inlineExperienceState.soundButton.textContent = "Sound: On";
      } catch {
        inlineExperienceState.soundButton.textContent = "Sound Unavailable";
      }
    });
  }
}

function applyExperiencePreview(frameDocument) {
  const frameWindow = frameDocument.defaultView;
  if (!frameWindow) return;
  ensureExperiencePreviewStyles(frameDocument);
  const settings = experienceDraft || ensureExperienceDraft();
  let controls = frameDocument.querySelector(".experience-controls");

  if (!controls && (settings.guidedScroll.enabled || settings.audio.enabled)) {
    controls = frameDocument.createElement("div");
    controls.className = "experience-controls";
    frameDocument.body.appendChild(controls);
  }

  if (controls) {
    if (settings.guidedScroll.enabled) {
      inlineExperienceState.guidedButton = prepareManagedExperienceButton(
        frameDocument,
        controls,
        "[data-guided-mode-btn], #guided-mode-btn",
        "data-guided-mode-btn",
        "Guided Mode: Off"
      );
    } else {
      const button = controls.querySelector("[data-guided-mode-btn], #guided-mode-btn");
      if (button) button.style.display = "none";
      if (inlineExperienceState.guidedActive) stopInlineGuidedMode(frameDocument, false);
      if (inlineExperienceState.guidedBootTimer) frameWindow.clearTimeout(inlineExperienceState.guidedBootTimer);
      if (inlineExperienceState.guidedResumeTimer) frameWindow.clearTimeout(inlineExperienceState.guidedResumeTimer);
      inlineExperienceState.guidedButton = null;
      frameDocument.body.classList.remove("guided-mode-active");
    }

    if (settings.audio.enabled) {
      inlineExperienceState.soundButton = prepareManagedExperienceButton(
        frameDocument,
        controls,
        "[data-sound-toggle-btn], #sound-toggle-btn",
        "data-sound-toggle-btn",
        "Enable Sound"
      );
    } else {
      const button = controls.querySelector("[data-sound-toggle-btn], #sound-toggle-btn");
      if (button) button.style.display = "none";
      stopInlinePreviewAudio(frameWindow, button || null);
      inlineExperienceState.soundButton = null;
    }
  }

  const heroNode = frameDocument.querySelector(".hero-standalone");
  if (heroNode) {
    if (settings.depthHero.enabled) {
      let depthGrid = heroNode.querySelector(".hero-depth-grid");
      if (!depthGrid) {
        depthGrid = frameDocument.createElement("div");
        depthGrid.className = "hero-depth-grid";
        depthGrid.dataset.uwManaged = "true";
        depthGrid.setAttribute("aria-hidden", "true");
        depthGrid.innerHTML = '<span class="depth-orb depth-orb-a"></span><span class="depth-orb depth-orb-b"></span><span class="depth-ring"></span><span class="depth-beam"></span>';
        heroNode.insertBefore(depthGrid, heroNode.firstChild);
      }
      const glareHost = heroNode.querySelector(".hero-cinematic-card") || heroNode.querySelector(".hero-frame-stage");
      if (glareHost && !glareHost.querySelector(".hero-frame-glare")) {
        const glare = frameDocument.createElement("div");
        glare.className = "hero-frame-glare";
        glare.dataset.uwManaged = "true";
        glare.setAttribute("aria-hidden", "true");
        glareHost.appendChild(glare);
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
    } else {
      heroNode.querySelectorAll(".hero-depth-grid[data-uw-managed='true'], .hero-frame-glare[data-uw-managed='true']").forEach((node) => node.remove());
      heroNode.style.removeProperty("--depth-x");
      heroNode.style.removeProperty("--depth-y");
    }
  }

  bindInlineExperienceControls(frameDocument);
  updateInlineGuidedModeUi(frameDocument);
  if (settings.guidedScroll.enabled && inlineExperienceState.guidedButton) {
    if (inlineExperienceState.guidedBootTimer) frameWindow.clearTimeout(inlineExperienceState.guidedBootTimer);
    inlineExperienceState.guidedBootTimer = frameWindow.setTimeout(() => {
      if (!inlineExperienceState.guidedDismissed) startInlineGuidedMode(frameDocument);
    }, Number(settings.guidedScroll.initialDelayMs || 6000));
  }
}

function applyPreview() {
  const frameWindow = siteFrame.contentWindow;
  const frameDocument = frameWindow?.document;
  if (!frameDocument) return;

  updateElementText(frameDocument.querySelector(".hero-kicker"), editableContent.hero.kicker);
  updateElementText(frameDocument.querySelector(".hero-standalone h1"), editableContent.hero.title);
  updateElementText(frameDocument.querySelector(".hero-sub"), editableContent.hero.sub);
  updateElementText(frameDocument.querySelector(".hero-trust"), editableContent.hero.trustLine);
  updateElementText(frameDocument.querySelector(".marquee-text"), editableContent.marqueeText);
  updateElementText(frameDocument.querySelector(".site-header a[href=\"#cta\"]"), editableContent.cta.headerCta);

  const sectionNodes = Array.from(frameDocument.querySelectorAll(".scroll-section"));
  editableContent.sections.forEach((section, index) => {
    const node = sectionNodes[index];
    if (!node) return;
    updateElementText(node.querySelector(".section-label"), section.label);
    updateElementText(node.querySelector(".section-heading"), section.heading);
    updateElementText(node.querySelector(".section-body"), section.body);

    if (section.kind === "stats") {
      const statNodes = Array.from(node.querySelectorAll(".stat"));
      section.stats.forEach((stat, statIndex) => {
        const statNode = statNodes[statIndex];
        if (!statNode) return;
        const statNumber = statNode.querySelector(".stat-number");
        statNumber?.setAttribute("data-value", stat.value);
        updateElementText(statNumber, stat.value);
        updateElementText(statNode.querySelector(".stat-suffix"), stat.suffix);
        updateElementText(statNode.querySelector(".stat-label"), stat.label);
      });
    }

    if (section.kind === "cards") {
      const cardNodes = Array.from(node.querySelectorAll(".info-card"));
      section.cards.forEach((card, cardIndex) => {
        const cardNode = cardNodes[cardIndex];
        if (!cardNode) return;
        updateElementText(cardNode.querySelector(".stat-label"), card.title);
        updateElementText(cardNode.querySelector(".card-body"), card.body);
      });
    }

    if (section.kind === "faq") {
      const itemNodes = Array.from(node.querySelectorAll(".info-card"));
      section.items.forEach((item, itemIndex) => {
        const itemNode = itemNodes[itemIndex];
        if (!itemNode) return;
        updateElementText(itemNode.querySelector(".stat-label"), item.question);
        updateElementText(itemNode.querySelector(".card-body"), item.answer);
      });
    }
  });

  const ctaNode = frameDocument.querySelector("#cta");
  if (ctaNode) {
    updateElementText(ctaNode.querySelector(".section-label"), editableContent.cta.label);
    updateElementText(ctaNode.querySelector(".section-heading"), editableContent.cta.heading);
    updateElementText(ctaNode.querySelector(".section-body"), editableContent.cta.body);
    updateElementText(ctaNode.querySelector(".cta-button"), editableContent.cta.button);
  }

  applyCinematicPreview(frameDocument);
  applyExperiencePreview(frameDocument);

  renderHandles();
}

function getHandleDescriptors() {
  const frameDocument = siteFrame.contentWindow?.document;
  if (!frameDocument) return [];
  const descriptors = [];
  const sectionNodes = Array.from(frameDocument.querySelectorAll(".scroll-section"));

  const heroNode = frameDocument.querySelector(".hero-standalone");
  if (heroNode) descriptors.push({
    type: "hero",
    label: "Hero",
    shortLabel: "H",
    node: heroNode,
    anchorNode: heroNode,
    placement: "anchor-left",
    action: openHeroModal,
  });

  const mediaNode = frameDocument.querySelector(".media-stage, .canvas-wrap");
  if (mediaNode) descriptors.push({
    type: "media",
    label: "Media",
    shortLabel: "M",
    node: mediaNode,
    placement: "fixed-right",
    top: 14,
    action: openMediaModal,
  });

  const marqueeNode = frameDocument.querySelector(".marquee-wrap");
  if (marqueeNode) descriptors.push({
    type: "marquee",
    label: "Banner",
    shortLabel: "B",
    node: marqueeNode,
    anchorNode: marqueeNode,
    placement: "fixed-lower-right",
    isVisible: ({ frameHeight }) => {
      const firstSection = sectionNodes[0];
      const secondSection = sectionNodes[1];
      const lastEditableSection = sectionNodes[Math.max(0, editableContent.sections.length - 1)];
      const firstRect = firstSection?.getBoundingClientRect();
      const secondRect = secondSection?.getBoundingClientRect();
      const lastRect = lastEditableSection?.getBoundingClientRect();
      const pastFirstSection = Boolean(firstRect) && firstRect.bottom <= frameHeight * 0.35;
      const secondSectionEntering = Boolean(secondRect) && secondRect.top <= frameHeight * 0.78;
      const beforeLastSectionEnds = !lastRect || lastRect.bottom >= frameHeight * 0.24;
      return (pastFirstSection || secondSectionEntering) && beforeLastSectionEnds;
    },
    action: openMarqueeModal,
  });

  editableContent.sections.forEach((section, index) => {
    const node = sectionNodes[index];
    if (!node) return;
    const anchorNode = node.querySelector(".section-inner, .stats-grid") || node;
    const placement = node.classList.contains("align-right") ? "anchor-right" : "anchor-left";
    descriptors.push({
      type: "section",
      label: getSectionDisplayLabel(section, index),
      shortLabel: getSectionShortLabel(section, index),
      node,
      anchorNode,
      placement,
      action: () => openSectionModal(index),
    });
  });

  const ctaNode = frameDocument.querySelector("#cta");
  if (ctaNode) descriptors.push({
    type: "cta",
    label: "CTA",
    shortLabel: "C",
    node: ctaNode,
    anchorNode: ctaNode.querySelector(".section-inner") || ctaNode,
    placement: "anchor-left",
    action: openCtaModal,
  });

  return descriptors;
}

function renderHandles() {
  const frameWindow = siteFrame.contentWindow;
  const frameDocument = frameWindow?.document;
  if (!frameDocument) return;

  const frameHeight = siteFrame.clientHeight;
  const frameWidth = siteFrame.clientWidth;
  handleLayer.querySelectorAll(".edit-handle").forEach((button) => button.remove());

  frameDocument.querySelectorAll("a").forEach((link) => {
    if (link.dataset.editorNavBound) return;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    link.dataset.editorNavBound = "true";
  });

  const descriptors = getHandleDescriptors();
  descriptors.forEach((descriptor) => {
    if (typeof descriptor.isVisible === "function" && !descriptor.isVisible({ frameHeight, frameWidth })) return;
    const rect = descriptor.anchorNode ? descriptor.anchorNode.getBoundingClientRect() : null;
    let top = 14;
    let left = 14;
    if (descriptor.placement === "fixed-right") {
      top = descriptor.top;
      left = frameWidth - 142;
    } else if (descriptor.placement === "fixed-lower-right") {
      top = frameHeight - 76;
      left = Math.max(14, frameWidth - 164);
    } else if (descriptor.placement === "anchor-left" && rect) {
      top = rect.top + Math.max(6, rect.height * 0.5) - 20;
      left = 14;
    } else if (descriptor.placement === "anchor-right" && rect) {
      top = rect.top + Math.max(6, rect.height * 0.5) - 20;
      left = Math.max(14, frameWidth - 164);
    }
    if (top < -40 || top > frameHeight + 40) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "edit-handle";
    button.innerHTML = `<span class="edit-handle-dot">${escapeHtml(descriptor.shortLabel || descriptor.label.slice(0, 1))}</span><span class="edit-handle-label">${escapeHtml(descriptor.label)}</span>`;
    button.title = `Edit ${descriptor.type}`;
    button.style.top = `${Math.max(10, top)}px`;
    button.style.left = `${left}px`;
    button.addEventListener("click", descriptor.action);
    handleLayer.appendChild(button);
  });
}

function startHandleSync() {
  clearInterval(handleTimer);
  handleTimer = setInterval(renderHandles, 350);
}

function stopHandleSync() {
  clearInterval(handleTimer);
  handleTimer = null;
}

async function fetchJob(jobId) {
  const response = await apiFetch(`/api/jobs/${jobId}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch job");
  }
  return response.json();
}

function startPolling(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const job = await fetchJob(jobId);
      setStatus(`Build status: ${String(job.status || "").toUpperCase()}`, `Job ${job.id.slice(0, 8)}`);
      if (job.status === "completed") {
        clearInterval(pollTimer);
        const siteUrl = toPublicAssetUrl(`/generated-sites/${job.slug}/index.html`);
        jobText.innerHTML = `Completed. <a href="${siteUrl}">Open new version</a>`;
        publishButton.disabled = false;
      } else if (job.status === "failed") {
        clearInterval(pollTimer);
        jobText.textContent = job.error || "Build failed.";
        publishButton.disabled = false;
      }
    } catch (error) {
      clearInterval(pollTimer);
      jobText.textContent = error.message;
      publishButton.disabled = false;
    }
  }, 2200);
}

function buildCinematicLayersPayload() {
  const serializeLayer = (slotKey, layer) => {
    const uploadField = layer.file instanceof File ? `cinematic-${slotKey}-video` : "";
    return {
      enabled: Boolean(layer.enabled),
      label: layer.label,
      layout: layer.layout,
      loopMode: layer.loopMode,
      speed: layer.speed,
      parallax: Boolean(layer.parallax),
      sourceUrl: layer.file instanceof File ? (layer.sourceUrl || "") : (layer.sourceUrl || ""),
      uploadField,
    };
  };

  return {
    hero: serializeLayer("hero", cinematicDraft.hero),
    sections: cinematicDraft.sections.map((layer, index) => serializeLayer(`section-${index}`, layer)),
  };
}

function buildDraftPayload() {
  const payload = new FormData();
  payload.append("topic", siteConfig.topic || editableContent.hero.title || siteConfig.title);
  payload.append("pageMode", siteConfig.pageMode || "conversion");
  payload.append("existingWebsite", siteConfig.existingWebsite || "");
  payload.append("siteUrl", seoDraft.publicSiteUrl || "");
  payload.append("colors", siteConfig.colors || "");
  payload.append("startPrompt", mediaDraft.startPrompt || "");
  payload.append("endPrompt", mediaDraft.endPrompt || "");
  payload.append("videoPrompt", mediaDraft.videoPrompt || "");
  payload.append("editSourceSlug", siteConfig.slug);
  payload.append("contentOverrides", JSON.stringify(editableContent));
  payload.append("cinematicLayers", JSON.stringify(buildCinematicLayersPayload()));
  payload.append("experienceUpgrades", JSON.stringify(experienceDraft));
  if (mediaDraft.startImageFile) payload.append("startImage", mediaDraft.startImageFile);
  if (mediaDraft.endImageFile) payload.append("endImage", mediaDraft.endImageFile);
  if (mediaDraft.videoFile) payload.append("video", mediaDraft.videoFile);
  if (cinematicDraft.hero.file) payload.append("cinematic-hero-video", cinematicDraft.hero.file);
  cinematicDraft.sections.forEach((layer, index) => {
    if (layer.file) payload.append(`cinematic-section-${index}-video`, layer.file);
  });
  return payload;
}

function openDraftPreviewWindow() {
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) return null;
  previewWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Preparing preview...</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111d;color:#eef6ff;font:16px/1.5 Manrope,Segoe UI,sans-serif}main{width:min(32rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid rgba(255,255,255,0.12);border-radius:1rem;background:rgba(10,20,30,0.88)}p{margin:0}p + p{margin-top:.7rem;color:#9ab3c8}</style></head><body><main><p>Preparing full preview...</p><p>Your current draft is being rendered in a temporary standalone page.</p></main></body></html>`);
  previewWindow.document.close();
  return previewWindow;
}

function buildLocalFullPreviewHtml() {
  const liveFrameDocument = siteFrame.contentWindow?.document;
  if (liveFrameDocument?.documentElement) {
    const doctype = liveFrameDocument.doctype
      ? `<!DOCTYPE ${liveFrameDocument.doctype.name}>`
      : "<!doctype html>";
    return injectStandalonePreviewRuntime(`${doctype}\n${liveFrameDocument.documentElement.outerHTML}`, {
      title: String(editableContent?.hero?.title || siteConfig?.title || "").trim(),
      publicSiteUrl: String(seoDraft?.publicSiteUrl || "").trim(),
      editableContent,
      cinematicLayers: buildStandalonePreviewCinematicLayers(),
      experienceUpgrades: experienceDraft,
    });
  }

  if (!siteSourceHtml || !siteSourcePreviewUrl) {
    throw new Error("The inline preview is not ready yet.");
  }

  const previewHtml = buildPreviewSrcdoc(siteSourceHtml, siteSourcePreviewUrl);
  return injectStandalonePreviewRuntime(previewHtml, {
    title: String(editableContent?.hero?.title || siteConfig?.title || "").trim(),
    publicSiteUrl: String(seoDraft?.publicSiteUrl || "").trim(),
    editableContent,
    cinematicLayers: buildStandalonePreviewCinematicLayers(),
    experienceUpgrades: experienceDraft,
  });
}

function openLocalFullPreview(previewWindow) {
  const previewHtml = buildLocalFullPreviewHtml();
  const blob = new Blob([previewHtml], { type: "text/html" });
  const previewUrl = URL.createObjectURL(blob);
  const targetWindow = previewWindow || window.open("", "_blank");
  if (!targetWindow) {
    URL.revokeObjectURL(previewUrl);
    throw new Error("The preview tab was blocked.");
  }
  targetWindow.location.replace(previewUrl);
  setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
  setStatus("Full preview ready.", "Opened a standalone local preview from the current unsaved draft.");
}

async function publishEdits() {
  if (!siteConfig) return;
  publishButton.disabled = true;
  setStatus("Submitting edited version...", "Reusing current media unless you replaced it.");

  const payload = buildDraftPayload();

  const response = await apiFetch("/api/build", {
    method: "POST",
    body: payload,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    publishButton.disabled = false;
    throw new Error(data.error || "Failed to create edited version");
  }
  setStatus(`Edited version queued in ${String(data.pageMode || "").toUpperCase()} mode`, `Job ${String(data.id || "").slice(0, 8)}`);
  startPolling(data.id);
}

async function openFullPreview() {
  if (!siteConfig) return;
  const previewWindow = openDraftPreviewWindow();
  fullPreviewButton.disabled = true;
  setStatus("Preparing full preview...", "Opening the current live preview state in a standalone tab.");
  openLocalFullPreview(previewWindow);
}

async function loadSite() {
  if (!siteSlug) {
    setStatus("Missing site slug.", "Open this page from a gallery Edit action.");
    publishButton.disabled = true;
    fullPreviewButton.disabled = true;
    return;
  }

  const response = await apiFetch(`/api/sites/${encodeURIComponent(siteSlug)}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to load site");
  }

  siteConfig = await response.json();
  editableContent = ensureEditableContent(siteConfig.editableContent);
  resetMediaDraft();
  resetCinematicDraft();
  resetExperienceDraft();
  resetSeoDraft();
  renderExperienceUpsells();

  editorTitle.textContent = editableContent.hero.title || siteConfig.title;
  editorSubtitle.textContent = "Tap any circle in the preview to edit that part of the page.";
  setStatus("Preview ready.", "Tap a circle on the site to edit its content.");
  fullPreviewButton.disabled = false;

  const previewUrl = getSitePreviewUrl(siteConfig);
  if (!previewUrl) {
    throw new Error("The site preview URL is missing.");
  }
  const previewHtml = await fetchText(previewUrl);
  siteSourceHtml = previewHtml;
  siteSourcePreviewUrl = previewUrl;
  siteFrame.srcdoc = buildPreviewSrcdoc(previewHtml, previewUrl);
}

siteFrame.addEventListener("load", () => {
  const frameDocument = siteFrame.contentWindow?.document;
  if (frameDocument && !editableContent.sections.length) {
    editableContent.sections = extractSectionsFromPreview(frameDocument);
  }
  applyPreview();
  siteFrame.contentWindow?.addEventListener("scroll", renderHandles, { passive: true });
  startHandleSync();
});

window.addEventListener("resize", renderHandles);
modalCloseButton.addEventListener("click", closeModal);
modalCancelButton.addEventListener("click", closeModal);
modalSaveButton.addEventListener("click", applyModalChanges);
modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});
publishButton.addEventListener("click", async () => {
  try {
    await publishEdits();
  } catch (error) {
    setStatus(`Could not publish changes: ${error.message}`);
  }
});
experienceSettingsButton.addEventListener("click", openExperienceModal);
cinematicLayersButton.addEventListener("click", openCinematicModal);
seoSettingsButton.addEventListener("click", openSeoModal);
fullPreviewButton.addEventListener("click", async () => {
  try {
    await openFullPreview();
  } catch (error) {
    setStatus(`Could not open full preview: ${error.message}`);
  } finally {
    fullPreviewButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  clearInterval(pollTimer);
  stopHandleSync();
});

fullPreviewButton.disabled = true;
loadSite().catch((error) => {
  publishButton.disabled = true;
  fullPreviewButton.disabled = true;
  setStatus(`Could not load editor: ${error.message}`);
});
