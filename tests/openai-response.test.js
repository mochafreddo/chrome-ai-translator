const assert = require('node:assert/strict');
const responseApi = require('../extension/openai-response.js');

exports.name = 'OpenAI response boundary';
exports.tests = [
  {
    name: 'keeps a completed structured translation payload intact',
    fn() {
      const payload = JSON.stringify({
        translations: Array.from({ length: 8 }, (_, index) => ({
          id: `b1-${index + 1}`,
          template: `번역 ${index + 1}.`,
        })),
      });
      assert.equal(
        responseApi.parseCompletedResponse({
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: payload }],
          }],
        }),
        payload
      );
    },
  },
  {
    name: 'rejects non-empty incomplete output as retryable only for max tokens',
    fn() {
      assert.throws(
        () => responseApi.parseCompletedResponse({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: '부분 번역' }],
          }],
        }),
        (error) =>
          error.code === 'response.incomplete.max_output_tokens' &&
          error.retryable === true &&
          !String(error.message).includes('부분 번역')
      );
      assert.throws(
        () => responseApi.parseCompletedResponse({
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          output: [],
        }),
        (error) =>
          error.code === 'response.incomplete.other' &&
          error.retryable === false
      );
    },
  },
  {
    name: 'rejects failed cancelled missing-status and empty output',
    fn() {
      for (const [payload, code] of [
        [{ status: 'failed', output: [] }, 'response.failed'],
        [{ status: 'cancelled', output: [] }, 'response.cancelled'],
        [{ output: [] }, 'response.not_completed'],
        [{ status: 'completed', output: [] }, 'response.output_missing'],
      ]) {
        assert.throws(
          () => responseApi.parseCompletedResponse(payload),
          (error) => error.code === code && error.retryable === false
        );
      }
    },
  },
];
