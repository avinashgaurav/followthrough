# Landing page

Static, no build step. Deploy this folder as-is (Vercel: set the project's Root Directory to `site`).

Before launch:
1. Set `DEMO_URL` at the bottom of `index.html` to the hosted demo. While it is empty the "Try the live demo" buttons stay hidden.
2. Change `og:image` / `twitter:image` to an absolute URL (e.g. `https://your-domain/og.png`) and add `og:url`; most link previews ignore relative image paths.

`og.png` is rendered from `design-reference/og/og.html` (headless Chrome, 1200x630).
