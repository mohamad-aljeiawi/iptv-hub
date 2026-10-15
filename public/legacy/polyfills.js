/* Polyfills for old browsers, such as Chrome 52 on Android 7 TV boxes. Only what
   the web interface uses. Loaded by the bootstrap in index.html before
   legacy/app.js, and never by modern browsers. Plain ES5 on purpose. */
(function () {
  'use strict';

  // Before Chrome 72, fetch sends no cookies unless asked, so every API call would
  // look logged out. Default to the same-origin credentials modern browsers use.
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      init = init || {};
      if (!init.credentials) init.credentials = 'same-origin';
      return nativeFetch.call(window, input, init);
    };
  }

  // Used by the compiler's helper for object spread in legacy/app.js.
  if (!Object.getOwnPropertyDescriptors) {
    Object.getOwnPropertyDescriptors = function (o) {
      var out = {};
      var keys = Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(o) : []);
      keys.forEach(function (k) { out[k] = Object.getOwnPropertyDescriptor(o, k); });
      return out;
    };
  }
  if (!Object.values)Object.values = function (o) { return Object.keys(o).map(function (k) { return o[k]; }); };
  if (!Object.entries) Object.entries = function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }); };
  if (!Object.fromEntries) {
    Object.fromEntries = function (pairs) {
      var o = {};
      Array.from(pairs).forEach(function (kv) { o[kv[0]] = kv[1]; });
      return o;
    };
  }

  if (!String.prototype.padStart) {
    String.prototype.padStart = function (len, fill) {
      var s = String(this);
      fill = fill === undefined ? ' ' : String(fill);
      while (s.length < len) s = fill + s;
      return s.slice(s.length - Math.max(len, String(this).length));
    };
  }

  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, self) {
      return this.reduce(function (out, x, i, a) { return out.concat(fn.call(self, x, i, a)); }, []);
    };
  }

  // IntersectionObserver arrived in Chrome 51, its entries' isIntersecting only in 58.
  // Without it the browse pages never load their next 40 titles.
  if (window.IntersectionObserverEntry && !('isIntersecting' in IntersectionObserverEntry.prototype)) {
    Object.defineProperty(IntersectionObserverEntry.prototype, 'isIntersecting', {
      get: function () { return this.intersectionRatio > 0; },
    });
  }

  // parent.append(child, ...)
  if (!Element.prototype.append) {
    Element.prototype.append = function () {
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
      }
    };
  }

  // addEventListener(type, fn, { once: true }) before Chrome 55 keeps the listener,
  // so it would fire again on every later event.
  var onceKnown = false;
  try {
    window.addEventListener('test', null, Object.defineProperty({}, 'once', { get: function () { onceKnown = true; } }));
  } catch (e) { /* no options object at all */ }
  if (!onceKnown) {
    var add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (!opts || typeof opts !== 'object' || !opts.once || typeof fn !== 'function') return add.call(this, type, fn, opts);
      var target = this, capture = !!opts.capture;
      var wrapper = function (e) { target.removeEventListener(type, wrapper, capture); return fn.call(this, e); };
      return add.call(this, type, wrapper, capture);
    };
  }

  // Only used to cancel a search that a newer one replaces; without real
  // cancellation the older answer is simply ignored.
  if (!window.AbortController) {
    window.AbortController = function () { this.signal = { aborted: false }; };
    window.AbortController.prototype.abort = function () { this.signal.aborted = true; };
  }

  // element.scrollBy({ left, top }) for the row arrows.
  if (!Element.prototype.scrollBy) {
    Element.prototype.scrollBy = function (x, y) {
      var o = typeof x === 'object' && x ? x : { left: x, top: y };
      this.scrollLeft += o.left || 0;
      this.scrollTop += o.top || 0;
    };
  }

  // Full screen exists only with the webkit prefix, and returns no promise.
  var E = Element.prototype;
  if (!E.requestFullscreen && E.webkitRequestFullscreen) {
    E.requestFullscreen = function () { this.webkitRequestFullscreen(); return Promise.resolve(); };
  }
  if (!document.exitFullscreen && document.webkitExitFullscreen) {
    document.exitFullscreen = function () { document.webkitExitFullscreen(); return Promise.resolve(); };
  }
  if (!('fullscreenElement' in document)) {
    Object.defineProperty(document, 'fullscreenElement', {
      get: function () { return document.webkitFullscreenElement || null; },
    });
  }

  // navigator.clipboard.writeText through the old copy command.
  if (!navigator.clipboard) {
    navigator.clipboard = {
      writeText: function (text) {
        return new Promise(function (ok, fail) {
          var t = document.createElement('textarea');
          t.value = text;
          t.setAttribute('readonly', '');
          t.style.position = 'fixed';
          t.style.opacity = '0';
          document.body.appendChild(t);
          t.select();
          var done = false;
          try { done = document.execCommand('copy'); } catch (e) { done = false; }
          document.body.removeChild(t);
          if (done) ok(); else fail(new Error('copy failed'));
        });
      },
    };
  }
})();
