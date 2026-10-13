import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The React app serves the *original* URLs of the vanilla site
 * (`/the-meadow.html`, `/profile.html`, `/board.html`, …).
 *
 * Those files deliberately do not exist in `public/` — the SPA renders them —
 * so the shell must answer them. This middleware rewrites any `*.html` request
 * (except the shell entry point itself) to `/index.html`, which is exactly the
 * behaviour of the GitHub Pages 404 fallback the live site relies on.
 */
function legacyHtmlFallback() {
  // Only a *top-level page* URL is rewritten: exactly one path segment ending
  // in `.html` (`/the-meadow.html`). Anything under a directory — most
  // importantly Vite's own `/src/legacy/…html?raw` module requests — must be
  // left alone, otherwise the raw-text imports get rewritten to the shell and
  // Vite tries to transform them as JavaScript.
  const PAGE_URL = /^\/[^/]+\.html$/
  const rewrite = (req, _res, next) => {
    const path = (req.url || '').split('?')[0]
    if (PAGE_URL.test(path) && path !== '/index.html') req.url = '/index.html'
    next()
  }
  return {
    name: 'legacy-html-fallback',
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), legacyHtmlFallback()],
  // Dedicated ports so this app never collides with the morning port (5199)
  // or the static tree servers (5173 / 5200).
  server: { port: 5210, strictPort: true },
  preview: { port: 5211, strictPort: true },
  optimizeDeps: {
    // The original pages live in src/legacy/ and are pulled in as raw text
    // (import ... ?raw) so their markup can be injected verbatim. Vite's
    // dependency scanner must not treat their <script src="js/…"> tags as
    // app imports — only the shell entry point is a real entry.
    entries: ['index.html'],
  },
})
