const EXPERIENCE_UPGRADES = {"guidedScroll":{"enabled":false,"initialDelayMs":6000,"downDurationMs":112500,"upDurationMs":56250,"endPauseMs":3000,"resumeDelayMs":2000},"audio":{"enabled":false},"depthHero":{"enabled":false}};
const MEDIA_PLAYBACK = {"enabled":false,"loopMode":"loop","speed":1,"mobileFit":"contain"};
const FRAME_COUNT = 101;
const FRAME_SPEED = 1.0;
const FRAME_PATH = (index) => `frames/frame_${String(index + 1).padStart(4, "0")}.webp`;
const FRAME_WINDOW = 8;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const loader = document.getElementById("loader");
const loaderBar = document.getElementById("loader-bar");
const loaderPercent = document.getElementById("loader-percent");
const scrollContainer = document.getElementById("scroll-container");
const mediaStage = document.querySelector(".media-stage");
const canvasWrap = document.querySelector(".canvas-wrap");
const videoWrap = document.querySelector(".video-wrap");
const mainStageVideo = document.getElementById("main-stage-video");
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
let guidedModeOrigin = 0;
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
  if (MEDIA_PLAYBACK.enabled && mainStageVideo) {
    mediaStage.classList.add("is-video-playback");
    setupLoopingVideo(
      mainStageVideo,
      String(MEDIA_PLAYBACK.loopMode || "loop"),
      Number(MEDIA_PLAYBACK.speed || 1)
    );
    setLoaderProgress(45, "45%");
    if (mainStageVideo.readyState >= 2) {
      fallbackReady = true;
      finishLoader();
    } else {
      mainStageVideo.addEventListener("loadeddata", () => {
        fallbackReady = true;
        finishLoader();
      }, { once: true });
    }
    return;
  }

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
  guidedModeOrigin = window.scrollY;
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
    guidedModeOrigin = window.scrollY;
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
  lenis.scrollTo(guidedModeOrigin + (target - guidedModeOrigin) * eased, { immediate: true, force: true });
  if (progress >= 1) {
    if (guidedModePhase === "down") {
      guidedModePhase = "up";
      guidedModeOrigin = window.scrollY;
      guidedModeStartedAt = 0;
      guidedModeRaf = requestAnimationFrame(guidedModeStep);
      return;
    }
    guidedModePhase = "down";
    guidedModeOrigin = window.scrollY;
    guidedModeStartedAt = 0;
    guidedModeRaf = requestAnimationFrame(guidedModeStep);
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
  guidedModeOrigin = window.scrollY;
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
  const interrupt = (event) => {
    if (event?.target instanceof Node && guidedModeButton.contains(event.target)) return;
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
      if (guidedResumeTimer) {
        window.clearTimeout(guidedResumeTimer);
        guidedResumeTimer = 0;
      }
      stopGuidedMode(guidedModeButton, true);
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
  if (MEDIA_PLAYBACK.enabled) return;
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
      mediaStage.style.clipPath = `circle(${wipe * 75}% at 50% 50%)`;
      hero.style.setProperty("--scroll-shift-y", `${wipe * 2.5}vh`);
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
  if (!MEDIA_PLAYBACK.enabled) drawFallbackFrame(currentFrame);
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
