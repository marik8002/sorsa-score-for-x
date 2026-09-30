(function () {
  const label = document.getElementById('status-label');
  const message = document.getElementById('status-message');
  const dot = document.getElementById('status-dot');
  const session = document.getElementById('session-state');
  const login = document.getElementById('sorsa-login');
  const cacheCount = document.getElementById('cache-count');
  const refresh = document.getElementById('refresh-status');
  const clear = document.getElementById('clear-cache');
  const showBots = document.getElementById('show-bots');
  const premiumState = document.getElementById('premium-state');

  const fallbackMessages = {
    ready: 'Sorsa scores are ready on X.',
    fetching: 'Reading Sorsa profiles…',
    auth: 'Sign in to Sorsa to see scores on X.',
    error: 'Sorsa is temporarily unavailable. Please try again shortly.',
    idle: 'Open X to see scores beside account handles.',
  };

  const render = (status) => {
    const phase = status.phase || 'idle';
    label.textContent = phase === 'ready' ? 'Ready' : phase === 'fetching' ? 'Loading scores' : phase === 'auth' ? 'Sign in required' : phase === 'error' ? 'Temporarily unavailable' : 'Waiting';
    const suppliedMessage = typeof status.message === 'string' && !/[\u0400-\u04ff]/.test(status.message)
      ? status.message
      : '';
    message.textContent = suppliedMessage || fallbackMessages[phase] || fallbackMessages.idle;
    dot.className = `dot ${phase}`;
    session.textContent = 'Sorsa profiles';
    login.hidden = phase !== 'auth';
    cacheCount.textContent = String(status.cacheEntries || 0);
    refresh.disabled = phase === 'fetching';
    showBots.disabled = status.premium !== true;
    showBots.checked = status.premium === true && status.showBots !== false;
    premiumState.textContent = status.premium === true
      ? 'Sorsa Plus active'
      : status.premium === false ? 'Sorsa Plus is required' : 'Plus status unavailable';
  };

  const load = (complete) => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (!chrome.runtime.lastError && status) render(status);
    if (complete) complete(status);
  });

  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    load((status) => {
      refresh.disabled = Boolean(status && status.phase === 'fetching');
    });
  });

  clear.addEventListener('click', () => {
    clear.disabled = true;
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (status) => {
      clear.disabled = false;
      if (!chrome.runtime.lastError && status) render(status);
    });
  });

  showBots.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_SHOW_BOTS', enabled: showBots.checked }, (status) => {
      if (!chrome.runtime.lastError && status) render(status);
    });
  });

  load();
})();
