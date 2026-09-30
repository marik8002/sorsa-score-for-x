const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

test('popup uses English Sorsa-branded copy and logo', async () => {
  const html = await readFile(path.join(root, 'popup.html'), 'utf8');
  const source = await readFile(path.join(root, 'popup.js'), 'utf8');
  const styles = await readFile(path.join(root, 'popup.css'), 'utf8');
  const dom = new JSDOM(html);

  assert.equal(dom.window.document.documentElement.lang, 'en');
  assert.equal(dom.window.document.querySelector('.brand-logo').getAttribute('src'), 'images/sorsa-logo.svg');
  assert.match(dom.window.document.body.textContent, /Sorsa score for X/i);
  assert.match(dom.window.document.body.textContent, /Sorsa profiles/i);
  assert.match(dom.window.document.body.textContent, /Sign in to Sorsa/i);
  assert.match(dom.window.document.body.textContent, /Refresh status/i);
  assert.match(dom.window.document.body.textContent, /Clear score cache/i);
  assert.doesNotMatch(`${dom.window.document.body.textContent}\n${source}`, /[А-Яа-яЁё]/);
  assert.match(styles, /#010003/i);
  assert.match(styles, /#10003b/i);
  assert.match(styles, /#198fff/i);
  assert.doesNotMatch(styles, /#caff4a|#0b2420|#f3f0e6/i);
});

test('popup refresh stays disabled until its status callback completes', async (t) => {
  const html = await readFile(path.join(root, 'popup.html'), 'utf8');
  const source = await readFile(path.join(root, 'popup.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const callbacks = [];
  dom.window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { callbacks.push({ message, callback }); },
    },
  };
  dom.window.eval(source);
  callbacks.shift().callback({ phase: 'ready', cacheEntries: 0 });

  const refresh = dom.window.document.getElementById('refresh-status');
  refresh.click();
  assert.equal(refresh.disabled, true);
  callbacks.shift().callback({ phase: 'ready', cacheEntries: 1 });
  assert.equal(refresh.disabled, false);
});

test('popup enables Show bots for Plus and disables it without Plus', async (t) => {
  const html = await readFile(path.join(root, 'popup.html'), 'utf8');
  const source = await readFile(path.join(root, 'popup.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const callbacks = [];
  dom.window.chrome = { runtime: { lastError: null, sendMessage(message, callback) { callbacks.push({ message, callback }); } } };
  dom.window.eval(source);
  callbacks.shift().callback({ phase: 'ready', premium: true, showBots: true });
  const checkbox = dom.window.document.getElementById('show-bots');
  assert.equal(checkbox.disabled, false);
  assert.equal(checkbox.checked, true);
  checkbox.click();
  assert.equal(callbacks.shift().message.enabled, false);
  dom.window.document.getElementById('refresh-status').click();
  callbacks.shift().callback({ phase: 'ready', premium: false, showBots: false });
  assert.equal(checkbox.disabled, true);
  assert.match(dom.window.document.getElementById('premium-state').textContent, /Plus is required/);
});

test('popup renders worker fetching and temporary-error statuses', async (t) => {
  const html = await readFile(path.join(root, 'popup.html'), 'utf8');
  const source = await readFile(path.join(root, 'popup.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const callbacks = [];
  dom.window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { callbacks.push(callback); },
    },
  };
  dom.window.eval(source);

  callbacks.shift()({ phase: 'fetching', cacheEntries: 2 });
  assert.equal(dom.window.document.getElementById('status-label').textContent, 'Loading scores');
  assert.equal(dom.window.document.getElementById('refresh-status').disabled, true);

  dom.window.document.getElementById('clear-cache').click();
  callbacks.shift()({ phase: 'error', message: 'Sorsa is temporarily unavailable.', cacheEntries: 2 });
  assert.equal(dom.window.document.getElementById('status-label').textContent, 'Temporarily unavailable');
  assert.equal(dom.window.document.getElementById('status-message').textContent, 'Sorsa is temporarily unavailable.');

  dom.window.document.getElementById('refresh-status').click();
  callbacks.shift()({ phase: 'auth', cacheEntries: 0 });
  assert.equal(dom.window.document.getElementById('status-label').textContent, 'Sign in required');
  assert.equal(dom.window.document.getElementById('sorsa-login').hidden, false);
});
