const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  CACHE_TTL_MS,
  createScoreLoader,
  extractScore,
  normalizeHandle,
  extractSorsaData,
  scoreTone,
} = require('../core.js');

test('extractSorsaData reads the signed-in plan and matching profile bot result', () => {
  const chunks = [
    ['@account/getMe', { is_premium: true }],
    ['@profiles/searchAccounts', { id: 'c71012f7-f82e-4ec0-adea-65a283d5f606', screen_name: 'pmarca', bot_followers: { status: 'finish', value: 17.8, last_update: 1790674814 } }],
  ].map(([key, data], index) => `<script>self.__next_f.push([1,${JSON.stringify(`${index}:` + JSON.stringify({ queryKey: [key, 'pmarca'], state: { data } }))}])</script>`).join('');
  assert.deepEqual(extractSorsaData(chunks, 'pmarca'), {
    premium: true,
    account: { id: 'c71012f7-f82e-4ec0-adea-65a283d5f606', screen_name: 'pmarca', bot_followers: { status: 'finish', value: 17.8, last_update: 1790674814 } },
  });
  assert.equal(extractSorsaData(chunks, 'someoneelse').account, null);
});

function createMemoryStorage() {
  const records = new Map();
  return {
    async get(key) {
      return records.get(key);
    },
    async set(key, value) {
      records.set(key, value);
    },
    async remove(key) {
      records.delete(key);
    },
    records,
  };
}

function createOkResponse(html) {
  return {
    ok: true,
    async text() {
      return html;
    },
  };
}

test('normalizeHandle accepts handles and X profile URLs', () => {
  assert.equal(normalizeHandle('@Mika8002'), 'mika8002');
  assert.equal(normalizeHandle('@Cherry_Web3'), 'cherry_web3');
  assert.equal(normalizeHandle('https://x.com/Mika8002/status/1'), 'mika8002');
  assert.equal(normalizeHandle('https://example.com/Mika8002'), null);
  assert.equal(normalizeHandle('/Mika8002'), null);
});

test('extractScore accepts a public Sorsa profile score above 100', () => {
  assert.equal(extractScore('<div>Score</div><strong>870</strong><div>+3</div>'), 870);
});

test('extractScore reads the representative public Sorsa profile fixture', async () => {
  const profileHtml = await readFile(path.join(__dirname, '../fixtures/sorsa-profile.html'), 'utf8');
  assert.equal(extractScore(profileHtml), 870);
});

test('extractScore ignores a serialized zero placeholder before the real profile score', () => {
  const html = `
    <script>self.__data = {"score":0,"profile":{"score":870}}</script>
    <main><div>Profile is loading</div></main>
  `;
  assert.equal(extractScore(html), 870);
  assert.equal(extractScore('<script>{"score":0}</script><main>Loading...</main>'), null);
  assert.equal(extractScore('<main><span>Score</span><strong>0</strong></main>'), 0);
});

test('extractScore replaces Cherry_Web3 placeholder zero with the score nearest that handle', () => {
  const html = `
    <script>
      self.__data = {
        "unrelated": {"screen_name":"another_user","score":2500},
        "profile": {"screen_name":"Cherry_Web3","score":681}
      };
    </script>
    <main><h1>@Cherry_Web3</h1><span>Score</span><strong>0</strong></main>
  `;
  assert.equal(extractScore(html, 'cherry_web3'), 681);
  assert.equal(
    extractScore('<main><h1>@Cherry_Web3</h1><span>Score</span><strong>0</strong></main>', 'cherry_web3'),
    null,
  );
});

test('extractScore rejects unlabelled numeric-prefix junk', () => {
  assert.equal(extractScore('404 Not Found'), null);
  assert.equal(extractScore('9999garbage'), null);
});

test('extractScore accepts the supported upper range without truncating out-of-range values', () => {
  assert.equal(extractScore('<div>Score</div><strong>5000</strong>'), 5000);
  assert.equal(extractScore('<div>Score</div><strong>9999</strong>'), 9999);
  assert.equal(extractScore('<div>Score</div><strong>10000</strong>'), null);
});

test('scoreTone uses all requested Sorsa score color boundaries', () => {
  assert.equal(scoreTone(0), 'burgundy');
  assert.equal(scoreTone(349), 'burgundy');
  assert.equal(scoreTone(350), 'orange');
  assert.equal(scoreTone(499), 'orange');
  assert.equal(scoreTone(500), 'yellow');
  assert.equal(scoreTone(999), 'yellow');
  assert.equal(scoreTone(1000), 'green');
  assert.equal(scoreTone(1499), 'green');
  assert.equal(scoreTone(1500), 'dark-green');
  assert.equal(scoreTone(1999), 'dark-green');
  assert.equal(scoreTone(2000), 'blue');
  assert.equal(scoreTone(2499), 'blue');
  assert.equal(scoreTone(2500), 'lilac');
  assert.equal(scoreTone(9999), 'lilac');
});

test('loader fetches the public profile once for duplicate handles', async () => {
  let fetchCalls = 0;
  const loader = createScoreLoader({
    storage: createMemoryStorage(),
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      assert.equal(url, 'https://app.sorsa.io/profile/mika8002');
      assert.equal(options.credentials, 'include');
      assert.equal(options.signal.aborted, false);
      assert.equal(typeof options.signal.addEventListener, 'function');
      return createOkResponse('<div>Score</div><strong>870</strong>');
    },
  });

  const [first, second] = await Promise.all([
    loader.getScore('@Mika8002'),
    loader.getScore('mika8002'),
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(first.score, 870);
  assert.deepEqual(second, first);
  assert.equal(first.source, 'public');
});

test('loader preserves the observed handle case in the Sorsa profile URL', async () => {
  let requestedUrl;
  const loader = createScoreLoader({
    storage: createMemoryStorage(),
    fetchImpl: async (url) => {
      requestedUrl = url;
      return createOkResponse('<div>Score</div><strong>681</strong>');
    },
  });

  const result = await loader.getScore('cherry_web3', 'Cherry_Web3');

  assert.equal(requestedUrl, 'https://app.sorsa.io/profile/Cherry_Web3');
  assert.equal(result.handle, 'cherry_web3');
  assert.equal(result.score, 681);
});

test('loader returns a cached score until its exact 24-hour TTL expires', async () => {
  const storage = createMemoryStorage();
  let currentTime = 1_000;
  let fetchCalls = 0;
  const loader = createScoreLoader({
    storage,
    now: () => currentTime,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createOkResponse('<div>Score</div><strong>870</strong>');
    },
  });

  assert.equal((await loader.getScore('mika8002')).score, 870);
  currentTime += CACHE_TTL_MS - 1;
  assert.equal((await loader.getScore('mika8002')).score, 870);
  assert.equal(fetchCalls, 1);

  currentTime += 1;
  assert.equal((await loader.getScore('mika8002')).score, 870);
  assert.equal(fetchCalls, 2);
});

test('loader discards a cached zero from the previous parser and refetches it once', async () => {
  const storage = createMemoryStorage();
  storage.records.set('sorsa-score:mika8002', {
    handle: 'mika8002',
    score: 0,
    cachedAt: Date.now(),
    source: 'public',
    parserVersion: 2,
  });
  let fetchCalls = 0;
  const loader = createScoreLoader({
    storage,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createOkResponse('<div>Score</div><strong>870</strong>');
    },
  });

  assert.equal((await loader.getScore('mika8002')).score, 870);
  assert.equal(fetchCalls, 1);
  assert.equal(storage.records.get('sorsa-score:mika8002').parserVersion, 4);
});

test('loader returns no score for a failed public profile request', async () => {
  const loader = createScoreLoader({
    storage: createMemoryStorage(),
    fetchImpl: async () => ({ ok: false, status: 404, async text() { return ''; } }),
  });

  assert.equal(await loader.getScore('missinguser'), null);
});

test('loader reports a Sorsa sign-in redirect without caching a score', async () => {
  const storage = createMemoryStorage();
  const loader = createScoreLoader({
    storage,
    fetchImpl: async () => ({
      ok: true,
      url: 'https://app.sorsa.io/authorization?redirectTo=%2Fprofile%2Fmika8002',
      async text() { return '<div>Score 870</div>'; },
    }),
  });
  assert.deepEqual(await loader.getScore('mika8002'), { authRequired: true });
  assert.equal(storage.records.size, 0);
});

test('loader does not cache an HTTP-OK numeric-prefix error page', async () => {
  const storage = createMemoryStorage();
  let fetchCalls = 0;
  const loader = createScoreLoader({
    storage,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createOkResponse('404 Not Found');
    },
  });

  assert.equal(await loader.getScore('missinguser'), null);
  assert.equal(await loader.getScore('missinguser'), null);
  assert.equal(fetchCalls, 2);
  assert.equal(storage.records.size, 0);
});

test('loader limits public Sorsa profile requests to four concurrent fetches', async () => {
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let releaseAll;
  const fetchGate = new Promise((resolve) => {
    releaseAll = resolve;
  });
  const loader = createScoreLoader({
    storage: createMemoryStorage(),
    fetchImpl: async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await fetchGate;
      activeFetches -= 1;
      return createOkResponse('<div>Score</div><strong>870</strong>');
    },
  });

  const scores = ['userone', 'usertwo', 'userthree', 'userfour', 'userfive']
    .map((handle) => loader.getScore(handle));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActiveFetches, 4);

  releaseAll();
  await Promise.all(scores);
});

test('loader invalidation aborts active work, skips queued old work, and frees a scheduler slot', async () => {
  let fetchCalls = 0;
  let aborts = 0;
  let notifyFirstFetch;
  const firstFetchStarted = new Promise((resolve) => { notifyFirstFetch = resolve; });
  const loader = createScoreLoader({
    storage: createMemoryStorage(),
    maxConcurrent: 1,
    fetchImpl: (_url, { signal }) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        notifyFirstFetch();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborts += 1;
            reject(new Error('old request aborted'));
          }, { once: true });
        });
      }
      return Promise.resolve(createOkResponse('<div>Score</div><strong>5000</strong>'));
    },
  });

  const oldActive = loader.getScore('activeuser');
  await firstFetchStarted;
  const oldQueued = loader.getScore('queueduser');
  const oldSettled = loader.invalidateGeneration(1);
  const fresh = loader.getScore('freshuser');

  assert.equal((await oldActive), null);
  assert.equal((await oldQueued), null);
  assert.equal((await fresh).score, 5000);
  await oldSettled;
  assert.equal(aborts, 1);
  assert.equal(fetchCalls, 2, 'the queued old request must never reach fetch');
  assert.equal(loader.getActiveCount(), 0);
  assert.equal(loader.getPendingCount(), 0);
});

test('loader invalidation suppresses an old write and allows a new same-handle request', async () => {
  const storage = createMemoryStorage();
  const releases = [];
  const loader = createScoreLoader({
    storage,
    fetchImpl: () => new Promise((resolve) => releases.push(resolve)),
  });

  const oldRequest = loader.getScore('mika8002');
  await new Promise((resolve) => setImmediate(resolve));
  loader.invalidateGeneration(1);
  const newRequest = loader.getScore('mika8002');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(releases.length, 2, 'the post-clear request must not deduplicate onto the old load');
  releases[0](createOkResponse('<div>Score</div><strong>870</strong>'));
  assert.equal(await oldRequest, null);
  assert.equal(storage.records.has('sorsa-score:mika8002'), false);

  releases[1](createOkResponse('<div>Score</div><strong>5000</strong>'));
  assert.equal((await newRequest).score, 5000);
  assert.equal(storage.records.get('sorsa-score:mika8002').score, 5000);
});

test('loader invalidation settlement joins a score write already pending in storage', async () => {
  const records = new Map();
  let releaseSet;
  const setStarted = new Promise((resolve) => {
    releaseSet = () => resolve();
  });
  let notifySetStarted;
  const pendingSet = new Promise((resolve) => { notifySetStarted = resolve; });
  const storage = {
    async get(key) { return records.get(key); },
    async set(key, value) {
      notifySetStarted();
      await setStarted;
      records.set(key, value);
    },
    async remove(key) { records.delete(key); },
  };
  const loader = createScoreLoader({
    storage,
    fetchImpl: async () => createOkResponse('<div>Score</div><strong>870</strong>'),
  });

  const oldRequest = loader.getScore('mika8002');
  await pendingSet;
  let settled = false;
  const settlement = loader.invalidateGeneration(1).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'invalidation must join the pending storage mutation');

  releaseSet();
  await settlement;
  assert.equal(await oldRequest, null);
  assert.equal(records.get('sorsa-score:mika8002').score, 870);
});

test('loader invalidation settlement also joins an expired-record removal', async () => {
  const records = new Map([
    ['sorsa-score:mika8002', { handle: 'mika8002', score: 870, cachedAt: 0, source: 'public' }],
  ]);
  let releaseRemove;
  let notifyRemoveStarted;
  const removeStarted = new Promise((resolve) => { notifyRemoveStarted = resolve; });
  const removeGate = new Promise((resolve) => { releaseRemove = resolve; });
  let fetchCalls = 0;
  const storage = {
    async get(key) { return records.get(key); },
    async set(key, value) { records.set(key, value); },
    async remove(key) {
      notifyRemoveStarted();
      await removeGate;
      records.delete(key);
    },
  };
  const loader = createScoreLoader({
    storage,
    now: () => CACHE_TTL_MS + 1,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createOkResponse('<div>Score</div><strong>5000</strong>');
    },
  });

  const oldRequest = loader.getScore('mika8002');
  await removeStarted;
  let settled = false;
  const settlement = loader.invalidateGeneration(1).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseRemove();
  await settlement;
  assert.equal(await oldRequest, null);
  assert.equal(fetchCalls, 0);
  assert.equal(records.has('sorsa-score:mika8002'), false);
});
