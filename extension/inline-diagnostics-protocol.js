(function initInlineDiagnosticsProtocol(globalScope) {
  const protocol = Object.freeze({
    messages: Object.freeze({
      recordLocal: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
      recordRuntime: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
    }),
    localCodes: Object.freeze([
      'runtime.unsupported_block',
      'runtime.block_too_large',
      'runtime.session_too_large',
    ]),
    limits: Object.freeze({
      maxRecords: 500,
      maxRecordCost: 12000,
      maxSessionCost: 60000,
    }),
    uuidV4Pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    createUuidV4() {
      if (globalScope.crypto?.randomUUID) return globalScope.crypto.randomUUID();
      const bytes = globalScope.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
      return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
    },
  });

  globalScope.ChromeAiTranslatorInlineDiagnosticsProtocol = protocol;
  if (typeof module !== 'undefined' && module.exports) module.exports = protocol;
})(typeof globalThis !== 'undefined' ? globalThis : this);
