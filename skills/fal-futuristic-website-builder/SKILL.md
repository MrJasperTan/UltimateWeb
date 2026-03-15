---
name: fal-futuristic-website-builder
description: End-to-end futuristic website automation using fal.ai media generation, topic research, and scroll-driven frontend scaffolding. Handles products, people, and places. Use when the user asks for a site like "build a website about a 2025 Corvette Stingray" or "build a website about Michael Jordan" or "build a website about Tokyo" and wants the full pipeline handled automatically: research, first image, last image, start-end video, extracted frames, and assembled one-page website with real content.
---

# Fal Futuristic Website Builder

Build an animated one-page website from a single topic with minimal back-and-forth. Works for products, people, and places.

Follow the workflow:
1. Plan first.
2. Research the topic (auto-detect category: car, person, place, or generic product).
3. Generate start and end frames (prompts adapted to category).
4. Generate transition video from those frames.
5. Convert video to frame sequence.
6. Assemble the scroll website with real researched content.

## Topic Categories

The pipeline auto-detects what kind of topic you're building for:

- **Car / Vehicle** — performance stats, powertrain specs, configuration CTA
- **Person / Public Figure** — biographical arc (origins → legacy), career achievements, editorial portrait imagery
- **Place / Destination** — arrival-to-exploration narrative, geography/culture stats, atmospheric landscape imagery
- **Generic Product** — product form, experience, launch timeline

Each category gets tailored image prompts, content sections, and stat blocks.

## Quick Start

```bash
# Product
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "2025 Corvette Stingray" --out-dir generated-sites

# Person
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "Michael Jordan" --out-dir generated-sites

# Place
node skills/fal-futuristic-website-builder/scripts/build_futuristic_site.mjs \
  --topic "Tokyo Japan" --out-dir generated-sites
```

Then preview:

```bash
cd generated-sites/<slug>
python3 -m http.server 8000
```

To run the interactive builder portal:

```bash
node builder-portal/server.mjs
```

Open `http://localhost:8787`.

## Research Step

Before scaffolding the website, the pipeline queries SearXNG to gather real data about the topic:

- Product specs, features, and descriptions
- Biographical details for people (born, nationality, achievements)
- Geographic/cultural facts for places (population, founded, area)
- Real snippets used as hero descriptions instead of generic copy

Research is automatic and gracefully degrades — if SearXNG is unreachable, the pipeline falls back to template content.

### Research Options

- `--searxng-url URL` — Override the SearXNG endpoint (default: `http://192.168.0.166:8888`)
- `--no-research` — Skip the research step entirely, use template content

## Inputs

- Required:
  - Topic via `--topic`
  - `FAL_KEY` provided either in `.env` at project root or as environment variable
- Optional:
  - `--brand "Brand Name"`
  - `--video-path /path/to/existing.mp4` to skip fal media generation
  - `--start-prompt`, `--end-prompt`, `--motion-prompt`
  - `--start-model`, `--end-model`, `--video-model`
  - `--searxng-url`, `--no-research`

## Outputs

The script creates:
- `media/start-frame.png`
- `media/end-frame.png`
- `media/transition.mp4`
- `frames/frame_0001.png ...`
- `index.html`
- `css/style.css`
- `js/app.js`
- `pipeline-metadata.json` (includes category, research summary)

## Workflow

1. Convert vague requests into direct execution.
Ask at most one clarifying question only if blocked. Otherwise, assume premium defaults and proceed.

2. Research the topic.
Query SearXNG for real product/person/place data. Extract specs, facts, and descriptions to populate the site with authentic content.

3. Generate media with fal.ai.
Run `scripts/build_futuristic_site.mjs` with the topic. Image prompts are adapted to the detected category (portrait for people, landscape for places, product shot for cars/products).

4. Build the website from extracted frames.
The script runs ffmpeg extraction and scaffolds a premium scroll page with canvas frame rendering, GSAP section choreography, and real researched content.

5. Review locally, then iterate.
If the user gives feedback ("feature two appears too late"), update prompts or section ranges and rerun.

6. Keep the improvement loop.
After each iteration, preserve what worked in prompts and structure for the next generation request.

## Design Reference

See `skills/frontend-design/SKILL.md` for design direction guidance per category (typography, color, motion, spatial composition). Every generated site should look purpose-built for its topic.

## Guardrails

- Never hardcode API keys in files. Use `FAL_KEY`.
- Treat fal generation as paid API usage; do not loop indefinitely on failures.
- Research gracefully degrades — never fail a build because search is unavailable.
- Prefer local validation before deployment.
- Ensure `frames/` is committed/deployed, otherwise canvas animation breaks in production.

## References

- Model and endpoint notes: `references/fal-models.md`
- Source-video inspiration summary: `references/video-inspiration.md`
- Frontend design principles: `../frontend-design/SKILL.md`
