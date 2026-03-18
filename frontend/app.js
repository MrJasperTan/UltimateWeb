const form = document.getElementById("build-form");
const topicInput = document.getElementById("topic");
const existingWebsiteInput = document.getElementById("existing-website");
const colorsInput = document.getElementById("colors");
const startImageInput = document.getElementById("start-image");
const endImageInput = document.getElementById("end-image");
const videoInput = document.getElementById("video");
const startImageState = document.getElementById("start-image-state");
const endImageState = document.getElementById("end-image-state");
const videoState = document.getElementById("video-state");
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
const authSignedOut = document.getElementById("auth-signed-out");
const authSignedIn = document.getElementById("auth-signed-in");
const authEmailInput = document.getElementById("auth-email");
const authPasswordInput = document.getElementById("auth-password");
const authUserEmail = document.getElementById("auth-user-email");
const authMessage = document.getElementById("auth-message");
const googleAuthButton = document.getElementById("google-auth-btn");
const signInButton = document.getElementById("sign-in-btn");
const signUpButton = document.getElementById("sign-up-btn");
const signOutButton = document.getElementById("sign-out-btn");

let jobPollingTimer = null;
let galleryPollingTimer = null;
let activeJobId = null;
let activeEditSite = null;
let authState = {
  configured: Boolean(window.ULTIMATEWEB_SUPABASE_ENABLED),
  authenticated: false,
  user: null,
};

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

function openInlineEditor(slug) {
  const editorVersion = "20260318o";
  const editorPath = `/editor.html?v=${editorVersion}&slug=${encodeURIComponent(slug)}`;
  window.location.href = toPublicAssetUrl(editorPath);
}

async function apiFetch(path, options = {}) {
  const response = await fetch(toApiUrl(path), {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  return response;
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

function setAuthMessage(message, mode = "") {
  authMessage.textContent = message;
  authMessage.dataset.mode = mode;
}

function setAuthPending(isPending) {
  [googleAuthButton, signInButton, signUpButton, signOutButton].forEach((button) => {
    if (button) button.disabled = isPending;
  });
}

function updateLockedState() {
  const isAuthenticated = Boolean(authState.authenticated);
  form.classList.toggle("auth-locked", !isAuthenticated);
  Array.from(form.elements).forEach((element) => {
    if (!element.name && element.tagName !== "BUTTON") return;
    if (element === submitButton) return;
    element.disabled = !isAuthenticated;
  });
  submitButton.disabled = !isAuthenticated;
  if (!isAuthenticated) {
    clearEditState();
    setLogs([]);
    setStage("Authentication required");
    setStatus(authState.configured ? "Sign in to launch builds." : "Supabase is not configured.");
    galleryGrid.innerHTML = "";
    galleryEmpty.textContent = authState.configured
      ? "Sign in to load your generated sites."
      : "Supabase is not configured yet.";
    galleryEmpty.classList.remove("hidden");
  }
}

function updateAuthUi() {
  const isAuthenticated = Boolean(authState.authenticated);
  authSignedOut.classList.toggle("hidden", isAuthenticated);
  authSignedIn.classList.toggle("hidden", !isAuthenticated);
  authUserEmail.textContent = authState.user?.email || "No active session";
  if (isAuthenticated) {
    setAuthMessage("Authenticated with Supabase. Builds and gallery entries are scoped to your account.", "success");
  } else if (!authState.configured) {
    setAuthMessage("Supabase is not configured. Add the env vars and local keys before using the portal.", "error");
  } else {
    setAuthMessage("Sign in with Google or use email and password to access your private gallery and launch builds.");
  }
  updateLockedState();
}

function startGoogleAuth() {
  if (!authState.configured) {
    setAuthMessage("Supabase is not configured. Add the env vars and local keys before using Google sign-in.", "error");
    return;
  }
  setAuthPending(true);
  setAuthMessage("Redirecting to Google...", "");
  window.location.href = toApiUrl("/api/auth/google");
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
  if (!authState.authenticated) {
    galleryGrid.innerHTML = "";
    galleryEmpty.classList.remove("hidden");
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    galleryGrid.innerHTML = "";
    galleryEmpty.textContent = "No generated sites found yet.";
    galleryEmpty.classList.remove("hidden");
    return;
  }

  galleryEmpty.classList.add("hidden");
  galleryGrid.innerHTML = items
    .map((item) => {
      const thumb = toPublicAssetUrl(item.thumbnailUrl) || "";
      const versionLabel = item.versionLabel ? `<p class="gallery-date">${item.versionLabel}</p>` : "";
      return `
        <article class="gallery-item">
          <button class="gallery-delete" type="button" data-delete-slug="${item.slug}" data-delete-title="${item.title}" aria-label="Delete ${item.title}">X</button>
          ${thumb ? `<a class="gallery-thumb" href="${toPublicAssetUrl(item.siteUrl)}" target="_blank" rel="noreferrer"><img src="${thumb}" alt="${item.title}" loading="lazy" /></a>` : ""}
          <div class="gallery-copy">
            <p class="gallery-date">${formatDate(item.createdAt)}</p>
            ${versionLabel}
            <h3>${item.title}</h3>
            <div class="gallery-actions">
              <a class="gallery-link" href="${toPublicAssetUrl(item.siteUrl)}" target="_blank" rel="noreferrer">Open Site</a>
              <button class="gallery-action" type="button" data-edit-slug="${item.slug}">Edit</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function setEditState(siteConfig) {
  activeEditSite = siteConfig;
  editBanner.classList.remove("hidden");
  editBannerText.textContent = `Editing ${siteConfig.title}. Empty media fields will reuse the current assets.`;
  refreshMediaStates();
}

function clearEditState() {
  activeEditSite = null;
  editBanner.classList.add("hidden");
  editBannerText.textContent = "Editing version";
  startImageInput.value = "";
  endImageInput.value = "";
  videoInput.value = "";
  refreshMediaStates();
}

function setMediaState(element, mode, message) {
  element.classList.remove("is-reuse", "is-replace");
  if (mode) {
    element.classList.add(mode);
  }
  element.textContent = message;
}

function buildMediaStateMessage(kind, file, currentMedia) {
  if (file) return { mode: "is-replace", message: `Replacing with ${file.name}` };
  if (activeEditSite) {
    if (currentMedia?.available) {
      return { mode: "is-reuse", message: `Reusing current ${kind}: ${currentMedia.filename}` };
    }
    return { mode: "", message: `No current ${kind}. Leave empty to use the default build behavior.` };
  }
  return { mode: "", message: "Optional. Leave empty to use the default build behavior." };
}

function refreshMediaStates() {
  const media = activeEditSite?.media || {};
  const startState = buildMediaStateMessage("start image", startImageInput.files?.[0] || null, media.startImage);
  const endState = buildMediaStateMessage("end image", endImageInput.files?.[0] || null, media.endImage);
  const videoStateValue = buildMediaStateMessage("video", videoInput.files?.[0] || null, media.video);
  setMediaState(startImageState, startState.mode, startState.message);
  setMediaState(endImageState, endState.mode, endState.message);
  setMediaState(videoState, videoStateValue.mode, videoStateValue.message);
}

async function fetchSession() {
  const response = await apiFetch("/api/auth/session");
  if (!response.ok) {
    throw new Error("Failed to load session.");
  }
  return response.json();
}

async function refreshSessionState() {
  const session = await fetchSession();
  authState = {
    configured: Boolean(session.configured),
    authenticated: Boolean(session.authenticated),
    user: session.user || null,
  };
  updateAuthUi();
  return authState;
}

async function submitAuth(path) {
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value.trim();
  if (!email || !password) {
    setAuthMessage("Email and password are required.", "error");
    return;
  }

  setAuthPending(true);
  try {
    const response = await apiFetch(path, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Authentication request failed.");
    }
    authPasswordInput.value = "";
    await refreshSessionState();
    await refreshGallery();
    startGalleryPolling();
  } catch (error) {
    setAuthMessage(error.message, "error");
  } finally {
    setAuthPending(false);
  }
}

async function signOutSession() {
  setAuthPending(true);
  try {
    await apiFetch("/api/auth/sign-out", { method: "POST" });
  } finally {
    stopJobPolling();
    stopGalleryPolling();
    authState = { configured: authState.configured, authenticated: false, user: null };
    updateAuthUi();
    setAuthPending(false);
  }
}

async function refreshGallery() {
  if (!authState.authenticated) {
    renderGallery([]);
    return;
  }
  const response = await apiFetch("/api/gallery");
  if (response.status === 401) {
    await refreshSessionState();
    return;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to load gallery");
  }
  const entries = await response.json();
  renderGallery(entries);
}

async function fetchJob(jobId) {
  const response = await apiFetch(`/api/jobs/${jobId}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Unknown API error" }));
    throw new Error(data.error || "Failed to fetch job");
  }
  return response.json();
}

async function fetchSiteConfig(slug) {
  const response = await apiFetch(`/api/sites/${slug}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Unknown API error" }));
    throw new Error(data.error || "Failed to fetch site config");
  }
  return response.json();
}

async function deleteSite(slug, title) {
  const response = await apiFetch(`/api/sites/${slug}/delete`, { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Failed to delete ${title}`);
  }
}

function stopJobPolling() {
  if (jobPollingTimer) {
    clearInterval(jobPollingTimer);
    jobPollingTimer = null;
  }
}

function stopGalleryPolling() {
  if (galleryPollingTimer) {
    clearInterval(galleryPollingTimer);
    galleryPollingTimer = null;
  }
}

function startGalleryPolling() {
  if (galleryPollingTimer || !authState.authenticated) return;
  galleryPollingTimer = setInterval(async () => {
    try {
      await refreshGallery();
    } catch {
      // Silent background polling.
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authState.authenticated) {
    setAuthMessage("Sign in before starting a build.", "error");
    return;
  }

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
  if (activeEditSite) {
    const parts = [];
    parts.push(startImageFile ? `Replacing start image with ${startImageFile.name}` : "Reusing current start image");
    parts.push(endImageFile ? `Replacing end image with ${endImageFile.name}` : "Reusing current end image");
    parts.push(videoFile ? `Replacing video with ${videoFile.name}` : "Reusing current video");
    setStatus(parts.join(" • "));
  } else {
    setStatus("Submitting build request...");
  }

  try {
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

    const response = await apiFetch("/api/build", {
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
  const deleteButton = event.target.closest("[data-delete-slug]");
  if (deleteButton) {
    const slug = deleteButton.getAttribute("data-delete-slug");
    const title = deleteButton.getAttribute("data-delete-title") || "this site";
    if (!slug) return;
    if (!window.confirm(`Delete ${title}? This will remove the generated site files permanently.`)) return;
    try {
      await deleteSite(slug, title);
      if (activeEditSite?.slug === slug) clearEditState();
      setStatus(`Deleted ${title}`);
      await refreshGallery();
    } catch (error) {
      setStatus(`Could not delete site: ${error.message}`);
    }
    return;
  }

  const editButton = event.target.closest("[data-edit-slug]");
  if (!editButton) return;
  openInlineEditor(editButton.getAttribute("data-edit-slug"));
});

startImageInput.addEventListener("change", refreshMediaStates);
endImageInput.addEventListener("change", refreshMediaStates);
videoInput.addEventListener("change", refreshMediaStates);

cancelEditButton.addEventListener("click", () => {
  clearEditState();
  setStatus("Edit cancelled");
  setStage("Waiting for a new request");
});

signInButton.addEventListener("click", () => {
  void submitAuth("/api/auth/sign-in");
});

signUpButton.addEventListener("click", () => {
  void submitAuth("/api/auth/sign-up");
});

googleAuthButton.addEventListener("click", () => {
  startGoogleAuth();
});

signOutButton.addEventListener("click", () => {
  void signOutSession();
});

setBusy(false);
setStage("Authentication required");
refreshMediaStates();
refreshSessionState()
  .then(async () => {
    if (authState.authenticated) {
      await refreshGallery();
      startGalleryPolling();
      setStage("Waiting for a new request");
      setStatus("Authenticated and ready.");
    }
  })
  .catch(() => {
    updateAuthUi();
  });
