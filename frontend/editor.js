const editorTitle = document.getElementById("editor-title");
const editorSubtitle = document.getElementById("editor-subtitle");
const statusText = document.getElementById("status-text");
const jobText = document.getElementById("job-text");
const publishButton = document.getElementById("publish-btn");
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
let activeModal = null;
let pollTimer = null;
let handleTimer = null;

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
    const url = new URL(previewUrl);
    const pathname = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return previewUrl;
  }
}

function buildPreviewSrcdoc(html, previewUrl) {
  const baseHref = getPreviewBaseHref(previewUrl);
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
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
    title: `Section ${index + 1}`,
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

function applyModalChanges() {
  if (!activeModal) return;
  const formData = new FormData();
  modalBody.querySelectorAll("input, textarea, select").forEach((field) => {
    if (!field.name) return;
    if (field.type === "file") {
      if (field.files?.[0]) formData.append(field.name, field.files[0]);
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

  applyPreview();
  closeModal();
}

function updateElementText(element, value) {
  if (element) element.textContent = value;
}

function applyPreview() {
  const frameWindow = siteFrame.contentWindow;
  const frameDocument = frameWindow?.document;
  if (!frameDocument) return;

  updateElementText(frameDocument.querySelector(".hero-kicker"), editableContent.hero.kicker);
  updateElementText(frameDocument.querySelector(".hero-standalone h1"), String(editableContent.hero.title || "").toUpperCase());
  updateElementText(frameDocument.querySelector(".hero-sub"), editableContent.hero.sub);
  updateElementText(frameDocument.querySelector(".hero-trust"), editableContent.hero.trustLine);
  updateElementText(
    frameDocument.querySelector(".marquee-text"),
    [editableContent.marqueeText, editableContent.marqueeText, editableContent.marqueeText].filter(Boolean).join(" · ")
  );
  updateElementText(frameDocument.querySelector(".site-header a"), editableContent.cta.headerCta);
  updateElementText(frameDocument.querySelector("title"), `${editableContent.hero.title || siteConfig.topic} | ${siteConfig.topic}`);

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

  renderHandles();
}

function getHandleDescriptors() {
  const frameDocument = siteFrame.contentWindow?.document;
  if (!frameDocument) return [];
  const descriptors = [];

  const heroNode = frameDocument.querySelector(".hero-standalone");
  if (heroNode) descriptors.push({
    type: "hero",
    label: "Hero",
    shortLabel: "H",
    node: heroNode,
    placement: "fixed-left",
    top: 14,
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
    placement: "anchor-left",
    action: openMarqueeModal,
  });

  const sectionNodes = Array.from(frameDocument.querySelectorAll(".scroll-section"));
  editableContent.sections.forEach((section, index) => {
    const node = sectionNodes[index];
    if (!node) return;
    descriptors.push({
      type: "section",
      label: section.heading || section.label || `Section ${index + 1}`,
      shortLabel: String(index + 1),
      node,
      placement: "dock-left",
      dockIndex: index,
      action: () => openSectionModal(index),
    });
  });

  const ctaNode = frameDocument.querySelector("#cta");
  if (ctaNode) descriptors.push({
    type: "cta",
    label: "CTA",
    shortLabel: "C",
    node: ctaNode,
    placement: "dock-left",
    dockIndex: editableContent.sections.length,
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
  handleLayer.innerHTML = "";

  frameDocument.querySelectorAll("a").forEach((link) => {
    if (link.dataset.editorNavBound) return;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    link.dataset.editorNavBound = "true";
  });

  getHandleDescriptors().forEach((descriptor) => {
    const rect = descriptor.anchorNode ? descriptor.anchorNode.getBoundingClientRect() : null;
    let top = 14;
    let left = 14;
    if (descriptor.placement === "fixed-right") {
      top = descriptor.top;
      left = frameWidth - 142;
    } else if (descriptor.placement === "fixed-left") {
      top = descriptor.top;
      left = 14;
    } else if (descriptor.placement === "anchor-left" && rect) {
      top = rect.top + Math.max(6, rect.height * 0.5) - 20;
      left = 14;
    } else if (descriptor.placement === "dock-left") {
      top = 118 + (descriptor.dockIndex || 0) * 52;
      left = 14;
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

async function publishEdits() {
  if (!siteConfig) return;
  publishButton.disabled = true;
  setStatus("Submitting edited version...", "Reusing current media unless you replaced it.");

  const payload = new FormData();
  payload.append("topic", siteConfig.topic || editableContent.hero.title || siteConfig.title);
  payload.append("pageMode", siteConfig.pageMode || "conversion");
  payload.append("existingWebsite", siteConfig.existingWebsite || "");
  payload.append("colors", siteConfig.colors || "");
  payload.append("startPrompt", mediaDraft.startPrompt || "");
  payload.append("endPrompt", mediaDraft.endPrompt || "");
  payload.append("videoPrompt", mediaDraft.videoPrompt || "");
  payload.append("editSourceSlug", siteConfig.slug);
  payload.append("contentOverrides", JSON.stringify(editableContent));
  if (mediaDraft.startImageFile) payload.append("startImage", mediaDraft.startImageFile);
  if (mediaDraft.endImageFile) payload.append("endImage", mediaDraft.endImageFile);
  if (mediaDraft.videoFile) payload.append("video", mediaDraft.videoFile);

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

async function loadSite() {
  if (!siteSlug) {
    setStatus("Missing site slug.", "Open this page from a gallery Edit action.");
    publishButton.disabled = true;
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

  editorTitle.textContent = editableContent.hero.title || siteConfig.title;
  editorSubtitle.textContent = "Tap any circle in the preview to edit that part of the page.";
  setStatus("Preview ready.", "Tap a circle on the site to edit its content.");

  const previewUrl = getSitePreviewUrl(siteConfig);
  if (!previewUrl) {
    throw new Error("The site preview URL is missing.");
  }
  const previewHtml = await fetchText(previewUrl);
  siteFrame.srcdoc = buildPreviewSrcdoc(previewHtml, previewUrl);
}

siteFrame.addEventListener("load", () => {
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

window.addEventListener("beforeunload", () => {
  clearInterval(pollTimer);
  stopHandleSync();
});

loadSite().catch((error) => {
  publishButton.disabled = true;
  setStatus(`Could not load editor: ${error.message}`);
});
