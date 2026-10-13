/**
 * ============================================================================
 * legacy.js — faithful legacy-document mounting engine
 * ============================================================================
 *
 * The React app must be a *carbon copy* of the vanilla Hive Nectar / The
 * Meadow site: same markup, same CSS, same behaviour, nothing added, nothing
 * lost.  Rather than re-typing 6,300 lines of HTML into JSX (which always
 * drifts), this engine mounts the original document verbatim:
 *
 *   1. the original <body> markup is inserted into document.body as real DOM
 *      nodes — byte for byte, with no attribute transformation, so inline
 *      `onclick=` handlers, custom attributes, comments and whitespace all
 *      survive exactly as authored;
 *   2. the original <body> attributes (class="page-…", data-theme, data-loading)
 *      are applied to <body> so every page-scoped CSS rule matches;
 *   3. the original page-specific stylesheets (<link rel="stylesheet">) and
 *      <style> blocks are injected into <head> (style.css and Font Awesome are
 *      global, exactly like the original site);
 *   4. the original <script> tags are re-created and executed in document
 *      order, with no cache-buster — a bare module URL is shared with the
 *      sibling scripts that import it, so each module is evaluated once, and
 *      each real page load is a fresh document (see main.jsx);
 *   5. a synthetic DOMContentLoaded event is dispatched afterwards so the
 *      legacy scripts' own boot handlers (js/app.js) run exactly once, with
 *      `window.location.pathname` still ending in `.html` so every
 *      path check inside app.js matches.
 *
 * Everything injected is tracked and removed by the returned teardown
 * function, so navigating between routes leaves no residue.
 */

/** Attributes this engine owns on <body>; restored on teardown. */
const MANAGED_BODY_ATTRS = ['class', 'data-theme', 'data-loading', 'data-page'];

let baselineBodyAttrs = null;
let baselineTitle = null;
let activeMount = null;

/** Snapshot <body> exactly as index.html declares it (done once). */
function captureBaseline() {
  if (baselineBodyAttrs) return;
  baselineBodyAttrs = Array.from(document.body.attributes).map((a) => [a.name, a.value]);
  baselineTitle = document.title;
}

/** Put <body> back to its baseline attribute set. */
function restoreBody() {
  Array.from(document.body.attributes).forEach((a) => document.body.removeAttribute(a.name));
  (baselineBodyAttrs || []).forEach(([name, value]) => document.body.setAttribute(name, value));
}

/** Remove everything a previous mount injected. */
export function teardownLegacy() {
  if (!activeMount) return;
  const { contentNodes, headNodes, scriptNodes, shellToggles, blobUrls } = activeMount;
  scriptNodes.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  contentNodes.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  headNodes.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  // Put the shell stylesheets back the way index.html declares them.
  (shellToggles || []).forEach(([link, disabled]) => {
    link.disabled = disabled;
  });
  // Release the inline-module blobs.
  (blobUrls || []).forEach((u) => URL.revokeObjectURL(u));
  MANAGED_BODY_ATTRS.forEach((a) => document.body.removeAttribute(a));
  if (baselineBodyAttrs) {
    baselineBodyAttrs.forEach(([name, value]) => document.body.setAttribute(name, value));
  }
  document.title = baselineTitle ?? document.title;
  activeMount = null;
}

/** Stylesheets the React shell already loads globally (never duplicated). */
function isGlobalStylesheet(href) {
  if (!href) return true;
  if (/font-awesome/i.test(href)) return true;
  if (/(^|\/)style\.css$/i.test(href)) return true;
  return false;
}

/**
 * Mount an original HTML document into the running React app.
 *
 * @param {string} raw  full text of the original .html file
 * @returns {() => void} teardown function
 */
export function mountLegacy(raw) {
  teardownLegacy();
  captureBaseline();

  // Every original file starts with a UTF-8 BOM (U+FEFF). A browser strips it
  // while decoding, but DOMParser is handed the string directly and U+FEFF is
  // *not* ASCII whitespace — the HTML parser therefore treats it as a text
  // character, which flips the insertion mode out of "in head" and dumps the
  // whole <head> (meta/title/link) into <body>. Dropping it restores exactly
  // the document structure a real page load produces.
  const doc = new DOMParser().parseFromString(raw.replace(/^\uFEFF/, ''), 'text/html');
  const contentNodes = [];
  const headNodes = [];
  const scriptNodes = [];
  const shellToggles = [];
  const blobUrls = [];

  /* ---- <title> ---------------------------------------------------------- */
  if (doc.title) document.title = doc.title;

  /* ---- shell stylesheets the page does not declare ---------------------- */
  // index.html links style.css and Font Awesome so the shell is never
  // unstyled. A page that does not declare one of them must not inherit it,
  // or it renders with a theme the original never had: preview.html is a
  // Tailwind-only document linking neither sheet.
  const declaredSheetHrefs = new Set(
    Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]')).map((l) =>
      new URL(l.getAttribute('href') || '', window.location.href).href,
    ),
  );
  document.querySelectorAll('link[data-shell-css]').forEach((link) => {
    const wasDisabled = link.disabled;
    link.disabled = !declaredSheetHrefs.has(link.href);
    shellToggles.push([link, wasDisabled]);
  });

  /* ---- <body> attributes ------------------------------------------------ */
  restoreBody();
  Array.from(doc.body.attributes).forEach((a) => {
    if (a.name === 'class') {
      document.body.className = a.value;
    } else {
      document.body.setAttribute(a.name, a.value);
    }
  });

  /* ---- page-specific <head> styles ------------------------------------- */
  doc.head.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    let el;
    if (node.tagName === 'LINK') {
      const href = node.getAttribute('href') || '';
      if (isGlobalStylesheet(href)) return;
      el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
    } else {
      el = document.createElement('style');
      el.textContent = node.textContent;
    }
    el.setAttribute('data-legacy-head', '');
    document.head.appendChild(el);
    headNodes.push(el);
  });

  /* ---- <body> markup, verbatim ----------------------------------------- */
  // <script> elements are stripped from the fragment (they are inert when
  // parsed as a fragment anyway) and re-created below so their order and
  // module type are controlled.
  const bodyHtml = doc.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi, '');
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const fragment = range.createContextualFragment(bodyHtml);
  const injected = Array.from(fragment.childNodes);
  document.body.appendChild(fragment);
  contentNodes.push(...injected);

  /* ---- original scripts, in document order ------------------------------ */
  const scriptTags = Array.from(doc.querySelectorAll('script'));
  const runScripts = async () => {
    for (const tag of scriptTags) {
      const el = document.createElement('script');
      const type = tag.getAttribute('type');
      if (type) el.setAttribute('type', type);

      const src = tag.getAttribute('src');
      if (src) {
        let url = new URL(src, window.location.href).href;
        // NOTE: no cache-buster is applied here, deliberately. The originals
        // are multi-page documents in which each navigation loads a fresh
        // module graph. Adding `?hv=N` would make `js/app.js` a *different*
        // module URL from the bare `/js/app.js` that sibling scripts import
        // (`js/notification.js` and several inline modules do exactly that),
        // so the module would be evaluated twice per page — registering a
        // duplicate realtime channel and tripping the app's own error guard.
        // Every real page load is a fresh document (see main.jsx: Back/Forward
        // reloads), so the browser's per-document module cache is exactly the
        // behaviour the originals have.
        el.setAttribute('src', url);
        tag.getAttributeNames().forEach((name) => {
          if (name !== 'src' && name !== 'type') el.setAttribute(name, tag.getAttribute(name));
        });
        const loaded = new Promise((resolve) => {
          el.onload = resolve;
          el.onerror = resolve;
        });
        document.body.appendChild(el);
        scriptNodes.push(el);
        await loaded;
      } else if (type === 'module') {
        // An inline module fires no load event, so the engine cannot tell when
        // its graph has finished evaluating — and `js/app.js` registers its
        // bootstrap on DOMContentLoaded *from inside* that graph (the page's
        // inline module imports it). Dispatching DOMContentLoaded before the
        // graph lands means app.js's listener is never installed and the page
        // silently loses its theme and its behaviour.
        //
        // Re-homing the source on a blob: URL gives the browser a real script
        // to load, so `onload` fires exactly when the whole graph (inline
        // module + js/app.js + its own imports) has been evaluated. Relative
        // specifiers are rewritten to absolute first, because a blob: URL has
        // an opaque path and cannot resolve './js/app.js' against itself.
        const base = window.location.href;
        // Three specifier forms appear in the original inline modules:
        //   import { x } from './js/app.js'   (from-clause)
        //   import './js/app.js'              (side-effect import)
        //   import('./js/app.js')             (dynamic)
        // All of them must be absolutised — a blob: base resolves none of them.
        const code = tag.textContent.replace(
          /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]*)\2/g,
          (_m, lead, quote, spec) => lead + quote + new URL(spec, base).href + quote,
        );
        const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        blobUrls.push(blobUrl);
        el.setAttribute('src', blobUrl);
        const loaded = new Promise((resolve) => {
          el.onload = resolve;
          el.onerror = resolve;
        });
        document.body.appendChild(el);
        scriptNodes.push(el);
        await loaded;
      } else {
        el.textContent = tag.textContent;
        document.body.appendChild(el);
        scriptNodes.push(el);
      }
    }

    /* The legacy bootstrap (js/app.js) registers its initialiser on
       DOMContentLoaded, which has long since fired by the time the SPA is up.
       Re-dispatch it so the original logic runs exactly as it does on a real
       page load. */
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    document.dispatchEvent(new Event('load'));
  };

  activeMount = { contentNodes, headNodes, scriptNodes, shellToggles, blobUrls };
  runScripts();

  return teardownLegacy;
}
