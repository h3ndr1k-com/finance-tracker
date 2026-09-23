/* Lock pinch-zoom and iOS gesture zoom so the installed PWA stays in-range. */
(function lockAppViewport() {
  var vp = document.querySelector('meta[name="viewport"]');
  var content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  if (vp) vp.setAttribute('content', content);
  else {
    vp = document.createElement('meta');
    vp.setAttribute('name', 'viewport');
    vp.setAttribute('content', content);
    document.head.appendChild(vp);
  }
  var block = function (e) { e.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, block, { passive: false });
  });
})();
