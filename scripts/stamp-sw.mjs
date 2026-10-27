/**
 * stamps the built service worker with a per-build id.
 *
 * Why: browsers only notice a new service worker when /sw.js changes bytes. Vite
 * copies public/sw.js verbatim, so without this step two deploys that happen to
 * keep the same worker source would leave installed apps on the old cache
 * forever. The id is a hash of the built output, so every deploy that changes
 * anything produces a new worker, which the page turns into the
 * "New version available" prompt.
 *
 * Also writes dist/version.json - a cheap way to prove which build is live.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';
const SW = join(DIST, 'sw.js');
const PLACEHOLDER = '__BUILD__';

if (!existsSync(SW)) {
  console.error('[stamp-sw] dist/sw.js not found - did vite build run?');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const hash = createHash('sha256');
for (const file of walk(DIST).sort()) {
  const rel = relative(DIST, file).split('\\').join('/');
  if (rel === 'sw.js' || rel === 'version.json') continue;
  hash.update(rel);
  hash.update(String(statSync(file).size));
  hash.update(readFileSync(file));
}
// BUILD_ID forces a specific id (used by the QA harness to prove that a new
// deploy reaches installed apps); otherwise it is the hash of the build output.
const build = (process.env.BUILD_ID || hash.digest('hex').slice(0, 12)).replace(/[^A-Za-z0-9]/g, '');

const source = readFileSync(SW, 'utf8');
if (!source.includes(PLACEHOLDER)) {
  console.error(`[stamp-sw] ${PLACEHOLDER} marker missing from dist/sw.js`);
  process.exit(1);
}
writeFileSync(SW, source.split(PLACEHOLDER).join(build));

writeFileSync(
  join(DIST, 'version.json'),
  JSON.stringify({ version: build, built: new Date().toISOString() }, null, 2) + '\n',
);

console.log(`[stamp-sw] build ${build} stamped into dist/sw.js`);
