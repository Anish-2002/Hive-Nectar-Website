/* Password reveal toggle for the auth forms.
 *
 * Adds one accessible eye button inside every `.input-wrapper` that contains a
 * password input (login.html #loginPassword, join.html #signupPass, and the
 * in-app sign-in card the PWA shows in standalone mode).
 *
 * Why a separate file: login.html and join.html are byte-faithful legacy
 * documents mounted by src/lib/legacy.js. Re-creating their markup by hand is
 * how the React port drifted before, so the widget is attached at runtime
 * instead of edited into the HTML.
 *
 * The pages already load Font Awesome 6 (fa-eye / fa-eye-slash).
 */
(function () {
  'use strict';

  function setLabel(btn, shown) {
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    btn.title = shown ? 'Hide password' : 'Show password';
  }

  function enhance(input) {
    if (input.dataset.pwToggle === '1') return;
    var wrap = input.closest('.input-wrapper');
    if (!wrap) return;
    input.dataset.pwToggle = '1';
    wrap.classList.add('has-pw-toggle');

    var btn = document.createElement('button');
    btn.type = 'button';               // never submits the form
    btn.className = 'pw-toggle';
    btn.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    setLabel(btn, false);

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      var icon = btn.querySelector('i');
      if (icon) icon.className = shown ? 'fas fa-eye' : 'fas fa-eye-slash';
      setLabel(btn, !shown);
      try {
        input.focus({ preventScroll: true });
        var n = input.value.length;
        input.setSelectionRange(n, n);
      } catch (_) { /* type switched mid-selection: ignore */ }
    });

    wrap.appendChild(btn);
  }

  function init(root) {
    var scope = root || document;
    var inputs = scope.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) enhance(inputs[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(document); });
  } else {
    init(document);
  }
  window.addEventListener('load', function () { init(document); });

  window.MeadowPwToggle = { init: init };
})();
