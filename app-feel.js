/* Keep the installed PWA feeling native without blocking pinch-zoom.
   Visually impaired users need the browser's own scaling. */
(function appFeel() {
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.id !== 'sClose') return;
    setTimeout(function () {
      if (typeof flushDeferredRender === 'function') flushDeferredRender();
      else if (typeof renderAll === 'function') renderAll();
    }, 0);
  });
})();
