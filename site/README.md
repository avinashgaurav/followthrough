# Landing page

Static, no build step. Deploy this folder as-is (Vercel: set the project's Root Directory to `site`).

Live at https://followthrough-eight.vercel.app (Vercel project `followthrough`, Root Directory `site`). "Try the demo" points at the read-only demo (https://followthrough-demo-neon.vercel.app, built from `web/` with `bun run build:demo`). The `#try` section walks through it; people who want their own login are sent to a GitHub issue. The two videos stream from the `demo-videos-2026-11-04` GitHub release; their posters are in `media/`. `og:url`, `og:image` and `twitter:image` are absolute URLs because most link previews ignore relative image paths; update all three if the domain changes.

`og.png` is rendered from `design-reference/og/og.html` (headless Chrome, 1200x630).
