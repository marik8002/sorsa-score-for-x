(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SorsaScoreCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const PARSER_VERSION = 4;
  const SCORE_TONES = ['burgundy', 'orange', 'yellow', 'green', 'dark-green', 'blue', 'lilac'];
  let sorsaMarkId = 0;

  function normalizeHandle(value) {
    if (typeof value !== 'string') return null;
    let candidate = value.trim();
    if (!candidate) return null;

    try {
      if (/^https?:\/\//i.test(candidate)) {
        const url = new URL(candidate);
        if (!/^(www\.)?(x|twitter)\.com$/i.test(url.hostname)) return null;
        candidate = url.pathname.split('/').filter(Boolean)[0] || '';
      }
    } catch {
      return null;
    }

    candidate = candidate.replace(/^@+/, '').split(/[/?#\s]/)[0].trim();
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(candidate)) return null;
    if ([
      'home',
      'explore',
      'notifications',
      'messages',
      'bookmarks',
      'lists',
      'settings',
      'search',
      'compose',
      'login',
      'signup',
      'i',
      'intent',
      'tos',
      'privacy',
    ].includes(candidate.toLowerCase())) return null;
    return candidate.toLowerCase();
  }

  function scoreFromNumber(value) {
    if (typeof value !== 'number') {
      const scalar = String(value).trim();
      if (!/^[0-9]+(?:\.[0-9]+)?$/.test(scalar)) return null;
      value = Number(scalar);
    }
    const number = value;
    if (!Number.isFinite(number) || number < 0 || number > 9999) return null;
    return Math.round(number);
  }

  function extractScore(payload, expectedHandle) {
    if (payload === null || payload === undefined) return null;
    if (typeof payload === 'number') {
      return scoreFromNumber(payload);
    }

    if (typeof payload === 'object') {
      const preferredKeys = [
        'score',
        'sorsaScore',
        'sorsa_score',
        'sorsa',
        'rating',
      ];
      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
          const score = scoreFromNumber(payload[key]);
          if (score !== null) return score;
        }
      }
      for (const key of ['data', 'profile', 'user', 'result']) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
          const score = extractScore(payload[key], expectedHandle);
          if (score !== null) return score;
        }
      }
      return null;
    }

    const text = String(payload);
    const directScore = scoreFromNumber(text);
    if (directScore !== null) return directScore;
    const visibleHtml = text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
    const visibleText = visibleHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const visiblePatterns = [
      /(?:^|\b)sorsa\s*score\b\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)(?![0-9.])/i,
      /(?:^|\b)score\b\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)(?![0-9.])/i,
    ];
    let visibleScore = null;
    for (const pattern of visiblePatterns) {
      const match = visibleText.match(pattern);
      const score = match ? scoreFromNumber(match[1]) : null;
      if (score !== null) {
        visibleScore = score;
        break;
      }
    }
    if (visibleScore !== null && visibleScore > 0) return visibleScore;

    const serializedPatterns = [
      /["'](?:sorsaScore|sorsa_score|score)["']\s*:\s*["']?([0-9]+(?:\.[0-9]+)?)(?![0-9.])/i,
      /data-(?:sorsa-)?score=["']([0-9]+(?:\.[0-9]+)?)(?![0-9.])/i,
    ];
    const serializedCandidates = [];
    for (const pattern of serializedPatterns) {
      const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace('i', '')}gi`);
      for (const match of text.matchAll(globalPattern)) {
        const score = scoreFromNumber(match[1]);
        if (score !== null) serializedCandidates.push({ score, index: match.index || 0 });
      }
    }
    const positiveCandidates = serializedCandidates.filter(({ score }) => score > 0);
    const canonicalExpected = normalizeHandle(expectedHandle || '');
    if (canonicalExpected && positiveCandidates.length) {
      const lowerText = text.toLowerCase();
      const handleIndexes = [];
      let offset = 0;
      while ((offset = lowerText.indexOf(canonicalExpected, offset)) !== -1) {
        handleIndexes.push(offset);
        offset += canonicalExpected.length;
      }
      if (handleIndexes.length) {
        const nearby = positiveCandidates
          .map((candidate) => ({
            ...candidate,
            distance: Math.min(...handleIndexes.map((index) => Math.abs(candidate.index - index))),
          }))
          .filter(({ distance }) => distance <= 800)
          .sort((a, b) => a.distance - b.distance || a.index - b.index);
        if (nearby.length) return nearby[0].score;
      }
      if (positiveCandidates.length === 1) return positiveCandidates[0].score;
    } else if (positiveCandidates.length) {
      return positiveCandidates[0].score;
    }
    if (canonicalExpected && visibleScore === 0) return null;
    return visibleScore;
  }

  function extractSorsaData(html, expectedHandle) {
    const result = { premium: null, account: null };
    const handle = normalizeHandle(expectedHandle);
    if (typeof html !== 'string') return result;
    const chunks = html.matchAll(/self\.__next_f\.push\(\[\d+,"((?:\\.|[^"\\])*)"\]\)/g);
    for (const match of chunks) {
      try {
        const chunk = JSON.parse(`"${match[1]}"`);
        const payload = JSON.parse(chunk.slice(chunk.indexOf(':') + 1));
        const visit = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node.queryKey) && node.queryKey[0] === '@account/getMe') {
            const premium = node.state?.data?.is_premium;
            if (typeof premium === 'boolean') result.premium = premium;
          }
          if (handle && Array.isArray(node.queryKey) && node.queryKey[0] === '@profiles/searchAccounts') {
            const account = node.state?.data;
            if (normalizeHandle(account?.screen_name) === handle && /^[0-9a-f-]{36}$/i.test(account.id)) {
              result.account = {
                id: account.id,
                screen_name: account.screen_name,
                bot_followers: account.bot_followers || null,
              };
            }
          }
          for (const child of Object.values(node)) visit(child);
        };
        visit(payload);
      } catch { /* Other Flight chunks are not JSON records. */ }
    }
    return result;
  }

  function cacheKey(handle) {
    return `sorsa-score:${handle}`;
  }

  async function readCache(storage, handle, now) {
    const record = await storage.get(cacheKey(handle));
    if (!record || typeof record !== 'object') return null;
    if (typeof record.cachedAt !== 'number' || now - record.cachedAt >= CACHE_TTL_MS) {
      await storage.remove(cacheKey(handle));
      return null;
    }
    const score = scoreFromNumber(record.score);
    if (score === 0 && record.parserVersion !== PARSER_VERSION) {
      await storage.remove(cacheKey(handle));
      return null;
    }
    return score === null ? null : { handle, score, cachedAt: record.cachedAt, source: record.source || 'public' };
  }

  async function writeCache(storage, handle, score, source, now) {
    await storage.set(cacheKey(handle), { handle, score, cachedAt: now, source, parserVersion: PARSER_VERSION });
  }

  function createScoreLoader({
    storage,
    fetchImpl,
    now = () => Date.now(),
    maxConcurrent = 4,
    publicUrlForHandle = (handle) => `https://app.sorsa.io/profile/${encodeURIComponent(handle)}`,
  }) {
    const inFlight = new Map();
    const queue = [];
    let active = 0;
    let generation = 0;

    const runNext = () => {
      while (active < maxConcurrent && queue.length) {
        const job = queue.shift();
        active += 1;
        Promise.resolve()
          .then(job.run)
          .then(job.resolve, job.reject)
          .finally(() => {
            active -= 1;
            runNext();
          });
      }
    };

    const enqueue = (run) =>
      new Promise((resolve, reject) => {
        queue.push({ run, resolve, reject });
        runNext();
      });

    const request = async (handle, profileHandle, requestGeneration, controller) => {
      if (requestGeneration !== generation) return null;
      const cached = await readCache(storage, handle, now());
      if (requestGeneration !== generation) return null;
      if (cached) return cached;

      let score = null;
      try {
        const response = await fetchImpl(publicUrlForHandle(profileHandle), {
          credentials: 'include',
          signal: controller.signal,
        });
        if (response.url && new URL(response.url).pathname === '/authorization') {
          return requestGeneration === generation ? { authRequired: true } : null;
        }
        if (response.ok) score = extractScore(await response.text(), handle);
      } catch {
        score = null;
      }

      if (score === null || requestGeneration !== generation) return null;
      const cachedAt = now();
      await writeCache(storage, handle, score, 'public', cachedAt);
      if (requestGeneration !== generation) return null;
      return { handle, score, cachedAt, source: 'public' };
    };

    const getScore = (input, observedHandle) => {
      const handle = normalizeHandle(input);
      if (!handle) return Promise.resolve(null);
      let profileHandle = handle;
      if (typeof observedHandle === 'string') {
        const candidate = observedHandle.trim().replace(/^@+/, '');
        if (/^[a-zA-Z0-9_]{1,15}$/.test(candidate) && normalizeHandle(candidate) === handle) {
          profileHandle = candidate;
        }
      }
      const requestGeneration = generation;
      const existing = inFlight.get(handle);
      if (!existing || existing.generation !== requestGeneration) {
        const controller = new AbortController();
        let promise;
        promise = enqueue(() => request(handle, profileHandle, requestGeneration, controller)).finally(() => {
          if (inFlight.get(handle)?.promise === promise) inFlight.delete(handle);
        });
        inFlight.set(handle, { generation: requestGeneration, promise, controller });
      }
      return inFlight.get(handle).promise;
    };

    const invalidateGeneration = (nextGeneration = generation + 1) => {
      const invalidated = [...inFlight.values()];
      const numericGeneration = Number(nextGeneration);
      generation = Number.isSafeInteger(numericGeneration) && numericGeneration > generation
        ? numericGeneration
        : generation + 1;
      inFlight.clear();
      for (const { controller } of invalidated) controller.abort();
      return Promise.allSettled(invalidated.map(({ promise }) => promise));
    };

    return {
      getScore,
      invalidateGeneration,
      getGeneration: () => generation,
      getActiveCount: () => active,
      getPendingCount: () => queue.length,
    };
  }

  function scoreTone(score) {
    if (score >= 2500) return 'lilac';
    if (score >= 2000) return 'blue';
    if (score >= 1500) return 'dark-green';
    if (score >= 1000) return 'green';
    if (score >= 500) return 'yellow';
    if (score >= 350) return 'orange';
    return 'burgundy';
  }

  function createScoreLabel(doc, handle, score) {
    const label = doc.createElement('a');
    label.className = 'sorsa-score-badge';
    label.dataset.sorsaScoreFor = handle;
    label.href = `https://app.sorsa.io/profile/${encodeURIComponent(handle)}`;
    label.target = '_blank';
    label.rel = 'noopener noreferrer';
    const mark = doc.createElement('span');
    mark.className = 'sorsa-score-mark';
    mark.setAttribute('aria-hidden', 'true');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 60 34');
    svg.setAttribute('focusable', 'false');
    const defs = doc.createElementNS(ns, 'defs');
    const gradient = doc.createElementNS(ns, 'linearGradient');
    const gradientId = `sorsa-mark-${++sorsaMarkId}`;
    for (const [name, value] of Object.entries({ id: gradientId, x1: '-4.211', x2: '64.287', y1: '11.178', y2: '31.812', gradientUnits: 'userSpaceOnUse' })) gradient.setAttribute(name, value);
    for (const [offset, color] of [['0', '#38CCE8'], ['0.52', '#044CFE'], ['1', '#8C7AFE']]) {
      const stop = doc.createElementNS(ns, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', color);
      gradient.append(stop);
    }
    defs.append(gradient);
    svg.append(defs);
    for (const [fill, d] of [
      ['#fff', 'M16.386 11.022a.155.155 0 0 1 .309 0l.182 1.622c.233 2.095 1.789 3.748 3.762 3.998l1.527.194c.183.022.183.303 0 .325l-1.527.194c-1.973.25-3.529 1.9-3.762 3.998l-.182 1.622a.155.155 0 0 1-.309 0l-.182-1.622c-.233-2.095-1.789-3.748-3.762-3.998l-1.527-.194c-.183-.022-.183-.303 0-.325l1.527-.194c1.973-.25 3.529-1.9 3.762-3.998z'],
      [`url(#${gradientId})`, 'M44.114 27.607c-6.224.424-11.386-4.492-11.386-10.595S37.494 6.386 43.353 6.386s11.021 5.16 10.595 11.384c-.365 5.221-4.584 9.472-9.837 9.834zm-27.051 0c-6.406.396-11.69-4.888-11.294-11.291.334-5.28 4.615-9.593 9.899-9.927a10.66 10.66 0 0 1 11.324 11.322c-.334 5.28-4.646 9.562-9.926 9.896zM44.235.682C38.892.41 34.064 2.686 30.905 6.42c-.547.637-1.55.637-2.063 0-3.065-3.613-7.65-5.859-12.75-5.766C7.225.805.03 8.12 0 16.984c0 2.824.699 5.494 1.974 7.801a2.25 2.25 0 0 1-.365 2.673l-.351.35a3.226 3.226 0 0 0 0 4.585 3.226 3.226 0 0 0 4.584 0l.444-.44c.699-.7 1.729-.851 2.61-.396a16.2 16.2 0 0 0 7.44 1.79c4.98 0 9.44-2.245 12.447-5.766.548-.637 1.55-.637 2.064 0 3.006 3.52 7.467 5.767 12.447 5.767 9.261 0 16.698-7.681 16.333-16.998C59.383 7.971 52.614 1.11 44.235.684z'],
      ['#fff', 'M43.58 22.868a5.991 5.991 0 0 0 5.539-3.703 5.96 5.96 0 0 0 0-4.587 6 6 0 0 0-3.245-3.245 6 6 0 0 0-2.294-.457v11.992'],
    ]) {
      const path = doc.createElementNS(ns, 'path');
      path.setAttribute('fill', fill);
      path.setAttribute('d', d);
      svg.append(path);
    }
    mark.append(svg);
    const value = doc.createElement('span');
    value.className = 'sorsa-score-value';
    label.append(mark, value);
    updateScoreLabel(label, score);
    return label;
  }

  function updateScoreLabel(label, score) {
    const value = label && label.querySelector && label.querySelector('.sorsa-score-value');
    if (!value) return false;
    const numericScore = String(score);
    const tone = scoreTone(score);
    for (const name of SCORE_TONES) {
      label.classList.toggle(`sorsa-score-${name}`, name === tone);
    }
    if (value.textContent !== numericScore) value.textContent = numericScore;
    const title = `Sorsa Score: ${score}`;
    if (label.title !== title) label.title = title;
    const ariaLabel = `Sorsa Score ${score}`;
    if (label.getAttribute('aria-label') !== ariaLabel) label.setAttribute('aria-label', ariaLabel);
    return true;
  }

  function insertScoreLabel(anchor, handle, score, doc) {
    if (!anchor || !doc || score === null || score === undefined) return null;
    const existing = anchor.parentElement && anchor.parentElement.querySelector
      ? anchor.parentElement.querySelector(`[data-sorsa-score-for="${handle}"]`)
      : null;
    if (existing) {
      if (updateScoreLabel(existing, score)) return existing;
      existing.remove();
    }
    const label = createScoreLabel(doc, handle, score);
    if (anchor.insertAdjacentElement) anchor.insertAdjacentElement('afterend', label);
    else if (anchor.parentElement && anchor.parentElement.appendChild) anchor.parentElement.appendChild(label);
    return label;
  }

  return {
    CACHE_TTL_MS,
    normalizeHandle,
    extractScore,
    extractSorsaData,
    cacheKey,
    readCache,
    writeCache,
    createScoreLoader,
    scoreTone,
    createScoreLabel,
    updateScoreLabel,
    insertScoreLabel,
  };
});
