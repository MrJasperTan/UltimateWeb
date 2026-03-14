# fal.ai Model Notes

These defaults are used by `scripts/build_futuristic_site.mjs` and can be overridden with CLI flags.

## Default Models

- Start frame image: `fal-ai/nano-banana-2`
- End frame image (guided edit): `fal-ai/nano-banana-2/edit`
- Start/end image to video: `fal-ai/kling-video/v3/pro/image-to-video`

## Queue API Pattern

Use the queue endpoint:

`POST https://queue.fal.run/<model-id>`

Headers:
- `Authorization: Key $FAL_KEY`
- `Content-Type: application/json`

Body:
```json
{
  "...": "..."
}
```

The response includes request identifiers and URLs for polling and final output retrieval.

## Input Shapes Used By This Skill

### Start Frame
```json
{
  "prompt": "...",
  "num_images": 1,
  "aspect_ratio": "16:9",
  "resolution": "1K",
  "output_format": "png"
}
```

### End Frame
```json
{
  "prompt": "...",
  "image_urls": ["<start-image-url>"],
  "num_images": 1,
  "aspect_ratio": "16:9",
  "resolution": "1K",
  "output_format": "png"
}
```

### Video
```json
{
  "prompt": "...",
  "start_image_url": "<start-image-url>",
  "end_image_url": "<end-image-url>",
  "duration": "5",
  "generate_audio": false
}
```

## Overrides

If a model changes, override at runtime instead of editing code:

```bash
node scripts/build_futuristic_site.mjs \
  --topic "2025 Corvette Stingray" \
  --start-model "fal-ai/nano-banana-2" \
  --end-model "fal-ai/nano-banana-2/edit" \
  --video-model "fal-ai/kling-video/v3/pro/image-to-video"
```
