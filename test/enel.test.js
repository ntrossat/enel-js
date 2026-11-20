'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Enel = require('../enel.js');

const { createTracker } = Enel._internal;

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function fakeWindow(nav, extra) {
  return Object.assign({
    navigator: Object.assign({ userAgent: CHROME, webdriver: false, languages: ['en-US'] }, nav),
    outerWidth: 1280,
    outerHeight: 800,
    document: { querySelector: () => null },
  }, extra);
}

function ids(result) {
  return result.signals.map((s) => s.id);
}

test('a regular browser is not flagged', () => {
  const res = Enel.detect({ window: fakeWindow() });
  assert.strictEqual(res.isAgent, false);
  assert.strictEqual(res.confidence, 0);
  assert.deepStrictEqual(res.signals, []);
});

test('a declared AI user agent is named', () => {
  const res = Enel.detect({ window: fakeWindow({ userAgent: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)' }) });
  assert.strictEqual(res.isAgent, true);
  assert.strictEqual(res.confidence, 1);
  assert.strictEqual(res.agent, 'ChatGPT');
});

test('navigator.webdriver is flagged', () => {
  const res = Enel.detect({ window: fakeWindow({ webdriver: true }) });
  assert.strictEqual(res.isAgent, true);
  assert.deepStrictEqual(ids(res), ['webdriver']);
});

test('automation globals are flagged', () => {
  const res = Enel.detect({ window: fakeWindow({}, { __playwright__binding__: () => {} }) });
  assert.strictEqual(res.isAgent, true);
  assert.deepStrictEqual(ids(res), ['automation-globals']);
});

test('weak signals stay under the threshold alone and combine above it', () => {
  const one = Enel.detect({ window: fakeWindow({ languages: [] }) });
  assert.strictEqual(one.isAgent, false);
  assert.strictEqual(one.confidence, 0.4);

  const two = Enel.detect({ window: fakeWindow({ languages: [] }, { outerWidth: 0, outerHeight: 0 }) });
  assert.strictEqual(two.isAgent, true);
  assert.strictEqual(two.confidence, 0.64);
});

test('an injected agent marker is named', () => {
  const win = fakeWindow({}, {
    document: { querySelector: (sel) => (sel === '#claude-agent-stop-container' ? {} : null) },
  });
  const res = Enel.detect({ window: win });
  assert.strictEqual(res.isAgent, true);
  assert.strictEqual(res.agent, 'Claude in Chrome');
});

test('custom markers are supported', () => {
  const win = fakeWindow({}, { document: { querySelector: (sel) => (sel === '.my-agent' ? {} : null) } });
  const res = Enel.detect({ window: win, markers: [{ selector: '.my-agent', agent: 'Mine' }] });
  assert.strictEqual(res.agent, 'Mine');
});

function track() {
  const reports = [];
  let clock = 0;
  const tracker = createTracker((s) => reports.push(s), () => clock);
  return { reports, tracker, tick: (ms) => { clock += ms; } };
}

test('clicks with pointer travel are not flagged', () => {
  const { reports, tracker } = track();
  for (let i = 0; i < 10; i++) tracker.handle('mousemove', {});
  tracker.handle('click', { isTrusted: true, detail: 1, pointerType: 'mouse', clientX: 100, clientY: 100 });
  assert.deepStrictEqual(reports, []);
});

test('clicks that jump without pointer travel are flagged and escalate', () => {
  const { reports, tracker } = track();
  tracker.handle('click', { isTrusted: true, detail: 1, pointerType: 'mouse', clientX: 100, clientY: 100 });
  tracker.handle('click', { isTrusted: true, detail: 1, pointerType: 'mouse', clientX: 400, clientY: 300 });
  assert.deepStrictEqual(reports.map((r) => r.id), ['click-without-movement', 'click-without-movement']);
  assert.ok(reports[1].weight > reports[0].weight);
});

test('touch, keyboard and double clicks are ignored', () => {
  const { reports, tracker } = track();
  tracker.handle('click', { isTrusted: true, detail: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
  tracker.handle('click', { isTrusted: true, detail: 0, pointerType: 'mouse', clientX: 50, clientY: 50 });
  for (let i = 0; i < 5; i++) tracker.handle('mousemove', {});
  tracker.handle('click', { isTrusted: true, detail: 1, pointerType: 'mouse', clientX: 200, clientY: 200 });
  tracker.handle('click', { isTrusted: true, detail: 2, pointerType: 'mouse', clientX: 200, clientY: 200 });
  assert.deepStrictEqual(reports, []);
});

test('script-generated events are flagged', () => {
  const { reports, tracker } = track();
  tracker.handle('click', { isTrusted: false, detail: 0 });
  assert.deepStrictEqual(reports.map((r) => r.id), ['untrusted-event']);
});

test('metronomic typing is flagged, human typing is not', () => {
  const robot = track();
  for (let i = 0; i < 10; i++) {
    robot.tracker.handle('keydown', { isTrusted: true });
    robot.tick(50);
  }
  assert.strictEqual(robot.reports[0].id, 'robotic-typing');

  const human = track();
  for (const gap of [180, 95, 240, 130, 310, 75, 160, 220, 110, 270]) {
    human.tracker.handle('keydown', { isTrusted: true });
    human.tick(gap);
  }
  assert.deepStrictEqual(human.reports, []);
});
