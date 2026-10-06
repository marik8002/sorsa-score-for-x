(function () {
  const core = globalThis.SorsaScoreCore;
  if (!core) return;

  const resolvedScores = new Map();
  const pendingScores = new Map();
  const unavailableUntil = new Map();
  const botResults = new Map();
  const pendingBots = new Map();
  const pendingBotRefreshes = new Set();
  let botRetryTimer = null;
  const CACHE_PREFIX = 'sorsa-score:';
  const GENERATION_KEY = 'sorsa-cache-generation';
  const CACHE_TTL_MS = core.CACHE_TTL_MS || 24 * 60 * 60 * 1000;
  const SESSION_CHECK_INTERVAL_MS = 10 * 60 * 1000;
  const IDENTITY_REGION_SELECTOR = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"], [data-testid="HoverCard"]';
  const FOLLOWERS_SELECTOR = 'a[href$="/followers"], a[href$="/verified_followers"]';
  const RETRY_AFTER_MS = 60 * 1000;
  const affectedRegions = new Set();
  let incrementalQueued = false;
  let fullScanQueued = false;
  let scanCount = 0;
  let fullScanCount = 0;
  let cacheGeneration = 0;
  let observedLocation = globalThis.location ? globalThis.location.href : '';

  const checkSorsaSession = () => {
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_SESSION' }, () => void chrome.runtime.lastError);
    } catch { /* The extension may be reloaded while this tab remains open. */ }
  };
  checkSorsaSession();
  setInterval(checkSorsaSession, SESSION_CHECK_INTERVAL_MS);

  const requestBots = (handle, refresh = false, force = false) => {
    if (!refresh && pendingBots.has(handle)) return pendingBots.get(handle);
    if (!refresh && !force && botResults.has(handle) && Date.now() - botResults.get(handle).checkedAt < 30000) {
      return Promise.resolve(botResults.get(handle).result);
    }
    const promise = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: refresh ? 'SORSA_REFRESH_BOTS' : 'SORSA_GET_BOTS', handle }, (result) => {
          resolve(chrome.runtime.lastError ? { error: 'Bot data unavailable' } : result || { error: 'Bot data unavailable' });
        });
      } catch { resolve({ error: 'Bot data unavailable' }); }
    }).then((result) => {
      botResults.set(handle, { result, checkedAt: Date.now() });
      pendingBots.delete(handle);
      return result;
    });
    if (!refresh) pendingBots.set(handle, promise);
    return promise;
  };

  const paintBots = (widget, result) => {
    if (!widget.isConnected) return;
    const value = widget.querySelector('.sorsa-bot-value');
    const refresh = widget.querySelector('button');
    if (result.premium !== true || result.enabled === false) {
      widget.remove();
      return;
    }
    const latest = result.latest;
    const percent = latest ? Math.round(latest.value) : null;
    if (percent === null) value.textContent = 'Bots —';
    else {
      const amount = document.createElement('strong');
      amount.textContent = `${percent}%`;
      value.replaceChildren('Bots ', amount);
    }
    value.dataset.level = percent === null ? '' : percent < 15 ? 'green' : percent < 25 ? 'yellow' : 'red';
    if (result.error) value.textContent += ' !';
    const date = latest?.lastUpdate
      ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(latest.lastUpdate * 1000))
      : null;
    widget.title = result.error || (date ? `Last update: ${date}` : result.updating ? 'Updating on Sorsa' : 'Click to refresh');
    const pending = pendingBotRefreshes.has(widget.dataset.sorsaBotFor);
    const updating = Boolean(result.updating || pending);
    widget.classList.toggle('sorsa-bot-updating', Boolean(result.spinning || pending));
    refresh.disabled = updating;
  };

  const pollBots = (widget, handle, attempts = 0) => {
    if (widget.sorsaBotTimer) return;
    widget.sorsaBotTimer = setTimeout(async () => {
      widget.sorsaBotTimer = null;
      if (!widget.isConnected || canonicalProfileHandle() !== handle) return;
      const next = await requestBots(handle, false, true);
      paintBots(widget, next);
      if (next.updating) pollBots(widget, handle, attempts + 1);
    }, attempts < 36 ? 10000 : 60000);
  };

  const retryBotCheck = (handle) => {
    if (botRetryTimer) return;
    botRetryTimer = setTimeout(() => {
      botRetryTimer = null;
      if (canonicalProfileHandle() !== handle) return;
      botResults.delete(handle);
      queueFullScan();
    }, 60000);
  };

  const followerLinkFor = (handle) => {
    const root = document.querySelector('[data-testid="primaryColumn"]') || document;
    return [...root.querySelectorAll(FOLLOWERS_SELECTOR)].find((link) => {
      const path = new URL(link.href, globalThis.location.href).pathname.toLowerCase();
      return path === `/${handle}/followers` || path === `/${handle}/verified_followers`;
    });
  };

  const renderBots = async (badge, target, handle) => {
    if (canonicalProfileHandle() !== handle || !target.closest('[data-testid="UserName"]')) return;
    const followerLink = followerLinkFor(handle);
    if (!followerLink) return;
    const result = await requestBots(handle);
    if (!badge.isConnected || !followerLink.isConnected || canonicalProfileHandle() !== handle) return;
    if (result.premium === null || result.authRequired || result.error) retryBotCheck(handle);
    let widget = document.querySelector('.sorsa-bot-widget');
    if (result.premium !== true || result.enabled === false) {
      widget?.remove();
      return;
    }
    if (widget && widget.dataset.sorsaBotFor !== handle) {
      widget.remove();
      widget = null;
    }
    if (!widget) {
      widget = document.createElement('span');
      widget.className = 'sorsa-bot-widget';
      widget.dataset.sorsaBotFor = handle;
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 16 18" aria-hidden="true"><path fill="currentColor" d="M14.969 9.582a.91.91 0 0 0-1.04.773 5.87 5.87 0 0 1-1.678 3.317 5.964 5.964 0 0 1-8.426 0 5.965 5.965 0 0 1 0-8.425 5.88 5.88 0 0 1 3.211-1.65c.531-.1 1.102-.118 1.694-.051a5.9 5.9 0 0 1 2.26.76l-1.193.203a.916.916 0 1 0 .31 1.807l3.2-.547a.92.92 0 0 0 .748-1.058l-.548-3.2a.917.917 0 1 0-1.806.31l.143.843a7.7 7.7 0 0 0-2.905-.94 7.4 7.4 0 0 0-2.226.069A7.68 7.68 0 0 0 2.529 3.95c-3.037 3.038-3.037 7.98 0 11.018a7.77 7.77 0 0 0 5.509 2.279c1.995 0 3.99-.76 5.509-2.279a7.7 7.7 0 0 0 2.195-4.346.917.917 0 0 0-.774-1.04"/></svg>';
      button.setAttribute('aria-label', 'Refresh bot followers');
      const value = document.createElement('span');
      value.className = 'sorsa-bot-value';
      widget.append(value, button);
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        pendingBotRefreshes.add(handle);
        button.disabled = true;
        widget.classList.add('sorsa-bot-updating');
        const updated = await requestBots(handle, true);
        pendingBotRefreshes.delete(handle);
        const current = document.querySelector('.sorsa-bot-widget');
        if (current?.dataset.sorsaBotFor === handle) {
          paintBots(current, updated);
          if (updated.updating) pollBots(current, handle);
        }
      });
    }
    if (widget.previousElementSibling !== followerLink.parentElement) followerLink.parentElement.insertAdjacentElement('afterend', widget);
    paintBots(widget, result);
    if (result.updating) pollBots(widget, handle);
  };

  const ensureStyles = () => {
    if (document.getElementById('sorsa-score-styles')) return;
    const style = document.createElement('style');
    style.id = 'sorsa-score-styles';
    style.textContent = `
      .sorsa-score-badge {
        display: inline-flex !important;
        align-items: baseline !important;
        gap: 4px !important;
        margin-left: 6px !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: transparent !important;
        color: #2589ff !important;
        font: inherit !important;
        font-size: var(--sorsa-score-font-size, 14px) !important;
        font-weight: 600 !important;
        line-height: inherit !important;
        letter-spacing: inherit !important;
        white-space: nowrap !important;
        vertical-align: text-bottom !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        text-decoration: none !important;
        opacity: 1 !important;
      }
      .sorsa-score-badge:hover { filter: brightness(.84) !important; text-decoration: none !important; }
      .sorsa-score-badge:focus-visible { outline: 2px solid #2589ff !important; outline-offset: 2px !important; }
      .sorsa-score-inline-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: baseline !important;
        flex-wrap: wrap !important;
      }
      .sorsa-score-tweet-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: baseline !important;
        flex-wrap: nowrap !important;
      }
      .sorsa-score-mark {
        display: inline-flex !important;
        width: 1.41em !important;
        height: .8em !important;
        width: 1.94cap !important;
        height: 1.1cap !important;
        flex: 0 0 auto !important;
        transform: translateY(.05em) !important;
      }
      .sorsa-score-mark svg { display: block !important; width: 100% !important; height: 100% !important; }
      .sorsa-score-mark path[fill="#fff"] { fill: CanvasText !important; }
      .sorsa-score-value { font: inherit !important; color: inherit !important; }
      .sorsa-score-burgundy { color: #9b1c4a !important; }
      .sorsa-score-orange { color: #df6800 !important; }
      .sorsa-score-yellow { color: #c39100 !important; }
      .sorsa-score-green { color: #22a861 !important; }
      .sorsa-score-dark-green { color: #087a4b !important; }
      .sorsa-score-blue { color: #2589ff !important; }
      .sorsa-score-lilac { color: #9b5de5 !important; }
      .sorsa-bot-widget { display: inline-flex !important; align-items: center !important; gap: 4px !important; margin-left: 12px !important; font: 400 14px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important; color: #71767b !important; white-space: nowrap !important; vertical-align: middle !important; }
      .sorsa-bot-value { transform: translateY(1px) !important; }
      .sorsa-bot-value[data-level="green"] { color: #158751 !important; }
      .sorsa-bot-value[data-level="yellow"] { color: #967000 !important; }
      .sorsa-bot-value[data-level="red"] { color: #c34f54 !important; }
      .sorsa-bot-value strong { font-weight: 700 !important; }
      .sorsa-bot-widget button { display: inline-grid !important; place-items: center !important; width: 16px !important; height: 18px !important; padding: 0 !important; border: 0 !important; background: transparent !important; color: inherit !important; cursor: pointer !important; }
      .sorsa-bot-widget button svg { width: 14px !important; height: 16px !important; display: block !important; }
      .sorsa-bot-widget button:disabled { opacity: .45 !important; cursor: default !important; }
      .sorsa-bot-updating button:disabled { opacity: 1 !important; }
      .sorsa-bot-updating button svg { animation: sorsa-bot-spin 1.2s linear infinite !important; }
      @keyframes sorsa-bot-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .sorsa-bot-updating button svg { animation: none !important; } }
      .sorsa-bot-widget button:focus-visible { outline: 2px solid #2589ff !important; outline-offset: 2px !important; }
    `;
    document.documentElement.appendChild(style);
  };

  const hasHandleText = (element, handle) => {
    const text = (element.textContent || '').replace(/[\s\u200b]/g, '').toLowerCase();
    return text === `@${handle}` || text === handle;
  };

  const hasExactAtHandleText = (element, handle) => {
    const text = (element.textContent || '').replace(/[\s\u200b]/g, '').toLowerCase();
    return text === `@${handle}`;
  };

  const canonicalProfileHandle = () => {
    if (!globalThis.location) return null;
    const hostname = globalThis.location.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'x.com' && hostname !== 'twitter.com') return null;
    const segments = globalThis.location.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;
    return core.normalizeHandle(`@${segments[0]}`);
  };

  const isIdentityAnchorFor = (anchor, handle) => {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.isConnected) return false;
    const region = anchor.closest(IDENTITY_REGION_SELECTOR);
    if (region?.matches('[data-testid="UserCell"]')) {
      const links = [...region.querySelectorAll('a[href]')];
      const primaryHandle = links.map((link) => core.normalizeHandle(link.href)).find(Boolean);
      const mainHandleLink = links.find((link) => core.normalizeHandle(link.href) === primaryHandle && hasExactAtHandleText(link, primaryHandle));
      if (anchor !== mainHandleLink) return false;
    }
    return Boolean(region && region.isConnected && core.normalizeHandle(anchor.href || anchor.getAttribute('href') || '') === handle && hasHandleText(anchor, handle));
  };

  const isPlainProfileTargetFor = (target, handle) => {
    if (!(target instanceof HTMLElement) || target instanceof HTMLAnchorElement || !target.isConnected) return false;
    const region = target.closest('[data-testid="UserName"]');
    return Boolean(
      region &&
      region.matches(IDENTITY_REGION_SELECTOR) &&
      canonicalProfileHandle() === handle &&
      hasExactAtHandleText(target, handle) &&
      !target.querySelector('.sorsa-score-badge'),
    );
  };

  const isIdentityTargetFor = (target, handle) => (
    target instanceof HTMLAnchorElement
      ? isIdentityAnchorFor(target, handle)
      : isPlainProfileTargetFor(target, handle)
  );

  const addTarget = (targetsByHandle, handle, target) => {
    if (!targetsByHandle.has(handle)) targetsByHandle.set(handle, new Set());
    targetsByHandle.get(handle).add(target);
  };

  const identityTargetsInRegion = (region) => {
    const targetsByHandle = new Map();
    if (!(region instanceof HTMLElement) || !region.isConnected) return targetsByHandle;
    const anchorCandidates = new Map();
    for (const anchor of region.querySelectorAll('a[href]')) {
      const handle = core.normalizeHandle(anchor.href || anchor.getAttribute('href') || '');
      if (handle && isIdentityAnchorFor(anchor, handle)) addTarget(anchorCandidates, handle, anchor);
    }
    for (const [handle, candidates] of anchorCandidates) {
      const exactAtHandles = [...candidates].filter((anchor) => hasExactAtHandleText(anchor, handle));
      for (const anchor of exactAtHandles.length ? exactAtHandles : candidates) {
        addTarget(targetsByHandle, handle, anchor);
      }
    }

    if (region.matches('[data-testid="UserName"]')) {
      const handle = canonicalProfileHandle();
      if (handle) {
        const candidates = [...region.querySelectorAll('*')].filter((element) => (
          !(element instanceof HTMLAnchorElement) &&
          !element.classList.contains('sorsa-score-badge') &&
          hasExactAtHandleText(element, handle)
        ));
        const target = candidates.find((element) => !candidates.some((other) => other !== element && element.contains(other)));
        if (target && isPlainProfileTargetFor(target, handle)) addTarget(targetsByHandle, handle, target);
      }
    }
    return targetsByHandle;
  };

  const syncBadgeSize = (badge, handleTarget) => {
    let handleSize = 14;
    try {
      const measured = Number.parseFloat(globalThis.getComputedStyle(handleTarget).fontSize);
      if (Number.isFinite(measured)) handleSize = measured;
    } catch {
      // Keep the stable fallback when X is replacing a measured node.
    }
    const scoreSize = Math.round(handleSize * 10) / 10;
    const value = `${scoreSize}px`;
    if (badge.style.getPropertyValue('--sorsa-score-font-size') !== value) {
      badge.style.setProperty('--sorsa-score-font-size', value);
    }
  };

  const prepareUserCellRow = (target) => {
    const cell = target.closest('[data-testid="UserCell"]');
    const row = target.parentElement;
    if (!cell || !row || row === cell || !cell.contains(row)) return null;
    const targetText = (target.textContent || '').replace(/[\s\u200b]/g, '').toLowerCase();
    const rowText = (row.textContent || '').replace(/[\s\u200b]/g, '').toLowerCase();
    if (!targetText || !rowText.startsWith(targetText)) return null;
    row.classList.add('sorsa-score-inline-row');
    return row;
  };

  const tweetPlacement = (target) => {
    const region = target.closest('[data-testid="User-Name"]');
    if (!region) return null;
    let branch = target;
    while (branch.parentElement && branch.parentElement !== region.parentElement) {
      const row = branch.parentElement;
      const time = row.querySelector('time');
      if (time && !branch.contains(time)) {
        row.classList.add('sorsa-score-tweet-row');
        return { insertionPoint: branch, row };
      }
      if (row === region) break;
      branch = row;
    }
    return null;
  };

  const placementForTarget = (target) => {
    const tweet = tweetPlacement(target);
    if (tweet) return tweet;
    return { insertionPoint: target, row: prepareUserCellRow(target) };
  };

  const observedProfileHandle = (target, handle) => {
    let candidate = '';
    if (target instanceof HTMLAnchorElement) {
      try {
        candidate = decodeURIComponent(new URL(target.href, globalThis.location?.href).pathname.split('/').filter(Boolean)[0] || '');
      } catch {
        candidate = '';
      }
    }
    if (!candidate) candidate = (target.textContent || '').replace(/[\s\u200b]/g, '').replace(/^@/, '');
    return /^[a-zA-Z0-9_]{1,15}$/.test(candidate) && core.normalizeHandle(candidate) === handle
      ? candidate
      : handle;
  };

  const renderScore = (target, handle, score) => {
    if (!isIdentityTargetFor(target, handle)) return null;
    const placement = placementForTarget(target);
    const sibling = placement.insertionPoint.nextElementSibling;
    if (sibling && sibling.classList.contains('sorsa-score-badge')) {
      if (sibling.dataset.sorsaScoreFor === handle) {
        if (core.updateScoreLabel(sibling, score)) {
          syncBadgeSize(sibling, target);
          renderBots(sibling, target, handle).catch(() => {});
          return sibling;
        }
        sibling.remove();
      }
      if (sibling.isConnected) sibling.remove();
    }
    const badge = core.createScoreLabel(document, handle, score);
    badge.sorsaScoreTarget = target;
    syncBadgeSize(badge, target);
    placement.insertionPoint.insertAdjacentElement('afterend', badge);
    renderBots(badge, target, handle).catch(() => {});
    return badge;
  };

  const removeStaleBadgesInRegion = (region, activeTargets) => {
    for (const badge of region.querySelectorAll('.sorsa-score-badge')) {
      const target = badge.sorsaScoreTarget || badge.previousElementSibling;
      if (!activeTargets.has(target) || !isIdentityTargetFor(target, badge.dataset.sorsaScoreFor)) {
        const row = badge.parentElement;
        badge.remove();
        if (row && !row.querySelector('.sorsa-score-badge')) {
          row.classList.remove('sorsa-score-inline-row', 'sorsa-score-tweet-row');
        }
      }
    }
  };

  const requestScore = (handle, profileHandle) => {
    const cached = resolvedScores.get(handle);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return Promise.resolve(cached.score);
    if (cached) resolvedScores.delete(handle);
    if (pendingScores.has(handle)) return pendingScores.get(handle);
    if ((unavailableUntil.get(handle) || 0) > Date.now()) return Promise.resolve(null);

    let resolvePending;
    const pending = new Promise((resolve) => { resolvePending = resolve; });
    const requestGeneration = cacheGeneration;
    pendingScores.set(handle, pending);
    try {
      chrome.runtime.sendMessage({ type: 'SORSA_GET_SCORE', handle, profileHandle }, (result) => {
        if (pendingScores.get(handle) === pending) pendingScores.delete(handle);
        if (requestGeneration !== cacheGeneration) {
          resolvePending(null);
          return;
        }
        if (chrome.runtime.lastError || !result || result.score === null || result.score === undefined) {
          unavailableUntil.set(handle, Date.now() + RETRY_AFTER_MS);
          resolvePending(null);
          return;
        }
        resolvedScores.set(handle, {
          score: result.score,
          cachedAt: Number.isFinite(result.cachedAt) ? result.cachedAt : Date.now(),
        });
        unavailableUntil.delete(handle);
        resolvePending(result.score);
      });
    } catch {
      if (pendingScores.get(handle) === pending) pendingScores.delete(handle);
      unavailableUntil.set(handle, Date.now() + RETRY_AFTER_MS);
      resolvePending(null);
    }
    return pending;
  };

  const processRegions = async (regions) => {
    scanCount += 1;
    ensureStyles();
    const work = [];
    for (const region of regions) {
      if (!region.isConnected) continue;
      const targetsByHandle = identityTargetsInRegion(region);
      const activeTargets = new Set([...targetsByHandle.values()].flatMap((targets) => [...targets]));
      removeStaleBadgesInRegion(region, activeTargets);
      for (const [handle, targets] of targetsByHandle) {
        work.push((async () => {
          const profileHandle = observedProfileHandle([...targets][0], handle);
          const score = await requestScore(handle, profileHandle);
          if (score === null) return;
          for (const target of targets) renderScore(target, handle, score);
        })());
      }
    }
    await Promise.all(work);
  };

  const fullScan = async () => {
    fullScanQueued = false;
    fullScanCount += 1;
    for (const widget of document.querySelectorAll('.sorsa-bot-widget')) {
      if (widget.dataset.sorsaBotFor !== canonicalProfileHandle()) widget.remove();
    }
    const regions = [...document.querySelectorAll(IDENTITY_REGION_SELECTOR)];
    const regionSet = new Set(regions);
    for (const badge of document.querySelectorAll('.sorsa-score-badge')) {
      if (![...regionSet].some((region) => region.contains(badge))) {
        badge.remove();
      }
    }
    await processRegions(regions);
  };

  const queueFullScan = () => {
    if (fullScanQueued) return;
    fullScanQueued = true;
    requestAnimationFrame(() => { fullScan().catch(() => {}); });
  };

  const queueAffectedRegions = (regions) => {
    for (const region of regions) if (region && region.isConnected) affectedRegions.add(region);
    if (!affectedRegions.size || incrementalQueued) return;
    incrementalQueued = true;
    requestAnimationFrame(() => {
      incrementalQueued = false;
      const queued = [...affectedRegions];
      affectedRegions.clear();
      processRegions(queued).catch(() => {});
    });
  };

  const isOwnedNode = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && (element.id === 'sorsa-score-styles' || element.classList.contains('sorsa-score-badge') || element.closest('.sorsa-score-badge') || element.classList.contains('sorsa-bot-widget') || element.closest('.sorsa-bot-widget')));
  };

  const isOwnedMutation = (mutation) => {
    if (isOwnedNode(mutation.target)) return true;
    if (mutation.type !== 'childList') return false;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(isOwnedNode);
  };

  const closestIdentityRegion = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element && element.closest ? element.closest(IDENTITY_REGION_SELECTOR) : null;
  };

  const collectAffectedRegions = (mutations) => {
    const regions = new Set();
    for (const mutation of mutations) {
      if (isOwnedMutation(mutation)) continue;
      const containingRegion = closestIdentityRegion(mutation.target);
      if (containingRegion) regions.add(containingRegion);
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches(IDENTITY_REGION_SELECTOR)) regions.add(node);
        for (const region of node.querySelectorAll(IDENTITY_REGION_SELECTOR)) regions.add(region);
      }
    }
    return regions;
  };

  const observer = new MutationObserver((mutations) => {
    if (globalThis.location && globalThis.location.href !== observedLocation) {
      observedLocation = globalThis.location.href;
      queueFullScan();
      return;
    }
    if (canonicalProfileHandle() && mutations.some((mutation) => !isOwnedMutation(mutation) && (
      mutation.type === 'attributes' && mutation.target.matches?.(FOLLOWERS_SELECTOR) ||
      mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
        node.nodeType === Node.ELEMENT_NODE && (node.matches(FOLLOWERS_SELECTOR) || node.querySelector(FOLLOWERS_SELECTOR))
      ))
    ))) queueFullScan();
    queueAffectedRegions(collectAffectedRegions(mutations));
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
      characterData: true,
    });
  }
  addEventListener('popstate', queueFullScan);
  addEventListener('hashchange', queueFullScan);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const generationChanged = Object.prototype.hasOwnProperty.call(changes, GENERATION_KEY);
      const removedScoreRecord = Object.entries(changes).some(([key, change]) => (
        key.startsWith(CACHE_PREFIX) && change && change.newValue === undefined
      ));
      const botsChanged = Object.prototype.hasOwnProperty.call(changes, 'sorsa-show-bots') ||
        Object.prototype.hasOwnProperty.call(changes, 'sorsa-premium');
      if (botsChanged) {
        botResults.clear();
        pendingBots.clear();
        if (changes['sorsa-show-bots']?.newValue === false ||
            (Object.prototype.hasOwnProperty.call(changes, 'sorsa-premium') && changes['sorsa-premium'].newValue !== true)) {
          for (const widget of document.querySelectorAll('.sorsa-bot-widget')) widget.remove();
        }
        queueFullScan();
      }
      if (!generationChanged && !removedScoreRecord) return;
      const nextGeneration = Number(changes[GENERATION_KEY]?.newValue);
      cacheGeneration = Number.isSafeInteger(nextGeneration) && nextGeneration > cacheGeneration
        ? nextGeneration
        : cacheGeneration + 1;
      resolvedScores.clear();
      pendingScores.clear();
      unavailableUntil.clear();
      queueFullScan();
    });
  }

  globalThis.SorsaScoreContent = {
    scanNow: fullScan,
    queueScan: queueFullScan,
    getScanCount: () => scanCount,
    getFullScanCount: () => fullScanCount,
  };
  queueFullScan();
})();
