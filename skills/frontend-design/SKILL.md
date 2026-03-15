---
name: frontend-design
description: Guides creation of distinctive, production-grade frontend interfaces. Use as a design reference when building or iterating on generated websites to ensure they are visually unique, context-appropriate, and fully committed to a bold aesthetic vision.
---

# Frontend Design Skill

Design reference for creating unforgettable, production-grade frontend interfaces. Every generated site should look like it was crafted by a top-tier creative studio, not an AI template factory.

## Key Principles

### Design Thinking First
- Understand purpose, audience, and constraints before writing any code
- Choose a BOLD aesthetic direction (brutally minimal, maximalist chaos, retro-futuristic, editorial luxury, etc.)
- Focus on what makes the site UNFORGETTABLE — one strong idea beats ten safe ones
- Let the product/topic dictate the mood: a sports car demands aggressive geometry and speed lines; a wellness brand demands serene negative space and organic curves

### Aesthetics Focus

**Typography**
- Distinctive, characterful fonts — never default to Inter, Roboto, or Arial
- Consider display fonts that match the product mood: industrial (Bebas Neue, Oswald), editorial (Playfair Display, Cormorant), futuristic (Space Grotesk, Chakra Petch), luxe (Didot, Bodoni Moda)
- Mix weights dramatically: ultra-thin body text with heavy display headings, or vice versa
- Use typographic hierarchy as a design element itself (oversized numbers, micro-labels, stacked type)

**Color**
- Build cohesive palettes with CSS variables — dominant base, 1-2 accents, muted support tones
- Derive colors from the product/topic context (e.g., racing red for sports cars, ocean blues for marine products, earth tones for sustainability brands)
- Sharp accent contrasts over subtle gradients
- Dark mode as a default for premium/tech products; light mode for lifestyle/wellness
- Avoid generic purple-to-blue AI gradients

**Motion**
- High-impact animations: staggered reveals, scroll-triggered transforms, parallax layers
- CSS-first for performance; GSAP/Motion library for complex choreography
- Scroll-driven frame sequences for hero/product reveal (the project's core technique)
- Micro-interactions on hover/focus that reinforce the design language
- Loading sequences that build anticipation, not just fill time

**Spatial Composition**
- Unexpected layouts: asymmetric grids, overlapping elements, text that bleeds off-screen
- Generous negative space as a design element — not emptiness, but breathing room
- Full-viewport sections with strategic content placement (not centered-everything)
- Consider the scroll journey as a narrative arc: intro → build → climax → resolution

**Backgrounds & Texture**
- Gradient meshes, noise textures, geometric patterns for depth
- Dramatic shadows and ambient lighting effects via CSS
- Subtle grain overlays for tactile warmth on digital surfaces
- Background elements that respond to scroll position

### What to AVOID
- Generic AI aesthetics (purple gradients on white, overused Inter/Space Grotesk)
- Cookie-cutter card layouts that could be any SaaS landing page
- Safe, predictable color choices that don't connect to the product
- Centered-everything layouts with uniform spacing
- Stock placeholder copy that doesn't reflect real product attributes
- Animations that are decorative without purpose

## Implementation Rules

### Match Complexity to Vision
- **Maximalist design** = elaborate code with extensive animations, layered elements, complex interactions
- **Minimalist design** = restraint, precision, pixel-perfect details, subtle micro-animations
- Never half-commit: if the vision is bold, the code must be bold too

### Content Must Be Real
- Research the product/topic and use actual specifications, features, and descriptions
- Stats sections should contain real numbers, not placeholders
- Copy should sound like it was written by a brand copywriter who understands the product
- If real data isn't available, make informed estimates that feel authentic

### Responsive Is Non-Negotiable
- Every layout must work on mobile, tablet, and desktop
- Mobile isn't a scaled-down desktop — it's its own design with appropriate typography, spacing, and interaction patterns
- Touch targets ≥ 44px, readable text without zooming

### Performance Matters
- Preload critical assets (fonts, hero images)
- Lazy-load below-fold content
- CSS animations over JS where possible
- Image optimization: WebP/AVIF, appropriate sizing, srcset
- Frame sequences should show a loading state that matches the design

## Design Direction Examples

### Sports Car / Performance Vehicle
- Dark, aggressive palette (black, carbon grey, racing red/orange)
- Industrial typography (Bebas Neue, Oswald) with sharp angles
- Speed-inspired motion: fast reveals, sharp transitions
- Stats displayed as large-format data visualization
- Full-bleed imagery, minimal chrome

### Consumer Electronics / Tech Product
- Clean dark mode with neon accent (cyan, electric blue, mint)
- Monospace or geometric sans fonts
- Methodical reveal animations, precision timing
- Spec sheets as design elements, not afterthoughts
- Floating/isometric product views

### Luxury / Fashion
- High-contrast editorial layout (black & white with one accent)
- Serif display fonts, thin sans body text
- Slow, elegant animations with generous easing
- Abundant white space, text as texture
- Photography-led design, minimal UI elements

### Food / Beverage
- Warm, appetizing palette (amber, cream, deep greens)
- Friendly but premium typography (rounded sans, humanist serif)
- Organic motion: gentle fades, scale transitions
- Ingredient/origin storytelling as visual narrative
- Texture-rich backgrounds (paper, grain, fabric)

### Person / Public Figure / Athlete / Artist
- Design around the person's identity — their era, discipline, signature style
- Use portraiture as the dominant visual element; let the frame sequence be their motion (walking, performing, competing)
- Typography that channels their world: bold condensed for athletes, elegant serif for classical artists, raw hand-drawn for musicians
- Color palette drawn from their brand, team colors, album art, or cultural context (e.g., Lakers purple/gold for a Laker, neon pink for a pop star)
- Stats as biography: career milestones, records, achievements — presented as monumental data, not a Wikipedia table
- Timeline/journey narrative: origin story → rise → defining moment → legacy
- Quotes or lyrics as oversized typographic design elements
- Avoid hagiography — let facts and real accomplishments speak; tone should be editorial, not fan-page
- Motion style matches the person: explosive and fast for athletes, slow and deliberate for thinkers, rhythmic for musicians

### Place / City / Landmark / Destination
- Let the location's character dictate everything: Tokyo = neon density and precision; Patagonia = vast negative space and earth tones; Venice = warm stone textures and watercolor washes
- Hero imagery should capture the essence, not the postcard shot — atmosphere over landmarks
- Color palette extracted from the place itself: sky tones, architecture materials, vegetation, signage
- Typography that echoes local visual culture: geometric modernist for European cities, brush/calligraphic hints for Asian destinations, weathered serif for historic sites
- Stats as geography/culture: population, elevation, founded year, annual visitors, notable facts — presented as large-format environmental data
- Sections structured as a journey: arrival → exploration → signature experience → departure/reflection
- Map fragments, coordinates, or transit diagrams as subtle background design elements
- Ambient motion: slow parallax layers mimicking landscape depth, gentle atmospheric particles (rain, dust, light flares)
- Time-of-day mood: pick a specific lighting condition (golden hour, blue hour, midnight neon) and commit to it across the whole palette
- Avoid travel-brochure clichés — design it like an architectural monograph or a film location scouting deck

## Integration With Build Pipeline

This skill is referenced during the `writeScaffoldFiles()` phase of `build_futuristic_site.mjs`. When research data is available:

1. The research step gathers real product data (specs, features, descriptions)
2. `buildContentProfile()` uses that data to generate authentic content
3. The scaffold applies design principles from this skill based on the product category
4. Color palette, typography, and animation style are adapted to match the topic

The goal: every generated site should look like it was purpose-built for that specific product, not generated from a template.
