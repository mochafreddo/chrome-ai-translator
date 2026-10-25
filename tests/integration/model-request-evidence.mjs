export async function observeModelRequests(cdp, sessionId, { reasoningUsage = false } = {}) {
  const requests = [];
  const requestIds = new Set();
  const responseIds = new Set();
  const completedRequests = new Set();
  const reasoningTokens = [];
  const pending = new Set();
  const subscriptions = [
    cdp.on('Network.requestWillBeSent', (event, sourceSession) => {
      if (sourceSession !== sessionId || event.request?.method !== 'POST' ||
          !/^https:\/\/(?:api\.openai\.com|openrouter\.ai)\//.test(event.request?.url || '')) return;
      requestIds.add(event.requestId);
      try {
        const body = JSON.parse(event.request.postData || '{}');
        requests.push({ service: event.request.url.startsWith('https://openrouter.ai/') ? 'openrouter' : 'openai',
          model: body.model, reasoning: body.reasoning && { effort: body.reasoning.effort },
          provider: body.provider && { require_parameters: body.provider.require_parameters,
            data_collection: body.provider.data_collection, zdr: body.provider.zdr }, format: body.text?.format?.type,
          strict: body.text?.format?.strict, maxOutputTokens: body.max_output_tokens, store: body.store });
      } catch { requests.push({ malformed: true }); }
    }),
    cdp.on('Network.responseReceived', (event, sourceSession) => {
      if (sourceSession === sessionId && requestIds.has(event.requestId)) responseIds.add(event.requestId);
    }),
    cdp.on('Network.loadingFinished', (event, sourceSession) => {
      if (sourceSession !== sessionId || !responseIds.has(event.requestId) || completedRequests.has(event.requestId)) return;
      completedRequests.add(event.requestId);
      if (!reasoningUsage) return;
      const read = cdp.send('Network.getResponseBody', { requestId: event.requestId }, sessionId)
        .then(result => {
          const data = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
          const tokens = data.usage?.output_tokens_details?.reasoning_tokens;
          reasoningTokens.push(Number.isInteger(tokens) ? tokens : null);
        }).catch(() => reasoningTokens.push(null)).finally(() => pending.delete(read));
      pending.add(read);
    }),
  ];
  const close = () => subscriptions.forEach(unsubscribe => unsubscribe());
  const enabled = await cdp.send('Network.enable', {}, sessionId);
  if (enabled.__error || enabled.__timeout) {
    close();
    throw new Error('Model request evidence observer could not start.');
  }
  return { requests, requestIds, completedRequests, reasoningTokens, settle: () => Promise.all([...pending]), close };
}
