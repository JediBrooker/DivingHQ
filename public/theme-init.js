// Apply the saved theme before first paint so there's no flash of
// the wrong theme. Loaded as a render-blocking classic script from
// the document <head> (see index.html) so it runs before the Vue
// module bundle (which is deferred). Served same-origin from /, so
// the strict script-src 'self' CSP allows it without a hash or
// nonce. The Pinia UI store (src/stores/ui.js) reads the same
// localStorage key and keeps this in sync at runtime, this file
// just handles the very first paint.
(function () {
  try {
    var t = localStorage.getItem('dhq-theme');
    if (t !== 'light' && t !== 'dark') t = 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
