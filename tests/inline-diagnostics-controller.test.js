const assert = require('node:assert/strict');
const protocol = require('../extension/inline-diagnostics-protocol.js');
const controller = require('../extension/inline-diagnostics-controller.js');

module.exports = {
  name: 'inline diagnostics controller',
  tests: [
    {
      name: 'creates protocol-valid correlation identifiers',
      fn() {
        assert.match(protocol.createUuidV4(), protocol.uuidV4Pattern);
      },
    },
    {
      name: 'bounds and allowlists local diagnostic input',
      fn() {
        const diagnostics = controller.normalizeLocalDiagnostics([
          {
            code: 'runtime.block_too_large',
            template: 'source',
            contract: {
              codecVersion: 1,
              namespace: 'n'.repeat(150),
              privateField: 'must not persist',
            },
            evidence: { recordCost: 13, raw: 'must not persist' },
          },
          { code: 'runtime.untrusted_code', template: 'ignored' },
        ], protocol);

        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].contract.namespace.length, 100);
        assert.deepEqual(diagnostics[0].evidence, { recordCost: 13 });
        assert.equal(Object.hasOwn(diagnostics[0].contract, 'privateField'), false);
      },
    },
    {
      name: 'drops diagnostic payloads over the shared record limit',
      fn() {
        const diagnostics = controller.normalizeLocalDiagnostics([{
          code: 'runtime.block_too_large',
          template: 'x'.repeat(protocol.limits.maxRecordCost + 1),
          contract: {},
        }], protocol);
        assert.deepEqual(diagnostics, []);
      },
    },
    {
      name: 'caps record count and cumulative session cost',
      fn() {
        const smallProtocol = {
          ...protocol,
          limits: { maxRecords: 2, maxRecordCost: 10, maxSessionCost: 5 },
        };
        const diagnostics = controller.normalizeLocalDiagnostics([
          { code: 'runtime.block_too_large', template: '123', contract: {} },
          { code: 'runtime.block_too_large', template: '456', contract: {} },
          { code: 'runtime.block_too_large', template: '7', contract: {} },
        ], smallProtocol);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].template, '123');
      },
    },
    {
      name: 'handles cyclic and malformed contracts without leaking incomplete source context',
      fn() {
        const cyclic = {};
        cyclic.entries = [cyclic];
        const malformed = {};
        Object.defineProperty(malformed, 'entries', { get() { throw new Error('malformed'); } });
        const diagnostics = controller.normalizeLocalDiagnostics([
          { code: 'runtime.unsupported_block', template: 'source', contract: cyclic },
          { code: 'runtime.block_too_large', template: 'unsafe', contract: malformed },
          { code: 'runtime.session_too_large', template: 'source only' },
        ], protocol);
        assert.equal(diagnostics.length, 3);
        assert.equal(diagnostics[0].template, 'source');
        assert.equal(Object.hasOwn(diagnostics[1], 'template'), false);
        assert.equal(Object.hasOwn(diagnostics[2], 'template'), false);
      },
    },
  ],
};
