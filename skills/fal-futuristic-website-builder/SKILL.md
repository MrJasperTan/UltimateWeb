---
name: fal-futuristic-website-builder
description: End-to-end futuristic product website automation using fal.ai media generation plus scroll-driven frontend scaffolding. Use when the user asks for a site like "build a website about a 2025 Corvette Stingray" and wants the full pipeline handled automatically: first image, last image, start-end video, extracted frames, and assembled one-page website.
---

# Fal Futuristic Website Builder

Build an animated one-page product website from a single topic with minimal back-and-forth.

Follow the transcript-inspired workflow:
1. Plan first.
2. Generate start and end frames.
3. Generate transition video from those frames.
4. Convert video to frame sequence.
5. Assemble and iterate the scroll website.

## Quick Start

For a request like "Build a website about a 2025 Corvette Stingray", run:

```bash
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "2025 Corvette Stingray" \
  --out-dir generated-sites
```

Then preview:

```bash
cd generated-sites/2025-corvette-stingray
python3 -m http.server 8000
```

To run the interactive builder portal (topic input -> generation job -> clickable thumbnail):

```bash
node builder-portal/server.mjs
```

Open `http://localhost:8787`.

## Inputs

- Required:
  - Product topic via `--topic`
  - `FAL_KEY` provided either in `.env` at project root or as environment variable
- Optional:
  - `--brand "Brand Name"`
  - `--video-path /path/to/existing.mp4` to skip fal media generation
  - `--start-prompt`, `--end-prompt`, `--motion-prompt`
  - `--start-model`, `--end-model`, `--video-model`

## Outputs

The script creates:
- `media/start-frame.png`
- `media/end-frame.png`
- `media/transition.mp4`
- `frames/frame_0001.png ...`
- `index.html`
- `css/style.css`
- `js/app.js`
- `pipeline-metadata.json`

The portal creates the same site output under `generated-sites/<slug>/` and exposes:
- `/generated-sites/<slug>/index.html` (final site)
- `/generated-sites/<slug>/media/start-frame.png` (thumbnail shown in portal)

## Workflow

1. Convert vague requests into direct execution.
Ask at most one clarifying question only if blocked. Otherwise, assume premium defaults and proceed.

2. Generate media with fal.ai.
Run `scripts/build_futuristic_site.mjs` with the topic. The script uses Nano Banana 2 for first/last images and Kling 3.0 image-to-video for start-end motion by default.

3. Build the website from extracted frames.
The script runs ffmpeg extraction and scaffolds a premium scroll page with canvas frame rendering and GSAP section choreography.

4. Review locally, then iterate.
If the user gives feedback ("feature two appears too late"), update prompts or section ranges and rerun.

5. Keep the improvement loop.
After each iteration, preserve what worked in prompts and structure for the next generation request.

## Guardrails

- Never hardcode API keys in files. Use `FAL_KEY`.
- Treat fal generation as paid API usage; do not loop indefinitely on failures.
- Prefer local validation before deployment.
- Ensure `frames/` is committed/deployed, otherwise canvas animation breaks in production.

## References

- Model and endpoint notes: `references/fal-models.md`
- Source-video inspiration summary: `references/video-inspiration.md`

## Example Invocation

```bash
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "2025 Corvette Stingray" \
  --brand "Corvette Labs" \
  --out-dir generated-sites
```

If the user already has a transition video:
```bash
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "2025 Corvette Stingray" \
  --video-path /absolute/path/corvette-transition.mp4 \
  --out-dir generated-sites
```
