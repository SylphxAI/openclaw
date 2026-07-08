// =============================================================================
// Chromium Stealth Injection — Anti-Detection Property Overrides
// =============================================================================
// Runs at document_start in MAIN world (direct page context) on all frames.
// Zero performance impact: one-time property overrides only, no polling.
// =============================================================================

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. navigator.deviceMemory — report realistic 8 GB
  // -------------------------------------------------------------------------
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function () { return 8; },
      enumerable: true,
      configurable: true,
    });
  } catch (_) { /* already defined, skip */ }

  // -------------------------------------------------------------------------
  // 2. chrome.runtime — mimic a real Chrome install with extension API stubs
  // -------------------------------------------------------------------------
  try {
    if (typeof window.chrome === 'undefined') {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      const noop = function () {};
      // Create functions that pass toString() checks
      const makeNative = function (fn, name) {
        Object.defineProperty(fn, 'toString', {
          value: function () { return 'function ' + name + '() { [native code] }'; },
          writable: false,
          enumerable: false,
          configurable: true,
        });
        return fn;
      };
      window.chrome.runtime = {
        id: undefined, // real Chrome returns undefined when no extension context
        connect: makeNative(function connect() {}, 'connect'),
        sendMessage: makeNative(function sendMessage() {}, 'sendMessage'),
        getManifest: makeNative(function getManifest() {}, 'getManifest'),
        getURL: makeNative(function getURL(path) { return ''; }, 'getURL'),
        onConnect: { addListener: noop, removeListener: noop, hasListener: noop },
        onMessage: { addListener: noop, removeListener: noop, hasListener: noop },
      };
    }
  } catch (_) { /* skip */ }

  // -------------------------------------------------------------------------
  // 3. WebGL renderer & vendor spoofing
  //    Override getParameter() to return realistic GPU info instead of
  //    SwiftShader signatures which are a dead giveaway for headless.
  // -------------------------------------------------------------------------
  const SPOOFED_VENDOR = 'Intel Inc.';
  const SPOOFED_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)';

  // WebGL debug extension constants
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;

  const spoofGetParameter = function (proto) {
    if (!proto || !proto.getParameter) return;
    const original = proto.getParameter;
    const patched = function getParameter(param) {
      if (param === UNMASKED_VENDOR_WEBGL) return SPOOFED_VENDOR;
      if (param === UNMASKED_RENDERER_WEBGL) return SPOOFED_RENDERER;
      return original.call(this, param);
    };
    // Pass toString() check
    Object.defineProperty(patched, 'toString', {
      value: function () { return 'function getParameter() { [native code] }'; },
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(patched, 'name', { value: 'getParameter' });
    Object.defineProperty(patched, 'length', { value: 1 });
    Object.defineProperty(proto, 'getParameter', {
      value: patched,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };

  try { spoofGetParameter(WebGLRenderingContext.prototype); } catch (_) {}
  try { spoofGetParameter(WebGL2RenderingContext.prototype); } catch (_) {}

  // -------------------------------------------------------------------------
  // 4. navigator.plugins & mimeTypes — ensure non-empty (headless has [])
  // -------------------------------------------------------------------------
  try {
    if (navigator.plugins.length === 0) {
      const fakePlugin = {
        name: 'Chrome PDF Plugin',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer',
        length: 1,
        item: function (i) { return this[0]; },
        namedItem: function (name) { return this[0]; },
        0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
      };
      Object.defineProperty(navigator, 'plugins', {
        get: function () {
          const arr = [fakePlugin];
          arr.item = function (i) { return arr[i]; };
          arr.namedItem = function (name) { return arr.find(function (p) { return p.name === name; }) || null; };
          arr.refresh = function () {};
          return arr;
        },
        enumerable: true,
        configurable: true,
      });
    }
  } catch (_) {}

  // -------------------------------------------------------------------------
  // 5. Permissions API — make 'notifications' return 'default' not 'denied'
  //    (headless Chrome denies everything, real browsers ask)
  // -------------------------------------------------------------------------
  try {
    const origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function (desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery.call(this, desc);
    };
  } catch (_) {}

})();
