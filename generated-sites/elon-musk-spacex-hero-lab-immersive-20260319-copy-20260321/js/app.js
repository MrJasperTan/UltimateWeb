const heroVideo = document.getElementById("hero-video");
const loader = document.getElementById("loader");
const loaderBar = document.getElementById("loader-bar");
const loaderPercent = document.getElementById("loader-percent");
const scrollContainer = document.getElementById("scroll-container");
const hero = document.querySelector(".hero-standalone");
const heroFrameStage = document.querySelector(".hero-frame-stage");
const videoStage = document.querySelector(".video-stage");
const backgroundVideo = document.getElementById("background-video");
const darkOverlay = document.getElementById("dark-overlay");
const guidedModeButton = document.getElementById("guided-mode-btn");
const soundToggleButton = document.getElementById("sound-toggle-btn");

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

function updateLoader() {
  loaderBar.style.width = "100%";
  loaderPercent.textContent = "100%";
  loader.style.opacity = "0";
  setTimeout(() => {
    loader.style.display = "none";
  }, 400);
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

function placeSections() {
  document.querySelectorAll(".scroll-section").forEach((section) => {
    const enter = Number(section.dataset.enter || 0);
    const leave = Number(section.dataset.leave || 100);
    section.style.top = `${(enter + leave) / 2}%`;
  });
}

function setupHeroTransition() {
  videoStage.style.clipPath = "circle(0% at 50% 50%)";
  videoStage.style.opacity = "0";
  ScrollTrigger.create({
    trigger: scrollContainer,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      const p = self.progress;
      hero.style.opacity = String(Math.max(0, 1 - p * 15));
      const wipe = Math.min(1, Math.max(0, (p - 0.01) / 0.06));
      videoStage.style.opacity = String(wipe);
      videoStage.style.clipPath = `circle(${wipe * 75}% at 50% 50%)`;
      heroFrameStage.style.setProperty("--scroll-shift-y", `${wipe * 2.5}vh`);
    }
  });
}

function updateGuidedModeUi() {
  if (!guidedModeButton) return;
  guidedModeButton.textContent = guidedModeActive
    ? "Guided Mode: On"
    : guidedModeDismissed
      ? "Resume Guided Mode"
      : "Guided Mode: Off";
  document.body.classList.toggle("guided-mode-active", guidedModeActive);
}

function stopGuidedMode(markDismissed = true) {
  guidedModeActive = false;
  if (markDismissed) guidedModeDismissed = true;
  if (guidedModeRaf) cancelAnimationFrame(guidedModeRaf);
  guidedModeRaf = 0;
  guidedModeOrigin = window.scrollY;
  guidedModePauseUntil = 0;
  updateGuidedModeUi();
}

function guidedModeStep(timestamp) {
  if (!guidedModeActive || !lenis) return;
  if (guidedModePauseUntil && timestamp < guidedModePauseUntil) {
    guidedModeRaf = requestAnimationFrame(guidedModeStep);
    return;
  }
  if (guidedModePauseUntil && timestamp >= guidedModePauseUntil) {
    guidedModePauseUntil = 0;
    guidedModePhase = "up";
    guidedModeOrigin = window.scrollY;
    guidedModeStartedAt = 0;
  }
  if (!guidedModeStartedAt) guidedModeStartedAt = timestamp;
  const duration = guidedModePhase === "down" ? 112500 : 56250;
  const elapsed = timestamp - guidedModeStartedAt;
  const progress = Math.min(1, elapsed / duration);
  const eased = 1 - Math.pow(1 - progress, 2.2);
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const isNearBottom = window.scrollY >= Math.max(0, maxScroll - 8);
  if (guidedModePhase === "down" && isNearBottom) {
    guidedModePauseUntil = timestamp + 3000;
    lenis.scrollTo(maxScroll, { immediate: true, force: true });
    guidedModeRaf = requestAnimationFrame(guidedModeStep);
    return;
  }
  const target = guidedModePhase === "down" ? maxScroll : 0;
  const nextScroll = guidedModeOrigin + (target - guidedModeOrigin) * eased;
  lenis.scrollTo(nextScroll, { immediate: true, force: true });
  if (progress >= 1) {
    if (guidedModePhase === "down") {
      guidedModePhase = "up";
      guidedModeOrigin = window.scrollY;
      guidedModeStartedAt = 0;
      guidedModeRaf = requestAnimationFrame(guidedModeStep);
      return;
    }
    stopGuidedMode(false);
    return;
  }
  guidedModeRaf = requestAnimationFrame(guidedModeStep);
}

function startGuidedMode() {
  if (!lenis || guidedModeActive) return;
  if (guidedResumeTimer) {
    window.clearTimeout(guidedResumeTimer);
    guidedResumeTimer = 0;
  }
  guidedModeActive = true;
  guidedModeStartedAt = 0;
  guidedModePauseUntil = 0;
  guidedModeOrigin = window.scrollY;
  guidedModePhase = window.scrollY >= Math.max(0, document.documentElement.scrollHeight - window.innerHeight - 8) ? "up" : "down";
  updateGuidedModeUi();
  guidedModeRaf = requestAnimationFrame(guidedModeStep);
}

function scheduleGuidedResume() {
  if (guidedResumeTimer) window.clearTimeout(guidedResumeTimer);
  guidedResumeTimer = window.setTimeout(() => {
    if (!guidedModeActive) {
      guidedModeDismissed = false;
      startGuidedMode();
    }
  }, 2000);
}

function bindGuidedModeInterrupts() {
  const interrupt = () => {
    if (guidedModeActive) stopGuidedMode(true);
    scheduleGuidedResume();
  };

  ["wheel", "touchstart", "keydown", "mousedown"].forEach((eventName) => {
    window.addEventListener(eventName, interrupt, { passive: true });
  });

  window.addEventListener("scroll", () => {
    const currentScrollY = window.scrollY;
    const delta = Math.abs(currentScrollY - lastKnownScrollY);
    lastKnownScrollY = currentScrollY;
    if (!guidedModeActive && delta > 2) {
      scheduleGuidedResume();
    }
  }, { passive: true });

  guidedModeButton?.addEventListener("click", () => {
    if (guidedModeActive) {
      stopGuidedMode(true);
      scheduleGuidedResume();
      return;
    }
    guidedModeDismissed = false;
    startGuidedMode();
  });
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

async function enableAmbientAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  if (!ambientAudioContext) {
    ambientAudioContext = new AudioContextClass();
  }
  await ambientAudioContext.resume();

  if (!ambientAudioEnabled) {
    const bass = createAudioVoice(ambientAudioContext, "triangle", 55, 0.018);
    const pad = createAudioVoice(ambientAudioContext, "sawtooth", 110, 0.008);
    const shimmer = createAudioVoice(ambientAudioContext, "sine", 220, 0.0035);
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
  if (soundToggleButton) soundToggleButton.textContent = "Sound: On";
}

function disableAmbientAudio() {
  if (ambientPulseTimer) {
    window.clearInterval(ambientPulseTimer);
    ambientPulseTimer = 0;
  }
  ambientAudioNodes.forEach((node) => {
    try {
      if (typeof node.stop === "function") node.stop();
    } catch {}
    try {
      if (typeof node.disconnect === "function") node.disconnect();
    } catch {}
  });
  ambientAudioNodes = [];
  ambientAudioEnabled = false;
  if (soundToggleButton) soundToggleButton.textContent = "Enable Sound";
}

function bindSoundToggle() {
  soundToggleButton?.addEventListener("click", async () => {
    if (ambientAudioEnabled) {
      disableAmbientAudio();
      return;
    }
    try {
      await enableAmbientAudio();
    } catch {
      if (soundToggleButton) soundToggleButton.textContent = "Sound Unavailable";
    }
  });
}

function setupHeroDepth() {
  const updateDepth = (clientX, clientY) => {
    const bounds = hero.getBoundingClientRect();
    const x = ((clientX - bounds.left) / bounds.width - 0.5) * 2;
    const y = ((clientY - bounds.top) / bounds.height - 0.5) * 2;
    hero.style.setProperty("--depth-x", x.toFixed(3));
    hero.style.setProperty("--depth-y", y.toFixed(3));
  };

  hero.addEventListener("pointermove", (event) => updateDepth(event.clientX, event.clientY));
  hero.addEventListener("pointerleave", () => {
    hero.style.setProperty("--depth-x", "0");
    hero.style.setProperty("--depth-y", "0");
  });
}

function setupLoopingVideo(video, rate = 1) {
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.playbackRate = rate;
  video.addEventListener("canplay", () => {
    video.playbackRate = rate;
    video.play().catch(() => {});
  });
  video.addEventListener("loadeddata", () => {
    video.playbackRate = rate;
  });
  video.addEventListener("ended", () => {
    video.currentTime = 0;
    video.playbackRate = rate;
    video.play().catch(() => {});
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
        wrap.style.opacity = self.progress > 0.15 && self.progress < 0.9 ? "1" : "0";
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

window.addEventListener("load", updateLoader);
window.addEventListener("load", () => {
  window.setTimeout(() => {
    if (!guidedModeDismissed) startGuidedMode();
  }, 6000);
});

setupLoopingVideo(heroVideo, 0.6);
setupLoopingVideo(backgroundVideo, 0.8);
setupSmoothScroll();
bindGuidedModeInterrupts();
bindSoundToggle();
setupHeroDepth();
placeSections();
setupHeroTransition();
setupSectionAnimations();
setupCounters();
setupMarquee();
setupDarkOverlay();
