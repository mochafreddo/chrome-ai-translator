import { withOpenRouterTransport } from './live-key.mjs';

export function createMockTransport() {
  return {
    live: false,
    run: execute => execute(async ({ body, flow }) => {
      const outputText = flow === 'inline'
        ? JSON.stringify({ translations: JSON.parse(body.input).records.map(record => ({ id: record.id,
          template: `모의 응답입니다. ${record.template}` })) })
        : `모의 응답입니다.\n${body.input}`;
      const data = { status: 'completed', model: body.model,
        usage: { cost: 0.0001, output_tokens_details: { reasoning_tokens: 0 } },
        output: [{ type: 'message', content: [{ type: 'output_text', text: outputText }] }] };
      return { status: 200, text: async () => JSON.stringify(data) };
    }),
  };
}

export function createLiveTransport({ envPath }) {
  return { live: true, run: execute => withOpenRouterTransport({ envPath }, execute) };
}
