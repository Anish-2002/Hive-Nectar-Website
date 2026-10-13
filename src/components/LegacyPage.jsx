import { useLayoutEffect } from 'react';
import { mountLegacy } from '../lib/legacy.js';

/**
 * Every original Hive Nectar page is imported here, verbatim, at build time.
 * The keys of the glob are relative paths (`../legacy/the-meadow.html`); the
 * component is addressed by bare file name so routes read like the original
 * URLs.
 */
const sources = import.meta.glob('../legacy/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const byFileName = {};
for (const [path, raw] of Object.entries(sources)) {
  byFileName[path.split('/').pop()] = raw;
}

/** File names of every legacy page shipped in this app (sorted). */
export const LEGACY_PAGES = Object.keys(byFileName).sort();

/**
 * Renders one original page 1:1 inside the React app.
 *
 * The component itself produces no markup: `mountLegacy` inserts the original
 * document body into `document.body` so that the vanilla CSS (`body > header`,
 * `body { display:flex }`, page-scoped `body.page-*` rules) applies unchanged.
 */
export default function LegacyPage({ file }) {
  useLayoutEffect(() => {
    const raw = byFileName[file];
    if (!raw) {
      console.error(`[legacy] no bundled source for "${file}"`);
      return undefined;
    }
    return mountLegacy(raw);
  }, [file]);

  return null;
}
