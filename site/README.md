# Landing page

Static, no build step. Deploy this folder as-is (Vercel: set the project's Root Directory to `site`).

Live at https://followthrough-eight.vercel.app (Vercel project `followthrough`, Root Directory `site`). `DEMO_URL` at the bottom of `index.html` points at the read-only demo (https://followthrough-demo-neon.vercel.app, built from `web/` with `bun run build:demo`); while it is empty the "Try the live demo" buttons stay hidden. `og:url`, `og:image` and `twitter:image` are absolute URLs because most link previews ignore relative image paths; update all three if the domain changes.

`og.png` is rendered from `design-reference/og/og.html` (headless Chrome, 1200x630).
