const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

async function createWorker({
  fetchImpl,
  local = new Map(),
  session = new Map(),
  beforeLocalSet,
  beforeLocalRemove,
  premiumHtml,
  siteResponse = { ok: true, status: 200 },
  siteTabs = [{ id: 1 }],
} = {}) {
  let listener;
  const siteMessages = [];
  const createdTabs = [];
  const removedTabs = [];
  const area = (records, { beforeSet, beforeRemove } = {}) => ({
    async get(key) {
      if (key === null) return Object.fromEntries(records);
      if (typeof key === 'string') return records.has(key) ? { [key]: records.get(key) } : {};
      return {};
    },
    async set(values) {
      if (beforeSet) await beforeSet(values);
      for (const [key, value] of Object.entries(values)) records.set(key, value);
    },
    async remove(keys) {
      if (beforeRemove) await beforeRemove(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key);
    },
  });
  const context = vm.createContext({
    console,
    URL,
    Date,
    Promise,
    Map,
    AbortController,
    setTimeout,
    fetch: (url, options) => {
      if (url === 'https://app.sorsa.io/' && options?.method !== 'HEAD') {
        return Promise.resolve({ ok: Boolean(premiumHtml), url, async text() { return premiumHtml || ''; } });
      }
      return (fetchImpl || (async () => ({ ok: false, async text() { return ''; } })))(url, options);
    },
    chrome: {
      tabs: {
        async query() { return siteTabs; },
        async sendMessage(_id, message) { siteMessages.push(message); return siteResponse; },
        async create(options) { createdTabs.push(options); return { id: 2 }; },
        async remove(id) { removedTabs.push(id); },
      },
      storage: {
        local: area(local, { beforeSet: beforeLocalSet, beforeRemove: beforeLocalRemove }),
        session: area(session),
      },
      runtime: { onMessage: { addListener(value) { listener = value; } } },
    },
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...names) => {
    for (const name of names) vm.runInContext(require('node:fs').readFileSync(path.join(root, name), 'utf8'), context);
  };
  vm.runInContext(await readFile(path.join(root, 'service-worker.js'), 'utf8'), context);

  const send = (message) => new Promise((resolve) => {
    const keepAlive = listener(message, {}, resolve);
    if (keepAlive !== true) queueMicrotask(() => resolve(undefined));
  });
  return { local, session, send, siteMessages, createdTabs, removedTabs };
}

test('Sorsa page bridge starts the bot task with the signed-in browser session', async () => {
  let listener;
  const calls = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { id: '9778d345-a1ea-4ad5-8f7c-9f5a845aff78' }; } };
    },
  });
  vm.runInContext(await readFile(path.join(root, 'site-bridge.js'), 'utf8'), context);
  const result = await new Promise((resolve) => listener({ type: 'SORSA_CHECK_BOT', accountId: 'c3657368-ae57-44fb-a075-e8f8f9b3b740' }, {}, resolve));
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.sorsa.io/v1/accounts/c3657368-ae57-44fb-a075-e8f8f9b3b740/check-bot');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(listener({ type: 'SORSA_CHECK_BOT', accountId: '../invalid' }, {}, () => {}), false);
  assert.equal(calls.length, 1);
});

test('worker gates bot refresh on Sorsa Plus and keeps the last finished value', async () => {
  const query = (key, data) => `<script>self.__next_f.push([1,${JSON.stringify('1:' + JSON.stringify({ queryKey: [key, 'pmarca'], state: { data } }))}])</script>`;
  const html = query('@account/getMe', { is_premium: true }) + query('@profiles/searchAccounts', {
    id: 'c71012f7-f82e-4ec0-adea-65a283d5f606', screen_name: 'pmarca',
    bot_followers: { status: 'finish', value: 17.8, last_update: 1790674814 },
  });
  const worker = await createWorker({
    premiumHtml: html,
    fetchImpl: async (url) => ({ ok: true, url, async text() { return html; } }),
  });
  assert.equal((await worker.send({ type: 'GET_STATUS' })).premium, true);
  assert.equal((await worker.send({ type: 'GET_STATUS' })).showBots, true);
  const bots = await worker.send({ type: 'SORSA_GET_BOTS', handle: 'pmarca' });
  assert.equal(bots.latest.value, 17.8);
  assert.equal(bots.latest.lastUpdate, 1790674814);
  assert.equal((await worker.send({ type: 'SORSA_REFRESH_BOTS', handle: 'pmarca' })).updating, true);
  assert.equal(worker.siteMessages.length, 1);
  assert.equal(worker.siteMessages[0].accountId, 'c71012f7-f82e-4ec0-adea-65a283d5f606');
  const withoutTab = await createWorker({
    siteTabs: [],
    fetchImpl: async (url) => ({ ok: true, url, async text() { return html; } }),
  });
  assert.equal((await withoutTab.send({ type: 'SORSA_REFRESH_BOTS', handle: 'pmarca' })).updating, true);
  assert.equal(withoutTab.createdTabs[0].active, false);
  assert.deepEqual(withoutTab.removedTabs, [2]);
  const queuedHtml = html.replace('status\\\":\\\"finish', 'status\\\":\\\"waiting');
  const queued = await createWorker({
    local: new Map([['sorsa-bot:pmarca', { value: 17.8, lastUpdate: 1790674814 }]]),
    fetchImpl: async (url) => ({ ok: true, url, async text() { return queuedHtml; } }),
  });
  const pending = await queued.send({ type: 'SORSA_GET_BOTS', handle: 'pmarca' });
  assert.equal(pending.updating, true);
  assert.equal(pending.spinning, false);
  assert.equal(pending.latest.value, 17.8);
  assert.equal(pending.latest.lastUpdate, 1790674814);
  const blocked = await queued.send({ type: 'SORSA_REFRESH_BOTS', handle: 'pmarca' });
  assert.equal(blocked.updating, true);
  assert.equal(blocked.spinning, false);
  assert.equal(queued.siteMessages.length, 0, 'do not queue a second Sorsa task while one is waiting');
  const processing = await createWorker({
    fetchImpl: async (url) => ({ ok: true, url, async text() { return queuedHtml.replace('waiting', 'process'); } }),
  });
  assert.equal((await processing.send({ type: 'SORSA_GET_BOTS', handle: 'pmarca' })).spinning, true);
  queued.local.delete('sorsa-bot:pmarca');
  assert.equal((await queued.send({ type: 'SORSA_GET_BOTS', handle: 'pmarca' })).latest.lastUpdate, 1790674814);
  await worker.send({ type: 'SET_SHOW_BOTS', enabled: false });
  assert.equal((await worker.send({ type: 'SORSA_GET_BOTS', handle: 'pmarca' })).enabled, false);

  const basic = await createWorker({
    fetchImpl: async (url) => ({ ok: true, url, async text() { return html.replace('is_premium\\\":true', 'is_premium\\\":false'); } }),
  });
  assert.equal((await basic.send({ type: 'SORSA_REFRESH_BOTS', handle: 'pmarca' })).premium, false);
});

test('worker clear is a generation barrier against an in-flight write and response', async () => {
  const releases = [];
  const worker = await createWorker({
    fetchImpl: () => new Promise((resolve) => releases.push(resolve)),
  });

  const oldScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));
  const clearing = worker.send({ type: 'CLEAR_CACHE' });
  releases[0]({ ok: true, async text() { return '<div>Score</div><strong>870</strong>'; } });
  const clearStatus = await clearing;
  assert.equal(clearStatus.cacheEntries, 0);
  assert.equal(worker.local.get('sorsa-score:mika8002'), undefined);
  assert.equal(worker.local.get('sorsa-cache-generation'), 1);

  const newScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2, 'a post-clear request must start independently');
  releases[1]({ ok: true, async text() { return '<div>Score</div><strong>5000</strong>'; } });
  assert.equal((await newScore).score, 5000);

  assert.equal((await oldScore).score, null);
  assert.equal(worker.local.get('sorsa-score:mika8002').score, 5000);
});

test('worker clear joins an old gated score write before final deletion and unblocks new loads', async () => {
  let releaseOldSet;
  let notifyOldSet;
  let releaseFinalRemoval;
  let notifyFinalRemoval;
  const oldSetStarted = new Promise((resolve) => { notifyOldSet = resolve; });
  const oldSetGate = new Promise((resolve) => { releaseOldSet = resolve; });
  const finalRemovalStarted = new Promise((resolve) => { notifyFinalRemoval = resolve; });
  const finalRemovalGate = new Promise((resolve) => { releaseFinalRemoval = resolve; });
  let gateFirstScoreSet = true;
  let fetchCalls = 0;
  const worker = await createWorker({
    fetchImpl: async () => {
      fetchCalls += 1;
      const score = fetchCalls === 1 ? 870 : 5000;
      return { ok: true, async text() { return `<div>Score</div><strong>${score}</strong>`; } };
    },
    async beforeLocalSet(values) {
      if (gateFirstScoreSet && Object.hasOwn(values, 'sorsa-score:mika8002')) {
        gateFirstScoreSet = false;
        notifyOldSet();
        await oldSetGate;
      }
    },
    async beforeLocalRemove(keys) {
      if ((Array.isArray(keys) ? keys : [keys]).includes('sorsa-score:mika8002')) {
        notifyFinalRemoval();
        await finalRemovalGate;
      }
    },
  });

  const oldScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await oldSetStarted;
  let clearCompleted = false;
  const clearing = worker.send({ type: 'CLEAR_CACHE' }).then((status) => {
    clearCompleted = true;
    return status;
  });
  const newScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clearCompleted, false);
  assert.equal(fetchCalls, 1, 'post-clear loads must wait for the clear barrier');
  releaseOldSet();
  assert.equal((await oldScore).score, null);
  await finalRemovalStarted;
  assert.equal(clearCompleted, false, 'the clear response must wait for its final cache deletion');
  assert.equal(fetchCalls, 1, 'new loads must remain blocked until final deletion completes');
  releaseFinalRemoval();
  assert.equal((await clearing).cacheEntries, 0);
  assert.equal((await newScore).score, 5000);
  assert.equal(worker.local.get('sorsa-score:mika8002').score, 5000);
});

test('worker clear joins an old gated expired-cache removal before allowing a fresh score', async () => {
  let releaseOldRemoval;
  let notifyOldRemoval;
  const oldRemovalStarted = new Promise((resolve) => { notifyOldRemoval = resolve; });
  const oldRemovalGate = new Promise((resolve) => { releaseOldRemoval = resolve; });
  let fetchCalls = 0;
  const local = new Map([
    ['sorsa-score:mika8002', { handle: 'mika8002', score: 870, cachedAt: 0, source: 'public' }],
  ]);
  const worker = await createWorker({
    local,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, async text() { return '<div>Score</div><strong>5000</strong>'; } };
    },
    async beforeLocalRemove(keys) {
      if ((Array.isArray(keys) ? keys : [keys]).includes('sorsa-score:mika8002')) {
        notifyOldRemoval();
        await oldRemovalGate;
      }
    },
  });

  const oldScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await oldRemovalStarted;
  const clearing = worker.send({ type: 'CLEAR_CACHE' });
  const newScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls, 0, 'new work must not start while an old removal is still pending');
  releaseOldRemoval();
  assert.equal((await oldScore).score, null);
  assert.equal((await clearing).cacheEntries, 0);
  assert.equal((await newScore).score, 5000);
  assert.equal(worker.local.get('sorsa-score:mika8002').score, 5000);
});

test('worker clear aborts a stalled old fetch, publishes generation, and frees a fresh same-handle load', async () => {
  let fetchCalls = 0;
  let aborts = 0;
  let notifyFirstFetch;
  const firstFetchStarted = new Promise((resolve) => { notifyFirstFetch = resolve; });
  const worker = await createWorker({
    fetchImpl: (_url, { signal } = {}) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        notifyFirstFetch();
        return new Promise((_resolve, reject) => {
          if (!signal) return;
          signal.addEventListener('abort', () => {
            aborts += 1;
            reject(new Error('old request aborted'));
          }, { once: true });
        });
      }
      assert.ok(signal, 'every fresh network request receives its own abort signal');
      return Promise.resolve({ ok: true, async text() { return '<div>Score</div><strong>5000</strong>'; } });
    },
  });

  const oldScore = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await firstFetchStarted;
  const complete = Promise.all([
    worker.send({ type: 'CLEAR_CACHE' }),
    worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' }),
  ]);
  const result = await Promise.race([
    complete,
    new Promise((resolve) => setImmediate(() => setImmediate(() => resolve(null)))),
  ]);

  assert.ok(result, 'clear must not wait indefinitely for an abortable old fetch');
  const [clearStatus, freshScore] = result;
  assert.equal(aborts, 1);
  assert.equal(clearStatus.cacheEntries, 0);
  assert.equal(worker.local.get('sorsa-cache-generation'), 1);
  assert.equal(freshScore.score, 5000);
  assert.equal(worker.local.get('sorsa-score:mika8002').score, 5000);
  assert.equal((await oldScore).score, null);
});

test('worker exposes fetching, ready and recent failure phases', async () => {
  let resolveFetch;
  const worker = await createWorker({
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });

  const score = worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await worker.send({ type: 'GET_STATUS' })).phase, 'fetching');
  resolveFetch({ ok: true, async text() { return '<div>Score</div><strong>870</strong>'; } });
  assert.equal((await score).score, 870);
  assert.equal((await worker.send({ type: 'GET_STATUS' })).phase, 'ready');

  const failedWorker = await createWorker();
  assert.equal((await failedWorker.send({ type: 'SORSA_GET_SCORE', handle: 'missinguser' })).score, null);
  const failedStatus = await failedWorker.send({ type: 'GET_STATUS' });
  assert.equal(failedStatus.phase, 'error');
  assert.match(failedStatus.message, /temporarily unavailable/i);
});

test('worker distinguishes an expired Sorsa session from a network error', async () => {
  let signedIn = false;
  const worker = await createWorker({ fetchImpl: async (url, options) => {
    assert.equal(options.credentials, 'include');
    if (url === 'https://app.sorsa.io/') assert.equal(options.method, 'HEAD');
    if (!signedIn) return {
      ok: true,
      url: `https://app.sorsa.io/authorization?redirectTo=${encodeURIComponent(new URL(url).pathname)}`,
      async text() { return '<div>Score 870</div>'; },
    };
    return {
      ok: true,
      url,
      async text() { return '<div>Score 870</div>'; },
    };
  } });
  assert.equal((await worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' })).score, null);
  const status = await worker.send({ type: 'GET_STATUS' });
  assert.equal(status.phase, 'auth');
  assert.match(status.message, /sign in/i);
  assert.equal(worker.local.has('sorsa-cache-generation'), false);

  signedIn = true;
  assert.equal((await worker.send({ type: 'GET_STATUS' })).phase, 'ready');
  assert.equal(worker.local.get('sorsa-cache-generation'), 1);
  assert.equal((await worker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' })).score, 870);
});

test('worker forwards the case-preserved handle to the public Sorsa profile request', async () => {
  let requestedUrl;
  const worker = await createWorker({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, async text() { return '<div>Score</div><strong>681</strong>'; } };
    },
  });

  const result = await worker.send({
    type: 'SORSA_GET_SCORE',
    handle: 'cherry_web3',
    profileHandle: 'Cherry_Web3',
  });

  assert.equal(requestedUrl, 'https://app.sorsa.io/profile/Cherry_Web3');
  assert.equal(result.score, 681);
});

test('fresh worker downgrades an orphaned persisted fetching status to ready', async () => {
  const local = new Map();
  const session = new Map();
  const firstWorker = await createWorker({
    local,
    session,
    fetchImpl: () => new Promise(() => {}),
  });
  firstWorker.send({ type: 'SORSA_GET_SCORE', handle: 'mika8002' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await firstWorker.send({ type: 'GET_STATUS' })).phase, 'fetching');

  const restartedWorker = await createWorker({ local, session });
  assert.equal((await restartedWorker.send({ type: 'GET_STATUS' })).phase, 'ready');
});
