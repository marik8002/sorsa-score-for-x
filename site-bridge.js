chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SORSA_CHECK_BOT' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.accountId)) {
    return false;
  }
  fetch(`https://api.sorsa.io/v1/accounts/${message.accountId}/check-bot`, {
    method: 'POST', credentials: 'include',
  }).then(async (response) => {
    const result = await response.json().catch(() => null);
    sendResponse({ ok: response.ok && /^[0-9a-f-]{36}$/i.test(result?.id || ''), status: response.status });
  }).catch(() => sendResponse({ ok: false }));
  return true;
});
