# Transcript-Inspired Workflow Summary

Source used: `tactiq-free-transcript-q0TgUtj6vIs.txt`

This skill follows the same core execution pattern from the video:

1. Treat "premium animation sites" as a video-to-frames problem.
- Build or source a short cinematic video.
- Extract frame sequence.
- Bind frame index to scroll progress.

2. Use two endpoint images to control motion direction.
- Generate a clean first frame.
- Generate a transformed final frame.
- Animate from first to final with an image-to-video model.

3. Plan before writing files.
- Produce a clear plan first.
- Ask only minimal input questions.
- Then execute the full build.

4. Iterate quickly with local feedback.
- First pass should be usable.
- Fix timing and section reveal issues in the next pass.
- Keep successful fixes in the skill instructions/prompts.

5. Ship with deployment awareness.
- Validate locally before deploy.
- Ensure `frames/` assets are included in GitHub/Vercel deployments.
- Missing frame assets break canvas rendering even if page text still loads.

6. Maintain a predictable structure.
- Keep one output folder per website generation.
- Separate `media`, `frames`, and frontend files for easier reruns.
