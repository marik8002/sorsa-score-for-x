const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const coreSource = path.join(__dirname, '..', 'core.js');
const contentScriptSource = path.join(__dirname, '..', 'content-script.js');

async function createPage(html, {
  scores = { mika8002: 870 },
  onScoreRequest,
  now,
  url = 'https://x.com/home',
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (now) window.Date.now = now;
  const requests = [];
  const messages = [];
  const storageListeners = [];
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === 'SORSA_GET_SCORE') requests.push(message.handle);
        messages.push(message);
        if (onScoreRequest) {
          onScoreRequest(message, callback);
          return;
        }
        queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
          ? { score: scores[message.handle] ?? null, source: 'public' }
          : { premium: false }));
      },
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
  };
  window.eval(await readFile(coreSource, 'utf8'));
  window.eval(await readFile(contentScriptSource, 'utf8'));
  return {
    dom,
    window,
    requests,
    messages,
    emitStorageChanges(changes) {
      for (const listener of storageListeners) listener(changes, 'local');
    },
  };
}

function afterNextFrame(window) {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('shows and refreshes bots only beside the canonical profile header', async (t) => {
  const html = '<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div class="counts"><div><a href="/mika8002/following">2,090 Following</a></div><div><a href="/mika8002/verified_followers">4,568 Followers</a></div></div></div><article><div data-testid="User-Name"><a href="/mika8002">@mika8002</a></div></article>';
  const { dom, window, messages, emitStorageChanges } = await createPage(html, {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
        ? { score: 870 }
        : { premium: true, latest: { value: 17.8, lastUpdate: 1790674814 } }));
    },
  });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  const widget = window.document.querySelector('.sorsa-bot-widget');
  assert.equal(window.document.querySelectorAll('.sorsa-bot-widget').length, 1);
  assert.equal(widget.parentElement.className, 'counts');
  assert.equal(widget.previousElementSibling.querySelector('a').getAttribute('href'), '/mika8002/verified_followers');
  assert.equal(widget.querySelector('.sorsa-bot-value').nextElementSibling.tagName, 'BUTTON');
  assert.equal(window.document.querySelector('[data-testid="UserName"] .sorsa-bot-widget'), null);
  assert.match(widget.textContent, /Bots 18%/);
  assert.match(widget.title, /Last update: Sep 29, 2026/);
  assert.ok(widget.querySelector('button svg path'));
  const botStyles = window.document.getElementById('sorsa-score-styles').textContent;
  assert.match(botStyles, /sorsa-bot-widget \{[^}]*font: 400 14px\/16px/);
  assert.match(botStyles, /sorsa-bot-widget \{[^}]*vertical-align: middle/);
  assert.match(botStyles, /sorsa-bot-widget button \{[^}]*border: 0/);
  widget.querySelector('button').click();
  assert.equal(widget.classList.contains('sorsa-bot-updating'), true);
  assert.match(widget.textContent, /Bots 18%/);
  await wait(0);
  assert.equal(messages.some((message) => message.type === 'SORSA_REFRESH_BOTS'), true);
  emitStorageChanges({ 'sorsa-show-bots': { newValue: false } });
  assert.equal(window.document.querySelector('.sorsa-bot-widget'), null);
});

test('keeps bot refresh blocked through a profile rerender while the request is pending', async (t) => {
  let refreshCalls = 0;
  let finishRefresh;
  const { dom, window } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div><div><a href="/mika8002/followers">4,568 Followers</a></div></div></div>', {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      if (message.type === 'SORSA_REFRESH_BOTS') {
        refreshCalls += 1;
        finishRefresh = callback;
      } else queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
        ? { score: 956 }
        : { premium: true, latest: { value: 9.07 } }));
    },
  });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  const widget = window.document.querySelector('.sorsa-bot-widget');
  const button = widget.querySelector('button');
  button.click();
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  assert.equal(button.disabled, true);
  assert.equal(widget.classList.contains('sorsa-bot-updating'), true);
  widget.parentElement.outerHTML = '<div><div><a href="/mika8002/followers">4,568 Followers</a></div></div>';
  await afterNextFrame(window);
  await wait(0);
  const replacement = window.document.querySelector('.sorsa-bot-widget');
  assert.notEqual(replacement, widget);
  assert.equal(replacement.querySelector('button').disabled, true);
  replacement.querySelector('button').click();
  assert.equal(refreshCalls, 1);
  finishRefresh({ premium: true, latest: { value: 9.07 }, updating: false });
  await wait(0);
  assert.equal(replacement.querySelector('button').disabled, false);
  assert.equal(replacement.classList.contains('sorsa-bot-updating'), false);
});

test('a Sorsa task already waiting blocks refresh without spinning or starting another update', async (t) => {
  const { dom, window, messages } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div class="counts"><div><a href="/mika8002/followers">4,568 Followers</a></div></div></div>', {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
        ? { score: 956 }
        : { premium: true, latest: { value: 9.07, lastUpdate: null }, updating: true, spinning: false }));
    },
  });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  const widget = window.document.querySelector('.sorsa-bot-widget');
  assert.match(widget.textContent, /Bots 9%/);
  assert.equal(widget.previousElementSibling.querySelector('a').getAttribute('href'), '/mika8002/followers');
  assert.equal(widget.classList.contains('sorsa-bot-updating'), false);
  assert.equal(widget.querySelector('button').disabled, true);
  assert.match(window.document.getElementById('sorsa-score-styles').textContent, /sorsa-bot-updating button svg \{[^}]*animation: sorsa-bot-spin/);
  assert.equal(messages.some((message) => message.type === 'SORSA_REFRESH_BOTS'), false);
  widget.querySelector('button').click();
  await wait(0);
  assert.equal(messages.some((message) => message.type === 'SORSA_REFRESH_BOTS'), false);
});

test('shows an uncolored Bots placeholder before the first bot check', async (t) => {
  const { dom, window } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div><div><a href="/mika8002/followers">4,568 Followers</a></div></div></div>', {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
        ? { score: 956 }
        : { premium: true, latest: null, updating: false }));
    },
  });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  const widget = window.document.querySelector('.sorsa-bot-widget');
  const value = widget.querySelector('.sorsa-bot-value');
  assert.equal(value.textContent, 'Bots —');
  assert.equal(value.querySelector('strong'), null);
  assert.equal(value.dataset.level, '');
  assert.equal(widget.querySelector('button').disabled, false);
});

test('colors the displayed bot percentage at 15% and 25% while the refresh icon stays gray', async (t) => {
  for (const [raw, shown, level, color] of [[14.4, 14, 'green', 'rgb(21, 135, 81)'], [14.5, 15, 'yellow', 'rgb(150, 112, 0)'], [24.4, 24, 'yellow', 'rgb(150, 112, 0)'], [24.5, 25, 'red', 'rgb(195, 79, 84)']]) {
    const { dom, window } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div><div><a href="/mika8002/followers">4,568 Followers</a></div></div></div>', {
      url: 'https://x.com/mika8002',
      onScoreRequest(message, callback) {
        queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
          ? { score: 956 }
          : { premium: true, latest: { value: raw } }));
      },
    });
    t.after(() => dom.window.close());
    await window.SorsaScoreContent.scanNow();
    await wait(0);
    const widget = window.document.querySelector('.sorsa-bot-widget');
    const value = widget.querySelector('.sorsa-bot-value');
    assert.equal(value.textContent, `Bots ${shown}%`);
    assert.equal(value.firstChild.textContent, 'Bots ');
    assert.equal(value.querySelector('strong')?.textContent, `${shown}%`);
    assert.equal(value.dataset.level, level);
    assert.equal(window.getComputedStyle(value).color, color);
    assert.equal(window.getComputedStyle(value.querySelector('strong')).fontWeight, '700');
    assert.equal(widget.querySelector('button').dataset.level, undefined);
  }
});

test('adds bots when the follower row appears after the profile name', async (t) => {
  const { dom, window } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div></div>', {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      queueMicrotask(() => callback(message.type === 'SORSA_GET_SCORE'
        ? { score: 956 }
        : { premium: true, latest: { value: 9.07, lastUpdate: null } }));
    },
  });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  await wait(0);
  assert.equal(window.document.querySelector('.sorsa-bot-widget'), null);
  window.document.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML('beforeend', '<div class="counts"><div><a href="/mika8002/verified_followers">4,568 Followers</a></div></div>');
  await afterNextFrame(window);
  await wait(0);
  assert.equal(window.document.querySelector('.counts .sorsa-bot-widget')?.textContent, 'Bots 9%');
});

test('stops polling when a reloaded extension invalidates the old X content script', async (t) => {
  let botRequests = 0;
  const { dom, window } = await createPage('<div data-testid="primaryColumn"><div data-testid="UserName"><span>@mika8002</span></div><div class="counts"><div><a href="/mika8002/verified_followers">4,568 Followers</a></div></div></div>', {
    url: 'https://x.com/mika8002',
    onScoreRequest(message, callback) {
      if (message.type === 'SORSA_GET_SCORE') return queueMicrotask(() => callback({ score: 956 }));
      botRequests += 1;
      if (botRequests === 1) return queueMicrotask(() => callback({ premium: true, latest: { value: 9.07 }, updating: true }));
      throw new Error('Extension context invalidated.');
    },
  });
  t.after(() => dom.window.close());
  const originalSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay >= 10000 ? 0 : delay, ...args);
  await window.SorsaScoreContent.scanNow();
  await wait(30);
  assert.equal(botRequests, 2);
  assert.equal(window.document.querySelector('.sorsa-bot-widget'), null);
});

test('adds one badge beside the account handle and ignores a mention in post text', async (t) => {
  const { dom, window, requests, messages } = await createPage(
    '<article><div data-testid="User-Name"><a href="/mika8002" style="font-size: 15px">@mika8002</a></div><div data-testid="tweetText"><a href="/SorsaApp">@SorsaApp</a></div></article>',
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();

  const badge = window.document.querySelector('.sorsa-score-badge');
  assert.equal(window.document.querySelectorAll('.sorsa-score-badge').length, 1);
  assert.equal(badge.textContent, '870');
  assert.equal(badge.tagName, 'A');
  assert.equal(badge.href, 'https://app.sorsa.io/profile/mika8002');
  assert.equal(badge.target, '_blank');
  assert.equal(badge.rel, 'noopener noreferrer');
  assert.equal(badge.style.getPropertyValue('--sorsa-score-font-size'), '15px');
  assert.equal(badge.classList.contains('sorsa-score-yellow'), true);
  assert.ok(window.document.querySelector('.sorsa-score-mark svg'));
  const originalLogo = new JSDOM(await readFile(path.join(__dirname, '../images/sorsa-logo.svg'), 'utf8'), { contentType: 'image/svg+xml' });
  const markSvg = badge.querySelector('.sorsa-score-mark svg');
  const originalPaths = [...originalLogo.window.document.querySelectorAll('path')].map((node) => node.getAttribute('d'));
  assert.equal(markSvg.getAttribute('viewBox'), '0 0 60 34');
  assert.deepEqual([...markSvg.querySelectorAll('path')].map((node) => node.getAttribute('d')), [originalPaths[0], originalPaths[1], originalPaths[2].split('M85.965')[0]]);
  assert.equal(window.document.querySelector('.sorsa-score-mark').textContent, '');
  const styles = window.document.getElementById('sorsa-score-styles').textContent;
  assert.doesNotMatch(styles, /\.sorsa-score-mark \{[^}]*background:/);
  assert.match(styles, /\.sorsa-score-mark path\[fill="#fff"\] \{ fill: CanvasText !important; \}/);
  assert.match(styles, /border:\s*0\s*!important/);
  assert.match(styles, /font:\s*inherit\s*!important/);
  assert.match(styles, /font-size:\s*var\(--sorsa-score-font-size, 14px\)\s*!important/);
  assert.match(styles, /font-weight:\s*600\s*!important/);
  assert.match(styles, /line-height:\s*inherit\s*!important/);
  assert.match(styles, /vertical-align:\s*text-bottom\s*!important/);
  assert.match(styles, /\.sorsa-score-badge \{[^}]*align-items:\s*baseline\s*!important/);
  assert.match(styles, /\.sorsa-score-mark \{[^}]*width:\s*1\.94cap[^}]*height:\s*1\.1cap[^}]*translateY\(\.05em\)/);
  assert.match(styles, /pointer-events:\s*auto\s*!important/);
  assert.deepEqual(requests, ['mika8002']);
  assert.equal(messages.some((message) => message.type === 'SORSA_GET_BOTS'), false);
});

test('prefers the @handle anchor when the display name is identical to the handle', async (t) => {
  const { dom, window, requests } = await createPage(
    '<div data-testid="User-Name"><a class="display" href="/dondonkuy">dondonkuy</a><a class="handle" href="/dondonkuy">@dondonkuy</a></div>',
    { scores: { dondonkuy: 150 } },
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();

  assert.equal(window.document.querySelectorAll('.sorsa-score-badge').length, 1);
  assert.equal(window.document.querySelector('.handle').nextElementSibling.classList.contains('sorsa-score-badge'), true);
  assert.deepEqual(requests, ['dondonkuy']);
});

test('places a post score after the nested handle and before its date without wrapping', async (t) => {
  const { dom, window } = await createPage(`
    <article>
      <div data-testid="User-Name">
        <div class="post-author-row">
          <a href="/mika8002"><span>Marik</span></a>
          <div class="handle-wrapper"><a href="/mika8002">@mika8002</a></div>
          <span class="separator">·</span>
          <a class="date" href="/mika8002/status/123"><time>Jun 30</time></a>
        </div>
      </div>
    </article>
  `);
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();

  const row = window.document.querySelector('.post-author-row');
  const children = [...row.children];
  assert.equal(row.classList.contains('sorsa-score-tweet-row'), true);
  assert.equal(children[1].className, 'handle-wrapper');
  assert.equal(children[2].classList.contains('sorsa-score-badge'), true);
  assert.equal(children[3].className, 'separator');
  assert.equal(children[4].className, 'date');
});

test('adds a score to a hover card created after the page has loaded', async (t) => {
  const { dom, window, messages } = await createPage(
    '<main id="timeline"></main>',
    { scores: { cherry_web3: 681 } },
  );
  t.after(() => dom.window.close());
  await afterNextFrame(window);

  window.document.body.insertAdjacentHTML('beforeend', `
    <div data-testid="HoverCard">
      <a href="/Cherry_Web3"><span>Cherry Web3</span></a>
      <div class="hover-handle"><a href="/Cherry_Web3">@Cherry_Web3</a><span>Follows you</span></div>
    </div>
  `);
  await afterNextFrame(window);
  await window.SorsaScoreContent.scanNow();

  const badge = window.document.querySelector('[data-testid="HoverCard"] .sorsa-score-badge');
  assert.equal(window.document.querySelectorAll('[data-testid="HoverCard"] .sorsa-score-badge').length, 1);
  assert.equal(badge.textContent, '681');
  assert.equal(badge.previousElementSibling.textContent, '@Cherry_Web3');
  assert.equal(messages[0].handle, 'cherry_web3');
  assert.equal(messages[0].profileHandle, 'Cherry_Web3');
});

test('keeps a UserCell score between the handle and following text on the same row', async (t) => {
  const { dom, window } = await createPage(
    '<div data-testid="UserCell"><div><div>Cherry</div><div class="handle-row"><a href="/Cherry_Web3" style="font-size: 14px">@Cherry_Web3</a><span class="relation">Following</span></div><div class="bio">Profile text</div></div></div>',
    { scores: { cherry_web3: 681 } },
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();

  const row = window.document.querySelector('.handle-row');
  const children = [...row.children];
  assert.equal(row.classList.contains('sorsa-score-inline-row'), true);
  assert.equal(children[0].textContent, '@Cherry_Web3');
  assert.equal(children[1].classList.contains('sorsa-score-badge'), true);
  assert.equal(children[1].textContent, '681');
  assert.equal(children[2].textContent, 'Following');
  assert.equal(children[1].style.getPropertyValue('--sorsa-score-font-size'), '14px');
});

test('scores only the main UserCell handle, not profile mentions in its bio', async (t) => {
  const { dom, window, requests } = await createPage(`
    <div data-testid="UserCell">
      <a href="/owner"></a>
      <div><a href="/owner">Owner</a><a class="main-handle" href="/owner">@owner</a></div>
      <div class="bio">Working with <a href="/friend">@friend</a> and <a href="/owner">@owner</a></div>
    </div>
  `, { scores: { owner: 500, friend: 750 } });
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();
  const cell = window.document.querySelector('[data-testid="UserCell"]');
  assert.equal(cell.querySelector('.main-handle + .sorsa-score-badge')?.textContent, '500');
  assert.equal(cell.querySelectorAll('.sorsa-score-badge').length, 1);
  assert.deepEqual(requests, ['owner']);

  cell.querySelector('.bio a').insertAdjacentHTML('afterend', '<a class="sorsa-score-badge" data-sorsa-score-for="friend">750</a>');
  await window.SorsaScoreContent.scanNow();
  assert.equal(cell.querySelector('.bio .sorsa-score-badge'), null);
  assert.equal(cell.querySelectorAll('.sorsa-score-badge').length, 1);
});

test('updates newly inserted and recycled account anchors from an already resolved score', async (t) => {
  const { dom, window, requests } = await createPage(
    '<div id="timeline"><div data-testid="UserCell"><a href="/mika8002">@mika8002</a></div></div>',
    { scores: { mika8002: 870, otheruser: 1000 } },
  );
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();

  const timeline = window.document.getElementById('timeline');
  const recycledAnchor = timeline.querySelector('a');
  recycledAnchor.href = '/otheruser';
  recycledAnchor.textContent = '@otheruser';
  await afterNextFrame(window);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '1000');

  timeline.innerHTML = '<div data-testid="UserCell"><a href="/mika8002">@mika8002</a></div>';
  await afterNextFrame(window);

  assert.equal(window.document.querySelectorAll('.sorsa-score-badge').length, 1);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '870');
  assert.deepEqual(requests, ['mika8002', 'otheruser']);
});

test('keeps one accessible badge per identity anchor even when the same handle repeats', async (t) => {
  const { dom, window, requests } = await createPage(
    '<div data-testid="User-Name"><a href="/mika8002">@mika8002</a></div><div data-testid="UserName"><a href="/mika8002">@mika8002</a></div>',
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();
  await window.SorsaScoreContent.scanNow();

  const badges = window.document.querySelectorAll('.sorsa-score-badge');
  assert.equal(badges.length, 2);
  assert.equal(badges[0].getAttribute('aria-label'), 'Sorsa Score 870');
  assert.deepEqual(requests, ['mika8002']);
});

test('becomes quiescent after rendering an unchanged badge', async (t) => {
  const { dom, window } = await createPage(
    '<div data-testid="User-Name"><a href="/mika8002">@mika8002</a></div>',
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();
  await afterNextFrame(window);
  const stableScanCount = window.SorsaScoreContent.getScanCount();
  await wait(80);

  assert.equal(window.SorsaScoreContent.getScanCount(), stableScanCount);
});

test('does not render a late score beside an anchor recycled to another handle', async (t) => {
  const pending = new Map();
  const { dom, window } = await createPage(
    '<div data-testid="UserCell"><a href="/mika8002">@mika8002</a></div>',
    { onScoreRequest(message, callback) { pending.set(message.handle, callback); } },
  );
  t.after(() => dom.window.close());

  const firstScan = window.SorsaScoreContent.scanNow();
  const anchor = window.document.querySelector('a');
  anchor.setAttribute('href', '/otheruser');
  anchor.firstChild.nodeValue = '@otheruser';
  await afterNextFrame(window);

  pending.get('otheruser')({ score: 1000, source: 'public', cachedAt: 1 });
  await afterNextFrame(window);
  pending.get('mika8002')({ score: 870, source: 'public', cachedAt: 1 });
  await firstScan;
  await afterNextFrame(window);

  const badge = window.document.querySelector('.sorsa-score-badge');
  assert.equal(badge.dataset.sorsaScoreFor, 'otheruser');
  assert.equal(badge.textContent, '1000');
});

test('observes href and text-node mutations on an existing identity anchor', async (t) => {
  const { dom, window, requests } = await createPage(
    '<div data-testid="UserCell"><a href="/missinguser">@missinguser</a></div>',
    { scores: { otheruser: 1000 } },
  );
  t.after(() => dom.window.close());
  await window.SorsaScoreContent.scanNow();

  const anchor = window.document.querySelector('a');
  anchor.setAttribute('href', '/otheruser');
  anchor.firstChild.nodeValue = '@otheruser';
  await afterNextFrame(window);

  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '1000');
  assert.deepEqual(requests, ['missinguser', 'otheruser']);
});

test('expires the in-tab score cache at 24 hours and invalidates it after a storage clear', async (t) => {
  let currentTime = 1_000;
  const { dom, window, requests, emitStorageChanges } = await createPage(
    '<div data-testid="UserName"><a href="/mika8002">@mika8002</a></div>',
    { now: () => currentTime },
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();
  currentTime += 24 * 60 * 60 * 1000;
  await window.SorsaScoreContent.scanNow();
  assert.deepEqual(requests, ['mika8002', 'mika8002']);

  emitStorageChanges({ 'sorsa-score:mika8002': { oldValue: { score: 870 }, newValue: undefined } });
  await afterNextFrame(window);
  assert.deepEqual(requests, ['mika8002', 'mika8002', 'mika8002']);
});

test('ignores a normal cache write that arrives before its score callback', async (t) => {
  let emitStorageChanges;
  const { dom, window, requests, emitStorageChanges: emit } = await createPage(
    '<div data-testid="UserName"><a href="/missinguser">@missinguser</a></div><div data-testid="UserName"><a href="/mika8002">@mika8002</a></div>',
    {
      onScoreRequest(message, callback) {
        if (message.handle === 'missinguser') {
          callback({ score: null });
          return;
        }
        emitStorageChanges({
          'sorsa-score:mika8002': { oldValue: undefined, newValue: { score: 870 } },
        });
        callback({ score: 870, source: 'public' });
      },
    },
  );
  emitStorageChanges = emit;
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();
  await afterNextFrame(window);

  assert.deepEqual(requests, ['missinguser', 'mika8002']);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '870');
});

test('unrelated mutations do not cause full-document identity scans', async (t) => {
  const { dom, window } = await createPage(
    '<div data-testid="UserCell"><a href="/mika8002">@mika8002</a></div><div id="noise"></div>',
  );
  t.after(() => dom.window.close());
  await afterNextFrame(window);
  const initialFullScans = window.SorsaScoreContent.getFullScanCount();
  const noise = window.document.getElementById('noise');

  for (let index = 0; index < 100; index += 1) {
    const counter = window.document.createElement('span');
    counter.textContent = String(index);
    noise.replaceChildren(counter);
    counter.firstChild.nodeValue = `counter-${index}`;
  }
  await afterNextFrame(window);

  assert.equal(window.SorsaScoreContent.getFullScanCount(), initialFullScans);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '870');
});

test('incrementally processes an added identity region without a full scan', async (t) => {
  const { dom, window, requests } = await createPage('<main id="timeline"></main>');
  t.after(() => dom.window.close());
  await afterNextFrame(window);
  const initialFullScans = window.SorsaScoreContent.getFullScanCount();

  window.document.getElementById('timeline').insertAdjacentHTML(
    'beforeend',
    '<div data-testid="UserCell"><a href="/mika8002">@mika8002</a></div>',
  );
  await afterNextFrame(window);

  assert.equal(window.SorsaScoreContent.getFullScanCount(), initialFullScans);
  assert.deepEqual(requests, ['mika8002']);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '870');
});

test('renders a canonical profile header whose exact handle is plain text', async (t) => {
  const { dom, window, requests } = await createPage(
    '<div data-testid="UserName"><div>Display name</div><span>@Mika8002</span></div>',
    { url: 'https://x.com/Mika8002' },
  );
  t.after(() => dom.window.close());

  await window.SorsaScoreContent.scanNow();

  assert.deepEqual(requests, ['mika8002']);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '870');
  assert.equal(window.document.querySelector('.sorsa-score-badge').previousElementSibling.textContent, '@Mika8002');
});

test('rejects plain-text profile handles on non-canonical paths and revalidates before render', async (t) => {
  const callbacks = [];
  const canonical = await createPage(
    '<div data-testid="UserName"><span>@mika8002</span></div>',
    {
      url: 'https://twitter.com/mika8002',
      onScoreRequest(message, callback) { callbacks.push(callback); },
    },
  );
  t.after(() => canonical.dom.window.close());
  const pendingScan = canonical.window.SorsaScoreContent.scanNow();
  canonical.window.document.querySelector('[data-testid="UserName"] span').textContent = '@otheruser';
  callbacks[0]({ score: 870, source: 'public' });
  await pendingScan;
  assert.equal(canonical.window.document.querySelector('.sorsa-score-badge'), null);

  const statusPath = await createPage(
    '<div data-testid="UserName"><span>@mika8002</span></div>',
    { url: 'https://x.com/mika8002/status/123' },
  );
  t.after(() => statusPath.dom.window.close());
  await statusPath.window.SorsaScoreContent.scanNow();
  assert.deepEqual(statusPath.requests, []);
  assert.equal(statusPath.window.document.querySelector('.sorsa-score-badge'), null);

  const bareHandle = await createPage(
    '<div data-testid="UserName"><span>mika8002</span></div>',
    { url: 'https://x.com/mika8002' },
  );
  t.after(() => bareHandle.dom.window.close());
  await bareHandle.window.SorsaScoreContent.scanNow();
  assert.deepEqual(bareHandle.requests, []);
});

test('generation sentinel invalidates open-tab state even when no score key is removed', async (t) => {
  const pending = [];
  const { dom, window, requests, emitStorageChanges } = await createPage(
    '<div data-testid="UserName"><a href="/mika8002">@mika8002</a></div>',
    { onScoreRequest(message, callback) { pending.push(callback); } },
  );
  t.after(() => dom.window.close());
  window.SorsaScoreContent.scanNow();
  await afterNextFrame(window);

  emitStorageChanges({ 'sorsa-cache-generation': { oldValue: 0, newValue: 1 } });
  await afterNextFrame(window);
  assert.deepEqual(requests, ['mika8002', 'mika8002']);

  pending[0]({ score: 870, source: 'public' });
  pending[1]({ score: 5000, source: 'public' });
  await afterNextFrame(window);
  assert.equal(window.document.querySelector('.sorsa-score-badge').textContent, '5000');
});
