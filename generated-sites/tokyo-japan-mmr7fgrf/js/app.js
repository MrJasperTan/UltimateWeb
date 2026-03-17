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
const hero = document.querySelector(".hero-standalone");
const darkOverlay = document.getElementById("dark-overlay");

const frames = new Array(FRAME_COUNT);
const frameLoads = new Set();
let currentFrame = 0;
let fallbackReady = false;
let runtimeReady = false;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}

function drawImageToCanvas(img) {
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

function drawFrame(index) {
  const img = frames[index];
  if (!img) return;
  drawImageToCanvas(img);
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
  if (!fallbackReady) ensureFrame(0);
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
    }
  });
}

window.addEventListener("resize", () => {
  resizeCanvas();
  drawFallbackFrame(currentFrame);
});

resizeCanvas();
setupMedia();
setupSmoothScroll();
placeSections();
setupFrameBinding();
setupSectionAnimations();
setupCounters();
setupMarquee();
setupDarkOverlay();
setupHeroTransition();
