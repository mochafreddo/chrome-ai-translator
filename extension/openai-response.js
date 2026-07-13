(function initOpenAiResponse(globalScope) {
  function responseError(code, message, retryable = false) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
  }

  function collectOutputText(responseJson) {
    const parts = [];
    for (const item of responseJson?.output || []) {
      for (const content of item?.content || []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          parts.push(content.text);
        }
      }
    }
    return parts.join('\n').trim();
  }

  function parseCompletedResponse(responseJson) {
    const status = String(responseJson?.status || '');
    if (status === 'incomplete') {
      const maxTokens =
        responseJson?.incomplete_details?.reason === 'max_output_tokens';
      throw responseError(
        maxTokens
          ? 'response.incomplete.max_output_tokens'
          : 'response.incomplete.other',
        maxTokens
          ? 'Translation output reached its token limit.'
          : 'Translation response was incomplete.',
        maxTokens
      );
    }
    if (status === 'failed') {
      throw responseError('response.failed', 'Translation response failed.');
    }
    if (status === 'cancelled') {
      throw responseError('response.cancelled', 'Translation response was cancelled.');
    }
    if (status !== 'completed') {
      throw responseError(
        'response.not_completed',
        'Translation response did not complete.'
      );
    }
    const text = collectOutputText(responseJson);
    if (!text) {
      throw responseError(
        'response.output_missing',
        'Completed translation response contained no text.'
      );
    }
    return text;
  }

  const api = { collectOutputText, parseCompletedResponse };
  globalScope.ChromeAiTranslatorOpenAiResponse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
