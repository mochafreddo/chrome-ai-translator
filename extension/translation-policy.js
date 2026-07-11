(function initTranslationPolicy(globalScope) {
  function firstCode(codes, fallback) {
    return Array.isArray(codes) && codes[0] ? codes[0] : fallback;
  }

  function decision(disposition, repairKind, terminalCode, messageKey) {
    return { disposition, repairKind, terminalCode, messageKey };
  }

  function decideBlockDisposition(record, attempt) {
    if (attempt !== 1 && attempt !== 2) {
      throw new TypeError('attempt must be 1 or 2');
    }
    if (record?.structure?.status === 'unsafe') {
      const code = firstCode(
        record.structure.codes,
        'structure.output_parse_failed'
      );
      return attempt === 1
        ? decision('retry', 'structure', code, 'repairing_structure')
        : decision('reject', null, code, 'unsafe_translation_rejected');
    }
    if (record?.quality?.status === 'complete') {
      return decision('apply', null, null, 'translation_complete');
    }
    const code = firstCode(
      record?.quality?.codes,
      'quality.target_language_uncertain'
    );
    return attempt === 1
      ? decision('retry', 'quality', code, 'repairing_quality')
      : decision(
          'apply_with_warning',
          null,
          code,
          'partial_translation_applied'
        );
  }

  const api = { decideBlockDisposition };
  globalScope.ChromeAiTranslatorPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
