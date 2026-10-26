import responseParser from '../../extension/openai-response.js';

export function getResponseMetadata(data, requestId, status) {
  return { requestId, status,
    responseId: typeof data?.id === 'string' ? data.id : null,
    model: typeof data?.model === 'string' ? data.model : null,
    provider: typeof data?.provider === 'string' ? data.provider : null,
    cost: typeof data?.usage?.cost === 'number' ? data.usage.cost : null,
    inputTokens: Number.isInteger(data?.usage?.input_tokens) ? data.usage.input_tokens : null,
    outputTokens: Number.isInteger(data?.usage?.output_tokens) ? data.usage.output_tokens : null,
    reasoningTokens: Number.isInteger(data?.usage?.output_tokens_details?.reasoning_tokens) ? data.usage.output_tokens_details.reasoning_tokens : null,
    cachedTokens: Number.isInteger(data?.usage?.input_tokens_details?.cached_tokens) ? data.usage.input_tokens_details.cached_tokens : null,
  };
}

export async function observeModelRequests(cdp, sessionId, { reasoningUsage = false, validateOutput = async () => true,
  onResponse = async () => {} } = {}) {
  const requests = [];
  const requestIds = new Set();
  const responseStatuses = new Map();
  const requestInputs = new Map();
  const responses = new Map();
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
        requestInputs.set(event.requestId, body.input);
        requests.push({ service: event.request.url.startsWith('https://openrouter.ai/') ? 'openrouter' : 'openai',
          model: body.model, reasoning: body.reasoning && { effort: body.reasoning.effort },
          provider: body.provider && { require_parameters: body.provider.require_parameters,
            data_collection: body.provider.data_collection, zdr: body.provider.zdr }, format: body.text?.format?.type,
          strict: body.text?.format?.strict, maxOutputTokens: body.max_output_tokens, store: body.store });
      } catch { requests.push({ malformed: true }); }
    }),
    cdp.on('Network.responseReceived', (event, sourceSession) => {
      if (sourceSession === sessionId && requestIds.has(event.requestId)) {
        responseStatuses.set(event.requestId, Number(event.response?.status) || 0);
      }
    }),
    cdp.on('Network.loadingFinished', (event, sourceSession) => {
      if (sourceSession !== sessionId || !responseStatuses.has(event.requestId) || completedRequests.has(event.requestId)) return;
      completedRequests.add(event.requestId);
      let usageRecorded = false;
      let responseReported = false;
      const read = cdp.send('Network.getResponseBody', { requestId: event.requestId }, sessionId)
        .then(async result => {
          const data = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
          responseReported = true;
          await onResponse(getResponseMetadata(data, event.requestId, responseStatuses.get(event.requestId)));
          if (reasoningUsage) {
            const tokens = data.usage?.output_tokens_details?.reasoning_tokens;
            reasoningTokens.push(Number.isInteger(tokens) ? tokens : null);
            usageRecorded = true;
          }
          const status = responseStatuses.get(event.requestId);
          const valid = status >= 200 && status < 300 && await validateOutput(
            responseParser.parseCompletedResponse(data), requestInputs.get(event.requestId)) === true;
          responses.set(event.requestId, { status, valid });
        }).catch(async () => {
          if (!responseReported) await onResponse({ requestId: event.requestId,
            status: responseStatuses.get(event.requestId), responseId: null, cost: null });
          if (reasoningUsage && !usageRecorded) reasoningTokens.push(null);
          responses.set(event.requestId, { status: responseStatuses.get(event.requestId), valid: false });
        }).finally(() => {
          requestInputs.delete(event.requestId);
          pending.delete(read);
        });
      pending.add(read);
    }),
    cdp.on('Network.loadingFailed', (event, sourceSession) => {
      if (sourceSession !== sessionId || !requestIds.has(event.requestId) || completedRequests.has(event.requestId)) return;
      completedRequests.add(event.requestId);
      responses.set(event.requestId, { status: responseStatuses.get(event.requestId) || 0, valid: false });
      const report = Promise.resolve(onResponse({ requestId: event.requestId,
        status: responseStatuses.get(event.requestId) || 0, responseId: null, cost: null }))
        .catch(() => { responses.set(event.requestId, { status: 0, valid: false }); })
        .finally(() => { requestInputs.delete(event.requestId); pending.delete(report); });
      pending.add(report);
    }),
  ];
  const close = () => {
    subscriptions.forEach(unsubscribe => unsubscribe());
    requestInputs.clear();
  };
  const enabled = await cdp.send('Network.enable', {}, sessionId);
  if (enabled.__error || enabled.__timeout) {
    close();
    throw new Error('Model request evidence observer could not start.');
  }
  function checkpointPending(ids) {
    const exactIds = [...new Set(ids)];
    return { requestIds: exactIds, pending: exactIds.length > 0 && exactIds.every(id =>
      requestIds.has(id) && !completedRequests.has(id)) };
  }
  function completedSuccessfully(checkpoint) {
    return checkpoint.pending && checkpoint.requestIds.every(id => responses.get(id)?.valid === true);
  }
  return { requests, requestIds, completedRequests, reasoningTokens, responses, checkpointPending,
    completedSuccessfully, settle: () => Promise.all([...pending]), close };
}
