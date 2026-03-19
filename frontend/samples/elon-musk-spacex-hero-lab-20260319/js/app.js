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

function updateLoader() {
  loaderBar.style.width = "100%";
  loaderPercent.textContent = "100%";
  loader.style.opacity = "0";
  setTimeout(() => {
    loader.style.display = "none";
  }, 400);
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
      heroFrameStage.style.transform = `translateY(${wipe * 2.5}vh)`;
    }
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

setupLoopingVideo(heroVideo, 0.6);
setupLoopingVideo(backgroundVideo, 0.8);
setupSmoothScroll();
placeSections();
setupHeroTransition();
setupSectionAnimations();
setupCounters();
setupMarquee();
setupDarkOverlay();
