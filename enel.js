/*! enel.js - identify AI agents on a webpage. No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Enel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Agents that announce themselves in the User-Agent header.
  const DECLARED_AGENTS = [
    [/ChatGPT-User/i, 'ChatGPT'],
    [/OAI-SearchBot/i, 'OAI-SearchBot'],
    [/GPTBot/i, 'GPTBot'],
    [/Claude-User/i, 'Claude'],
    [/Claude-SearchBot/i, 'Claude-SearchBot'],
    [/ClaudeBot/i, 'ClaudeBot'],
    [/Perplexity-User/i, 'Perplexity'],
    [/PerplexityBot/i, 'PerplexityBot'],
    [/MistralAI-User/i, 'Mistral'],
    [/meta-externalagent/i, 'Meta AI'],
    [/DuckAssistBot/i, 'DuckAssist'],
    [/Bytespider/i, 'Bytespider'],
    [/Amazonbot/i, 'Amazonbot'],
    [/CCBot/i, 'CCBot'],
    [/cohere-ai/i, 'Cohere'],
  ];

  // Elements that browser agents inject into the page while they are in control.
  const DOM_MARKERS = [
    { selector: '#claude-agent-stop-container', agent: 'Claude in Chrome' },
  ];

  // Globals left behind by browser automation frameworks.
  const AUTOMATION_GLOBALS = [
    '__playwright__binding__', '__pwInitScripts', '__playwright_evaluation_script__',
    '__puppeteer_evaluation_script__', '__nightmare', '_phantom', 'callPhantom',
    '__selenium_unwrapped', '__selenium_evaluate', '__webdriver_evaluate',
    '__driver_evaluate', '__webdriver_script_fn', '__fxdriver_unwrapped',
    'domAutomation', 'domAutomationController',
  ];

  function staticSignals(win) {
    const out = [];
    if (!win) return out;
    const nav = win.navigator || {};
    const ua = String(nav.userAgent || '');

    for (const [pattern, agent] of DECLARED_AGENTS) {
      if (pattern.test(ua)) {
        out.push({ id: 'declared-user-agent', weight: 1, agent, detail: agent });
        break;
      }
    }
    if (nav.webdriver === true) {
      out.push({ id: 'webdriver', weight: 0.9, detail: 'navigator.webdriver is true' });
    }
    if (/HeadlessChrome/i.test(ua)) {
      out.push({ id: 'headless-user-agent', weight: 0.9, detail: 'HeadlessChrome' });
    }

    const found = AUTOMATION_GLOBALS.filter((name) => name in win);
    // chromedriver adds properties such as document.$cdc_asdjflasutopfhvcZLmcfl_
    // or, in recent versions, window.cdc_adoQpoasnfa76pfcZLmcfl_Array
    for (const target of [win, win.document]) {
      if (!target) continue;
      for (const key of Object.keys(target)) if (/^\$?cdc_[a-zA-Z0-9]{22}_/.test(key)) found.push(key);
    }
    if (found.length) {
      out.push({ id: 'automation-globals', weight: 0.9, detail: found.join(', ') });
    }

    if (Array.isArray(nav.languages) && nav.languages.length === 0) {
      out.push({ id: 'no-languages', weight: 0.4, detail: 'navigator.languages is empty' });
    }
    // A tab that has never been shown also measures 0x0.
    const hidden = win.document && win.document.visibilityState === 'hidden';
    if (win.outerWidth === 0 && win.outerHeight === 0 && !hidden) {
      out.push({ id: 'no-window-size', weight: 0.4, detail: 'outer window size is 0x0' });
    }
    return out;
  }

  // Several markers can be the same injected UI, so only the first match counts.
  function markerSignals(doc, markers) {
    if (!doc || !doc.querySelector) return [];
    for (const marker of markers) {
      if (doc.querySelector(marker.selector)) {
        return [{ id: 'dom-marker', weight: 0.95, agent: marker.agent, detail: marker.selector }];
      }
    }
    return [];
  }

  // Independent signals combine as 1 - product(1 - weight).
  function combine(signals, threshold) {
    const list = signals.slice().sort((a, b) => b.weight - a.weight);
    let miss = 1;
    for (const s of list) miss *= 1 - s.weight;
    const confidence = Math.round((1 - miss) * 100) / 100;
    const named = list.find((s) => s.agent);
    return {
      isAgent: list.length > 0 && confidence >= threshold,
      confidence,
      agent: named ? named.agent : null,
      signals: list.map((s) => ({ id: s.id, weight: s.weight, detail: s.detail })),
    };
  }

  // Watches how the page is being operated. `handle` takes plain event-like
  // objects so it can be tested without a browser.
  function createTracker(report, now) {
    let moves = 0;
    let lastClick = null;
    let jumpClicks = 0;
    let lastKey = 0;
    let gaps = [];
    let pointer = null;

    function handle(type, e) {
      if (type === 'mousemove') { if (e.isTrusted !== false) moves++; return; }
      // Safari clicks carry no pointerType, so remember it from the press.
      if (type === 'pointerdown') { if (e.isTrusted !== false) pointer = e.pointerType; return; }

      if (e.isTrusted === false) {
        report({ id: 'untrusted-event', weight: 0.25, detail: 'script-generated ' + type });
        return;
      }

      if (type === 'click') {
        // detail is 0 for keyboard-activated clicks; touch and pen have no hover.
        const kind = e.pointerType || pointer;
        if (!(e.detail > 0) || (kind && kind !== 'mouse')) return;
        const moved = !lastClick ||
          Math.abs(e.clientX - lastClick.x) > 20 || Math.abs(e.clientY - lastClick.y) > 20;
        if (moved && moves < 3) {
          jumpClicks++;
          report({
            id: 'click-without-movement',
            weight: Math.min(0.8, Math.round((0.3 + 0.15 * (jumpClicks - 1)) * 100) / 100),
            detail: jumpClicks + ' click(s) with no pointer travel',
          });
        }
        lastClick = { x: e.clientX, y: e.clientY };
        moves = 0;
        return;
      }

      if (type === 'keydown') {
        if (e.repeat) return;
        // The event's own time: handlers can run late when the main thread stalls.
        const t = typeof e.timeStamp === 'number' ? e.timeStamp : now();
        if (lastKey && t - lastKey < 2000) gaps.push(t - lastKey);
        else gaps = [];
        lastKey = t;
        if (gaps.length > 8) gaps.shift();
        if (gaps.length === 8) {
          const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
          const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length);
          if (mean < 15 || sd < 8) {
            report({
              id: 'robotic-typing',
              weight: 0.4,
              detail: 'key interval ' + Math.round(mean) + 'ms, deviation ' + Math.round(sd) + 'ms',
            });
          }
        }
      }
    }

    return { handle };
  }

  // One-shot check of the environment. No listeners, no behavior analysis.
  function detect(options) {
    options = options || {};
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const markers = DOM_MARKERS.concat(options.markers || []);
    const signals = staticSignals(win).concat(markerSignals(win && win.document, markers));
    return combine(signals, options.threshold == null ? 0.5 : options.threshold);
  }

  // Continuous detection: environment, injected markers and behavior.
  function start(options) {
    options = options || {};
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = win && win.document;
    const threshold = options.threshold == null ? 0.5 : options.threshold;
    const markers = DOM_MARKERS.concat(options.markers || []);
    const signals = {};
    const cleanups = [];
    let detected = false;
    let stopped = false;

    function result() {
      return combine(Object.keys(signals).map((id) => signals[id]), threshold);
    }

    function add(signal) {
      const prev = signals[signal.id];
      if (prev && prev.weight >= signal.weight) return false;
      signals[signal.id] = signal;
      return true;
    }

    function notify() {
      if (stopped) return;
      const res = result();
      if (options.onChange) options.onChange(res);
      if (res.isAgent && !detected) {
        detected = true;
        if (options.onDetect) options.onDetect(res);
        if (win && win.dispatchEvent && typeof win.CustomEvent === 'function') {
          win.dispatchEvent(new win.CustomEvent('enel:detect', { detail: res }));
        }
      }
    }

    function report(signal) {
      if (add(signal)) notify();
    }

    // What is already there on load is announced once start() has returned,
    // so the caller holds the handle and can still listen for the event.
    const initial = staticSignals(win).concat(markerSignals(doc, markers));
    if (initial.filter((s) => add(s)).length) Promise.resolve().then(notify);

    if (doc && doc.addEventListener) {
      const tracker = createTracker(report, () => Date.now());
      for (const type of ['mousemove', 'pointerdown', 'click', 'keydown']) {
        const listener = (e) => tracker.handle(type, e);
        doc.addEventListener(type, listener, true);
        cleanups.push(() => doc.removeEventListener(type, listener, true));
      }
      if (typeof win.MutationObserver === 'function' && doc.documentElement) {
        const observer = new win.MutationObserver(() => markerSignals(doc, markers).forEach(report));
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
        cleanups.push(() => observer.disconnect());
      }
    }

    return {
      result,
      stop() { stopped = true; while (cleanups.length) cleanups.pop()(); },
    };
  }

  return { start, detect, _internal: { staticSignals, markerSignals, combine, createTracker } };
});
