/* js/emoji.js — the site renders NO emoji, by policy.
 *
 * Why a runtime net and not just clean strings: task/theme/audience/stage text comes from
 * the `tasks` table and the milestone JSON, where the pictograph is part of the stored key
 * ('Seeds' vs a pictograph-prefixed variant). Those keys MUST stay byte-exact in the database and
 * in every value="" / dataset, or task filtering and tier gating break. So the data keeps its
 * bytes and the *rendered* text is cleaned here, once, for every page.
 *
 * Two mechanisms:
 *   1. tidy()/stripEmoji()  — for strings that never reach the DOM: navigator.share text,
 *                             wa.me / mailto / sms bodies, email subjects.
 *   2. a MutationObserver   — cleans static markup, JS templates, DB values, toasts and
 *                             anything injected later, including attributes that are read
 *                             aloud or shown as tooltips.
 *
 * Never touches: <script>, <style>, <code>, <pre>, <textarea>, <noscript>, form control
 * values, or any attribute other than title / alt / placeholder / aria-label. An element
 * with class "meadow-emoji-keep" (and its subtree) is skipped entirely.
 *
 * Ranges are deliberately pictograph-only: arrows (→ U+2190-21FF), geometric shapes
 * (◼ U+25A0-25FF), dashes (– — U+2010-2015) and the © ™ marks are typography, not emoji,
 * and the copy uses them on purpose.
 */
(function () {
  'use strict';
  if (window.__meadowEmojiNet) return;
  window.__meadowEmojiNet = true;

  // Pictographs only. NOT \p{Extended_Pictographic}: that also matches © ® ™ ◼ ⏩, which are
  // typography here (the copy uses © ™ and the ◼/– shapes on purpose).
  var PICTO_G = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{203C}\u{2049}\u{2139}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;
  var PICTO_T = new RegExp(PICTO_G.source, 'u'); // non-global for .test() (no lastIndex state)

  function stripEmoji(s) {
    return String(s === null || s === undefined ? '' : s).replace(PICTO_G, '');
  }

  // strip + repair the spacing/punctuation the removal can leave behind
  function tidy(s) {
    return stripEmoji(s)
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?)\]])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // For text taken from the DOM: repair the spacing a removal leaves behind, but never rewrite
  // the indentation inside a multi-line template (that whitespace is layout, not content).
  // A DB label such as the canonical stage key arrives as pictograph + space + label, and this
  // is what turns it back into a clean, untrimmed-looking label.
  function cleanTextValue(raw) {
    if (!raw || !PICTO_T.test(raw)) return raw;
    var out = stripEmoji(raw);
    if (/\n/.test(raw)) return out; // multi-line markup: leave layout whitespace alone
    return out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?)\\]])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .trim();
  }

  window.stripEmoji = stripEmoji;
  window.meadowTidy = tidy;
  window.meadowCleanText = cleanTextValue;

  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];

  function skipEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP[el.tagName]) return true;
    return !!(el.classList && el.classList.contains('meadow-emoji-keep'));
  }

  function cleanNode(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      var v = node.nodeValue;
      if (v && PICTO_T.test(v)) node.nodeValue = cleanTextValue(v);
      return;
    }
    if (node.nodeType !== 1 || skipEl(node)) return;
    cleanAttrs(node);
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !PICTO_T.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return skipEl(n.parentNode) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      var raw = n.nodeValue;
      var cleaned = cleanTextValue(raw);
      if (cleaned !== raw) n.nodeValue = cleaned;
    }
    if (node.querySelectorAll) {
      var els = node.querySelectorAll('[title],[alt],[placeholder],[aria-label]');
      for (var i = 0; i < els.length; i++) cleanAttrs(els[i]);
    }
  }

  function cleanAttrs(el) {
    if (!el || !el.getAttribute || skipEl(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute(a);
      if (v && PICTO_T.test(v)) el.setAttribute(a, tidy(v));
    }
  }

  function start() {
    cleanNode(document.documentElement);
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') {
          cleanNode(r.target);
        } else if (r.type === 'childList') {
          for (var j = 0; j < r.addedNodes.length; j++) cleanNode(r.addedNodes[j]);
        } else {
          cleanAttrs(r.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  // <head> may still be parsing here, but documentElement already exists, so the observer
  // goes live immediately and body text is cleaned as it is inserted — nothing flashes.
  start();
})();
