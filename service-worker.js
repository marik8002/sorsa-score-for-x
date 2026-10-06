importScripts('core.js');

(function () {
  const core = globalThis.SorsaScoreCore;
  const STATUS_KEY = 'sorsaStatus';
  const AUTH_CHECK_KEY = 'sorsa-auth-checked-at';
  const AUTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;
  const CACHE_PREFIX = 'sorsa-score:';
  const GENERATION_KEY = 'sorsa-cache-generation';
  const SHOW_BOTS_KEY = 'sorsa-show-bots';
  const PREMIUM_KEY = 'sorsa-premium';
  const BOT_PREFIX = 'sorsa-bot:';
  const ERROR_TTL_MS = 60 * 1000;
  const activeRequests = new Set();
  let clearEpoch = 0;

  const localStorage = {
    async get(key) {
      const result = await chrome.storage.local.get(key);
      return result[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };

  const loader = core.createScoreLoader({
    storage: localStorage,
    fetchImpl: (...args) => fetch(...args),
    maxConcurrent: 4,
  });

  const saveStatus = async (phase, message, failedAt) => {
    const status = { phase, message };
    if (failedAt) status.failedAt = failedAt;
    await chrome.storage.session.set({ [STATUS_KEY]: status });
  };

  const rememberPremium = async (premium) => {
    const stored = await chrome.storage.local.get(PREMIUM_KEY);
    if (typeof premium === 'boolean') {
      if (stored[PREMIUM_KEY] !== premium) await chrome.storage.local.set({ [PREMIUM_KEY]: premium });
      return premium;
    }
    return typeof stored[PREMIUM_KEY] === 'boolean' ? stored[PREMIUM_KEY] : null;
  };

  const getStatus = async () => {
    const statusResult = await chrome.storage.session.get(STATUS_KEY);
    let status = statusResult[STATUS_KEY] || { phase: 'ready' };
    if (activeRequests.size > 0) {
      status = { phase: 'fetching', message: 'Loading Sorsa scores…' };
    } else if (status.phase === 'fetching') {
      status = { phase: 'ready' };
    } else if (status.phase === 'error' && Date.now() - Number(status.failedAt || 0) >= ERROR_TTL_MS) {
      status = { phase: 'ready' };
    } else if (status.phase === 'auth') {
      try {
        const response = await fetch('https://app.sorsa.io/', { method: 'HEAD', credentials: 'include' });
        if (response.ok && response.url && new URL(response.url).pathname !== '/authorization') {
          await generationReady;
          const stored = Number((await chrome.storage.local.get(GENERATION_KEY))[GENERATION_KEY]);
          const nextGeneration = Math.max(loader.getGeneration(), Number.isSafeInteger(stored) ? stored : 0) + 1;
          await loader.invalidateGeneration(nextGeneration);
          await chrome.storage.local.set({ [GENERATION_KEY]: nextGeneration });
          status = { phase: 'ready', message: 'Sorsa scores are available.' };
          await chrome.storage.session.set({ [STATUS_KEY]: status });
        }
      } catch { /* Keep the last known sign-in state while the site is unreachable. */ }
    }
    const all = await chrome.storage.local.get(null);
    const cacheEntries = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX)).length;
    let premium = null;
    if (status.phase !== 'auth') {
      try {
        const response = await fetch('https://app.sorsa.io/', { credentials: 'include', cache: 'no-store' });
        if (response.ok && new URL(response.url).pathname === '/authorization') {
          status = { phase: 'auth', message: 'Sign in to Sorsa to see scores on X.' };
          await chrome.storage.session.set({ [STATUS_KEY]: status });
          await chrome.storage.local.remove(PREMIUM_KEY);
        } else if (response.ok) {
          premium = core.extractSorsaData(await response.text()).premium;
        }
      } catch { /* The score status remains available when the plan check fails. */ }
    }
    if (status.phase !== 'auth') premium = await rememberPremium(premium);
    return { ...status, cacheEntries, premium, showBots: all[SHOW_BOTS_KEY] !== false };
  };

  let sessionCheckInFlight = null;
  const checkSessionQuietly = () => {
    if (sessionCheckInFlight) return sessionCheckInFlight;
    sessionCheckInFlight = (async () => {
      const checked = Number((await chrome.storage.local.get(AUTH_CHECK_KEY))[AUTH_CHECK_KEY]);
      if (Date.now() - checked < AUTH_CHECK_INTERVAL_MS) return { checked: false };
      await chrome.storage.local.set({ [AUTH_CHECK_KEY]: Date.now() });
      return { ...(await getStatus()), checked: true };
    })();
    return sessionCheckInFlight.finally(() => { sessionCheckInFlight = null; });
  };

  const checkBotOnSorsa = async (accountId) => {
    const message = { type: 'SORSA_CHECK_BOT', accountId };
    const tabs = await chrome.tabs.query({ url: 'https://app.sorsa.io/*' });
    for (const tab of tabs) {
      try { return await chrome.tabs.sendMessage(tab.id, message); } catch { /* Try a Sorsa tab with the bridge loaded. */ }
    }
    const tab = await chrome.tabs.create({ url: 'https://app.sorsa.io/', active: false });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { return await chrome.tabs.sendMessage(tab.id, message); } catch { /* Wait for the Sorsa page to load. */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { ok: false };
    } finally {
      try { await chrome.tabs.remove(tab.id); } catch { /* The temporary tab may already be closed. */ }
    }
  };

  const getBots = async (handle, refresh = false) => {
    const settings = await chrome.storage.local.get(SHOW_BOTS_KEY);
    if (settings[SHOW_BOTS_KEY] === false) return { enabled: false };
    const key = `${BOT_PREFIX}${handle}`;
    const stored = await chrome.storage.local.get(key);
    let latest = stored[key] || null;
    let response;
    try {
      response = await fetch(`https://app.sorsa.io/profile/${encodeURIComponent(handle)}`, {
        credentials: 'include', cache: 'no-store',
      });
    } catch {
      return { premium: await rememberPremium(null), latest, error: 'Bot data temporarily unavailable' };
    }
    if (response.ok && new URL(response.url).pathname === '/authorization') {
      await chrome.storage.local.remove(PREMIUM_KEY);
      return { authRequired: true };
    }
    if (!response.ok) return { premium: await rememberPremium(null), latest, error: 'Bot data temporarily unavailable' };
    let parsed;
    try {
      parsed = core.extractSorsaData(await response.text(), handle);
    } catch {
      return { premium: await rememberPremium(null), latest, error: 'Bot data temporarily unavailable' };
    }
    const premium = await rememberPremium(parsed.premium);
    const { account } = parsed;
    if (premium !== true) return { premium };
    if (!account) return { premium: true, latest, error: 'Profile unavailable' };
    const bot = account.bot_followers;
    if (bot?.status === 'finish' && Number.isFinite(bot.value) && bot.value >= 0 && bot.value <= 100 && Number.isFinite(bot.last_update) && bot.last_update > 0) {
      latest = { value: bot.value, lastUpdate: bot.last_update };
      await chrome.storage.local.set({ [key]: latest });
    } else if ((bot?.status === 'waiting' || bot?.status === 'process') && Number.isFinite(bot.value) && bot.value > 0 && bot.value <= 100) {
      latest = { value: bot.value, lastUpdate: Number.isFinite(bot.last_update) ? bot.last_update : null };
    }
    if (refresh && bot?.status !== 'waiting' && bot?.status !== 'process') {
      try {
        const request = await checkBotOnSorsa(account.id);
        if (!request?.ok) return { premium: true, latest, error: request?.status ? `Refresh failed (${request.status})` : 'Refresh failed' };
      } catch {
        return { premium: true, latest, error: 'Refresh failed' };
      }
    }
    return {
      premium: true, latest,
      updating: refresh || bot?.status === 'waiting' || bot?.status === 'process',
      spinning: bot?.status === 'process' || (refresh && bot?.status !== 'waiting'),
    };
  };

  const generationReady = chrome.storage.local.get(GENERATION_KEY).then((result) => {
    const stored = Number(result[GENERATION_KEY]);
    if (Number.isSafeInteger(stored) && stored > 0) return loader.invalidateGeneration(stored);
    return undefined;
  });
  let clearBarrier = generationReady;

  const clearCache = () => {
    clearEpoch += 1;
    activeRequests.clear();
    const oldOperationsSettled = loader.invalidateGeneration();
    const invalidatedGeneration = loader.getGeneration();
    const operation = clearBarrier.then(async () => {
      await oldOperationsSettled;
      const generationResult = await chrome.storage.local.get(GENERATION_KEY);
      const stored = Number(generationResult[GENERATION_KEY]);
      const nextGeneration = Number.isSafeInteger(stored)
        ? Math.max(invalidatedGeneration, stored + 1)
        : invalidatedGeneration;

      if (nextGeneration > loader.getGeneration()) await loader.invalidateGeneration(nextGeneration);
      const all = await chrome.storage.local.get(null);
      const cacheKeys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
      if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
      await chrome.storage.local.set({ [GENERATION_KEY]: nextGeneration });
      await saveStatus('ready', 'Score cache cleared.');
      return getStatus();
    });
    clearBarrier = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const getScore = async (handle, profileHandle) => {
    const requestEpoch = clearEpoch;
    await clearBarrier;
    if (requestEpoch !== clearEpoch) return null;
    const activity = {};
    activeRequests.add(activity);
    await saveStatus('fetching', 'Loading Sorsa scores…');
    if (requestEpoch !== clearEpoch) {
      activeRequests.delete(activity);
      return null;
    }
    const requestGeneration = loader.getGeneration();
    let result = null;
    try {
      result = await loader.getScore(handle, profileHandle);
    } catch {
      result = null;
    } finally {
      activeRequests.delete(activity);
    }

    const invalidated = requestGeneration !== loader.getGeneration() || requestEpoch !== clearEpoch;
    if (activeRequests.size > 0) {
      await saveStatus('fetching', 'Loading Sorsa scores…');
    } else if (invalidated) {
      await saveStatus('ready', 'Score cache cleared.');
    } else if (result?.authRequired) {
      await chrome.storage.local.remove(PREMIUM_KEY);
      await saveStatus('auth', 'Sign in to Sorsa to see scores on X.');
    } else if (!result) {
      await saveStatus('error', 'Sorsa is temporarily unavailable. Please try again later.', Date.now());
    } else {
      await saveStatus('ready', 'Sorsa scores are available.');
    }
    return invalidated || result?.authRequired ? null : result;
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'GET_STATUS') {
      getStatus().then(sendResponse);
      return true;
    }

    if (message && message.type === 'CHECK_SESSION') {
      checkSessionQuietly().then(sendResponse).catch(() => sendResponse({ checked: true, phase: 'error' }));
      return true;
    }

    if (message && message.type === 'CLEAR_CACHE') {
      clearCache().then(sendResponse);
      return true;
    }

    if (message && message.type === 'SET_SHOW_BOTS') {
      chrome.storage.local.set({ [SHOW_BOTS_KEY]: message.enabled === true }).then(() => getStatus()).then(sendResponse);
      return true;
    }

    if (message && (message.type === 'SORSA_GET_BOTS' || message.type === 'SORSA_REFRESH_BOTS')) {
      const handle = core.normalizeHandle(message.handle);
      if (!handle) {
        sendResponse({ error: 'Invalid handle' });
        return false;
      }
      getBots(handle, message.type === 'SORSA_REFRESH_BOTS')
        .then(sendResponse)
        .catch(() => sendResponse({ error: 'Bot data unavailable' }));
      return true;
    }

    if (message && message.type === 'SORSA_GET_SCORE') {
      const handle = core.normalizeHandle(message.handle);
      if (!handle) {
        sendResponse({ score: null });
        return false;
      }
      const observedHandle = typeof message.profileHandle === 'string' && core.normalizeHandle(message.profileHandle) === handle
        ? message.profileHandle
        : handle;
      getScore(handle, observedHandle).then((result) => {
        sendResponse(result ? { score: result.score, source: result.source, cachedAt: result.cachedAt } : { score: null });
      }).catch(() => sendResponse({ score: null }));
      return true;
    }
    return false;
  });
})();
