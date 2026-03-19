const editorTitle = document.getElementById("editor-title");
const editorSubtitle = document.getElementById("editor-subtitle");
const statusText = document.getElementById("status-text");
const jobText = document.getElementById("job-text");
const publishButton = document.getElementById("publish-btn");
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

const configuredApiBase = String(window.ULTIMATEWEB_API_BASE || "").trim().replace(/\/+$/, "");
const urlParams = new URLSearchParams(window.location.search);
const siteSlug = String(urlParams.get("slug") || "").trim();

let siteConfig = null;
let editableContent = null;
let mediaDraft = null;
let cinematicDraft = null;
let seoDraft = null;
let activeModal = null;
let pollTimer = null;
let handleTimer = null;
const previewObjectUrls = new Set();

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

  const reverseStep = (timestamp) => {
    if (!reversing) return;
    if (!lastTick) lastTick = timestamp;
    const delta = (timestamp - lastTick) / 1000;
    lastTick = timestamp;
    const nextTime = Math.max(0, video.currentTime - delta * speed);
    video.currentTime = nextTime;
    if (nextTime <= 0.02) {
      stopReverse();
      video.currentTime = 0;
      video.playbackRate = speed;
      video.play().catch(() => {});
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

function renderPreviewCinematicLayer(frameDocument, layer, options = {}) {
  if (!layer?.enabled) return null;
  const wrapper = frameDocument.createElement("div");
  wrapper.className = options.type === "hero"
    ? `hero-cinematic ${layer.layout === "full-background" ? "hero-cinematic-full" : "hero-cinematic-card"}`
    : getSectionCinematicPlacementClass(options.sectionNode, layer);
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
  return wrapper;
}

function applyCinematicPreview(frameDocument) {
  ensureCinematicPreviewStyles(frameDocument);

  const heroNode = frameDocument.querySelector(".hero-standalone");
  if (heroNode) {
    heroNode.querySelectorAll(".hero-cinematic").forEach((node) => node.remove());
    const heroLayer = renderPreviewCinematicLayer(frameDocument, cinematicDraft.hero, { type: "hero" });
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

function applyPreview() {
  const frameWindow = siteFrame.contentWindow;
  const frameDocument = frameWindow?.document;
  if (!frameDocument) return;

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

  applyCinematicPreview(frameDocument);

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
  const frameDocument = siteFrame.contentWindow?.document;
  if (!frameDocument?.documentElement) {
    throw new Error("The inline preview is not ready yet.");
  }

  const html = frameDocument.documentElement.outerHTML;
  const parser = new DOMParser();
  const previewDoc = parser.parseFromString(`<!doctype html>${html}`, "text/html");
  const title = String(editableContent?.hero?.title || siteConfig?.title || "").trim();
  const canonicalUrl = String(seoDraft?.publicSiteUrl || "").trim();

  if (title) {
    previewDoc.title = title;
  }
  upsertLinkTag(previewDoc, "canonical", canonicalUrl);
  upsertMetaTag(previewDoc, "property", "og:url", canonicalUrl || "");
  upsertMetaTag(previewDoc, "name", "robots", canonicalUrl ? "index, follow" : "noindex, nofollow");

  const staticStyle = previewDoc.createElement("style");
  staticStyle.textContent = `
    html, body { min-height: 100%; overflow-x: hidden; }
    body { overflow-y: auto !important; }
    #loader,
    .media-stage,
    .canvas-wrap,
    #dark-overlay { display: none !important; }
    #scroll-container {
      height: auto !important;
      display: grid !important;
      gap: 0 !important;
      padding-bottom: 4rem !important;
    }
    .marquee-wrap {
      position: relative !important;
      top: auto !important;
      left: auto !important;
      opacity: 1 !important;
      margin: 0 0 2rem !important;
    }
    .scroll-section {
      position: relative !important;
      top: auto !important;
      opacity: 1 !important;
      transform: none !important;
      padding-block: clamp(2rem, 6vw, 5rem) !important;
    }
  `;
  previewDoc.head.appendChild(staticStyle);

  return `<!doctype html>\n${previewDoc.documentElement.outerHTML}`;
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
  setStatus("Preparing full preview...", "Generating a temporary standalone preview with your unsaved draft.");

  const payload = buildDraftPayload();
  const response = await apiFetch(`/api/sites/${encodeURIComponent(siteConfig.slug)}/preview`, {
    method: "POST",
    body: payload,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    openLocalFullPreview(previewWindow);
    return;
  }

  const previewUrl = resolveAbsoluteUrl(data.previewUrl);
  if (previewWindow) {
    previewWindow.location.replace(previewUrl);
  } else {
    window.open(previewUrl, "_blank");
  }
  setStatus("Full preview ready.", "Opened a temporary standalone preview in a new tab.");
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
  resetSeoDraft();

  editorTitle.textContent = editableContent.hero.title || siteConfig.title;
  editorSubtitle.textContent = "Tap any circle in the preview to edit that part of the page.";
  setStatus("Preview ready.", "Tap a circle on the site to edit its content.");
  fullPreviewButton.disabled = false;

  const previewUrl = getSitePreviewUrl(siteConfig);
  if (!previewUrl) {
    throw new Error("The site preview URL is missing.");
  }
  const previewHtml = await fetchText(previewUrl);
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
