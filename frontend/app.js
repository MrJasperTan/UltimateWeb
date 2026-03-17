const form = document.getElementById("build-form");
const topicInput = document.getElementById("topic");
const existingWebsiteInput = document.getElementById("existing-website");
const colorsInput = document.getElementById("colors");
const startImageInput = document.getElementById("start-image");
const endImageInput = document.getElementById("end-image");
const videoInput = document.getElementById("video");
const changeRequestInput = document.getElementById("change-request");
const startPromptInput = document.getElementById("start-prompt");
const endPromptInput = document.getElementById("end-prompt");
const videoPromptInput = document.getElementById("video-prompt");
const editBanner = document.getElementById("edit-banner");
const editBannerText = document.getElementById("edit-banner-text");
const cancelEditButton = document.getElementById("cancel-edit-btn");
const pageModeInputs = document.querySelectorAll('input[name="pageMode"]');
const submitButton = document.getElementById("submit-btn");
const statusText = document.getElementById("status-text");
const stageText = document.getElementById("stage-text");
const engineCore = document.getElementById("engine-core");
const logs = document.getElementById("logs");
const galleryEmpty = document.getElementById("gallery-empty");
const galleryGrid = document.getElementById("gallery-grid");

let jobPollingTimer = null;
let galleryPollingTimer = null;
let activeJobId = null;
let activeEditSite = null;
const configuredApiBase = String(window.ULTIMATEWEB_API_BASE || "").trim().replace(/\/+$/, "");

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

function setStatus(message) {
  statusText.textContent = message;
}

function setStage(message) {
  stageText.textContent = message;
}

function setBusy(isBusy) {
  document.body.classList.toggle("is-building", isBusy);
  engineCore.classList.toggle("is-building", isBusy);
}

function setLogs(lines) {
  logs.textContent = Array.isArray(lines) && lines.length ? lines.join("\n") : "";
  logs.scrollTop = logs.scrollHeight;
}

function formatDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString();
}

function deriveStage(logLines, status) {
  const joined = (logLines || []).join("\n");
  if (status === "completed") return "Build complete";
  if (status === "failed") return "Build failed";
  if (joined.includes("Generating start frame")) return "Generating first image with Nano Banana 2";
  if (joined.includes("Generating end frame")) return "Generating final image with Nano Banana 2 Edit";
  if (joined.includes("Generating transition video")) return "Rendering transition video with Kling 3.0";
  if (joined.includes("Extracting frames")) return "Extracting frame sequence";
  if (joined.includes("Scaffolding website")) return "Assembling website";
  return "Preparing pipeline";
}

function renderGallery(items) {
  if (!Array.isArray(items) || items.length === 0) {
    galleryGrid.innerHTML = "";
    galleryEmpty.classList.remove("hidden");
    return;
  }

  galleryEmpty.classList.add("hidden");
  galleryGrid.innerHTML = items
    .map((item) => {
      const thumb = toPublicAssetUrl(
        item.thumbnailUrl || "/generated-sites/2025-corvette-stingray/media/start-frame.png"
      );
      const siteUrl = toPublicAssetUrl(item.siteUrl);
      const versionLabel = item.versionLabel ? `<p class="gallery-date">${item.versionLabel}</p>` : "";
      return `
        <article class="gallery-item">
          <img src="${thumb}" alt="${item.title}" loading="lazy" />
          <div class="gallery-meta">
            <p class="gallery-title">${item.title}</p>
            <p class="gallery-date">${formatDate(item.createdAt)}</p>
            ${versionLabel}
            <div class="gallery-actions">
              <a class="gallery-action gallery-link" href="${siteUrl}" target="_blank" rel="noopener noreferrer">Open</a>
              <button class="gallery-action" type="button" data-edit-slug="${item.slug}">Edit</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

async function fetchSiteConfig(slug) {
  const response = await fetch(toApiUrl(`/api/sites/${slug}`));
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Unknown API error" }));
    throw new Error(data.error || "Failed to load site config");
  }
  return response.json();
}

function setEditState(siteConfig) {
  activeEditSite = siteConfig;
  editBanner.classList.remove("hidden");
  editBannerText.textContent = `Editing ${siteConfig.title} and creating a new version`;
  submitButton.textContent = "Create Edited Version";
  setStatus(`Editing ${siteConfig.title}`);
  setStage("Review the config, describe changes, then create a new version");
}

function clearEditState() {
  activeEditSite = null;
  editBanner.classList.add("hidden");
  editBannerText.textContent = "Editing version";
  submitButton.textContent = "Launch Build";
  form.reset();
}

async function beginEdit(slug) {
  const siteConfig = await fetchSiteConfig(slug);
  topicInput.value = siteConfig.topic || "";
  existingWebsiteInput.value = siteConfig.existingWebsite || "";
  colorsInput.value = siteConfig.colors || "";
  changeRequestInput.value = "";
  startPromptInput.value = siteConfig.startPrompt || "";
  endPromptInput.value = siteConfig.endPrompt || "";
  videoPromptInput.value = siteConfig.videoPrompt || "";
  startImageInput.value = "";
  endImageInput.value = "";
  videoInput.value = "";
  Array.from(pageModeInputs).forEach((input) => {
    input.checked = input.value === (siteConfig.pageMode || "conversion");
  });
  setEditState(siteConfig);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function refreshGallery() {
  const response = await fetch(toApiUrl("/api/gallery"));
  if (!response.ok) {
    throw new Error("Failed to load gallery");
  }
  const entries = await response.json();
  renderGallery(entries);
}

async function fetchJob(jobId) {
  const response = await fetch(toApiUrl(`/api/jobs/${jobId}`));
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Unknown API error" }));
    throw new Error(data.error || "Failed to fetch job");
  }
  return response.json();
}

function stopJobPolling() {
  if (jobPollingTimer) {
    clearInterval(jobPollingTimer);
    jobPollingTimer = null;
  }
}

function startGalleryPolling() {
  if (galleryPollingTimer) return;
  galleryPollingTimer = setInterval(async () => {
    try {
      await refreshGallery();
    } catch {
      // Keep silent in background refresh.
    }
  }, 8000);
}

function startJobPolling(jobId) {
  stopJobPolling();
  jobPollingTimer = setInterval(async () => {
    try {
      const job = await fetchJob(jobId);
      const status = String(job.status || "").toUpperCase();
      setStatus(`Job ${job.id.slice(0, 8)} • ${status}`);
      setStage(deriveStage(job.logs || [], job.status));
      setLogs(job.logs || []);

      if (job.status === "completed") {
        stopJobPolling();
        submitButton.disabled = false;
        setBusy(false);
        await refreshGallery();
      }

      if (job.status === "failed") {
        stopJobPolling();
        submitButton.disabled = false;
        setBusy(false);
        const reason = job.error ? `Failed: ${job.error}` : "Build failed";
        setStatus(reason);
      }
    } catch (error) {
      stopJobPolling();
      submitButton.disabled = false;
      setBusy(false);
      setStatus(`Polling stopped: ${error.message}`);
    }
  }, 2200);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();
  const existingWebsite = existingWebsiteInput.value.trim();
  const colors = colorsInput.value.trim();
  const startImageFile = startImageInput.files?.[0] || null;
  const endImageFile = endImageInput.files?.[0] || null;
  const videoFile = videoInput.files?.[0] || null;
  const changeRequest = changeRequestInput.value.trim();
  const startPrompt = startPromptInput.value.trim();
  const endPrompt = endPromptInput.value.trim();
  const videoPrompt = videoPromptInput.value.trim();
  const selectedPageMode = Array.from(pageModeInputs).find((input) => input.checked)?.value || "conversion";
  if (!topic) return;

  submitButton.disabled = true;
  setLogs([]);
  setBusy(true);
  setStage("Submitting request");
  setStatus("Submitting build request...");

  try {
    const apiEndpoint = toApiUrl("/api/build");
    const payload = new FormData();
    payload.append("topic", topic);
    payload.append("pageMode", selectedPageMode);
    payload.append("existingWebsite", existingWebsite);
    payload.append("colors", colors);
    payload.append("changeRequest", changeRequest);
    payload.append("startPrompt", startPrompt);
    payload.append("endPrompt", endPrompt);
    payload.append("videoPrompt", videoPrompt);
    if (activeEditSite?.slug) payload.append("editSourceSlug", activeEditSite.slug);
    if (startImageFile) payload.append("startImage", startImageFile);
    if (endImageFile) payload.append("endImage", endImageFile);
    if (videoFile) payload.append("video", videoFile);

    const response = await fetch(apiEndpoint, {
      method: "POST",
      body: payload,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Failed to start build");
    }

    activeJobId = data.id;
    setStatus(`Job ${activeJobId.slice(0, 8)} • RUNNING • ${selectedPageMode.toUpperCase()}`);
    setStage("Preparing pipeline");
    clearEditState();
    startJobPolling(activeJobId);
  } catch (error) {
    submitButton.disabled = false;
    setBusy(false);
    setStatus(`Could not start build: ${error.message}`);
  }
});

galleryGrid.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-slug]");
  if (!editButton) return;
  try {
    await beginEdit(editButton.getAttribute("data-edit-slug"));
  } catch (error) {
    setStatus(`Could not load edit config: ${error.message}`);
  }
});

cancelEditButton.addEventListener("click", () => {
  clearEditState();
  setStatus("Edit cancelled");
  setStage("Waiting for a new request");
});

setBusy(false);
setStage("Waiting for a new request");
if (window.location.hostname.endsWith("vercel.app") || window.location.hostname.includes("thejaspertan.com")) {
  if (!configuredApiBase) {
    setStatus("Backend not configured. Set ULTIMATEWEB_API_BASE in Vercel env.");
  }
}
refreshGallery().catch(() => {
  // Keep page usable even if gallery fetch fails initially.
});
startGalleryPolling();
