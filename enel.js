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
    const doc = win.document;
    if (doc) {
      // chromedriver adds properties such as document.$cdc_asdjflasutopfhvcZLmcfl_
      for (const key of Object.keys(doc)) if (/^\$?cdc_/.test(key)) found.push(key);
    }
    if (found.length) {
      out.push({ id: 'automation-globals', weight: 0.9, detail: found.join(', ') });
    }

    if (Array.isArray(nav.languages) && nav.languages.length === 0) {
      out.push({ id: 'no-languages', weight: 0.4, detail: 'navigator.languages is empty' });
    }
    if (win.outerWidth === 0 && win.outerHeight === 0) {
      out.push({ id: 'no-window-size', weight: 0.4, detail: 'outer window size is 0x0' });
    }
    return out;
  }

  function markerSignals(doc, markers) {
    const out = [];
    if (!doc || !doc.querySelector) return out;
    for (const marker of markers) {
      if (doc.querySelector(marker.selector)) {
        out.push({ id: 'dom-marker', weight: 0.95, agent: marker.agent, detail: marker.selector });
      }
    }
    return out;
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

    function handle(type, e) {
      if (type === 'mousemove') { moves++; return; }

      if (e.isTrusted === false) {
        report({ id: 'untrusted-event', weight: 0.25, detail: 'script-generated ' + type });
        return;
      }

      if (type === 'click') {
        // detail is 0 for keyboard-activated clicks; touch and pen have no hover.
        const mouse = e.detail > 0 && (e.pointerType == null || e.pointerType === 'mouse');
        if (!mouse) return;
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
        const t = now();
        if (lastKey && t - lastKey < 2000) gaps.push(t - lastKey);
        else gaps = [];
        lastKey = t;
        if (gaps.length >= 8) {
          const recent = gaps.slice(-8);
          const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
          const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) * (b - mean), 0) / recent.length);
          if (mean < 15 || sd < 8) {
            report({
              id: 'robotic-typing',
              weight: 0.5,
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

    function result() {
      return combine(Object.keys(signals).map((id) => signals[id]), threshold);
    }

    function report(signal) {
      const prev = signals[signal.id];
      if (prev && prev.weight >= signal.weight) return;
      signals[signal.id] = signal;
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

    staticSignals(win).forEach(report);
    markerSignals(doc, markers).forEach(report);

    if (doc && doc.addEventListener) {
      const tracker = createTracker(report, () => Date.now());
      for (const type of ['mousemove', 'click', 'keydown']) {
        const listener = (e) => tracker.handle(type, e);
        doc.addEventListener(type, listener, true);
        cleanups.push(() => doc.removeEventListener(type, listener, true));
      }
      if (typeof win.MutationObserver === 'function' && doc.documentElement) {
        const observer = new win.MutationObserver(() => markerSignals(doc, markers).forEach(report));
        observer.observe(doc.documentElement, { childList: true, subtree: true });
        cleanups.push(() => observer.disconnect());
      }
    }

    return {
      result,
      stop() { while (cleanups.length) cleanups.pop()(); },
    };
  }

  return { start, detect, _internal: { staticSignals, markerSignals, combine, createTracker } };
});
