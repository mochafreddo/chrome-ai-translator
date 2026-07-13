(function initTranslationValidation(globalScope) {
  const codec =
    globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports
      ? require('./inline-block.js')
      : null);

  const PROTOCOL_CODES = Object.freeze({
    INVALID_JSON: 'protocol.invalid_json',
    MISSING_TRANSLATIONS: 'protocol.missing_translations',
    MISSING_ID: 'protocol.missing_id',
    DUPLICATE_ID: 'protocol.duplicate_id',
    UNEXPECTED_ID: 'protocol.unexpected_id',
    MISSING_TEMPLATE: 'protocol.missing_template',
  });
  const QUALITY_CODES = Object.freeze({
    ENGLISH_RESIDUE: 'quality.english_residue',
    EMPTY_PROSE: 'quality.empty_prose',
    TARGET_LANGUAGE_MISSING: 'quality.target_language_missing',
  });
  const ENGLISH_MARKERS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in',
    'is', 'it', 'not', 'of', 'on', 'or', 'read', 'reads', 'the', 'this',
    'to', 'use', 'uses', 'with', 'you', 'your',
  ]);

  function validationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function mapStructureCode(code) {
    const known = new Set([
      'token_missing', 'token_duplicate', 'token_unknown',
      'token_nesting_invalid', 'token_parent_changed', 'output_too_long',
      'output_parse_failed',
    ]);
    return `structure.${known.has(code) ? code : 'output_parse_failed'}`;
  }

  function words(value) {
    const proseOnly = String(value || '').replace(
        /\b[A-Za-z0-9_-]+\.(?:md|json|ya?ml|toml|js|ts|tsx?|jsx?|py|rb|go|rs)\b/gi,
        ' '
      );
    return Array.from(
      proseOnly.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g),
      (match) => match[0]
    );
  }

  function sharedEnglishEvidence(source, output) {
    const sourceWords = words(source);
    const outputWords = words(output).map((word) => word.toLowerCase());
    let longest = 0;
    let count = 0;
    for (let length = Math.min(4, sourceWords.length); length >= 2; length -= 1) {
      const outputSequences = new Set();
      for (let index = 0; index <= outputWords.length - length; index += 1) {
        outputSequences.add(outputWords.slice(index, index + length).join('\u0000'));
      }
      for (let index = 0; index <= sourceWords.length - length; index += 1) {
        const sequence = sourceWords.slice(index, index + length);
        const normalized = sequence.map((word) => word.toLowerCase());
        const looksLikeProse =
          length >= 3 ||
          normalized.some((word) => ENGLISH_MARKERS.has(word)) ||
          sequence.slice(1).some((word) => /^[a-z]/.test(word));
        if (looksLikeProse && outputSequences.has(normalized.join('\u0000'))) {
          longest = Math.max(longest, length);
          count += 1;
        }
      }
      if (longest) break;
    }
    return { longest, count };
  }

  function removeContractTokens(value, contract) {
    let text = String(value || '');
    for (const entry of contract?.entries || []) {
      for (const token of [entry.token, entry.openToken, entry.closeToken]) {
        if (typeof token === 'string' && token) text = text.split(token).join(' ');
      }
    }
    return text;
  }

  function isKoreanTarget(targetLanguage) {
    const value = String(targetLanguage || '').normalize('NFKC').trim();
    return /^ko(?:[-_][a-z0-9]+)*$/i.test(value) ||
      /^(?:korean|south korean|north korean)\b/i.test(value) ||
      /^(?:한국어|한국말|조선어|조선말)(?:\s|$|\()/.test(value);
  }

  function countUnicodeLetters(value) {
    return Array.from(String(value || '').matchAll(/\p{L}/gu)).length;
  }

  function countHangulSyllables(value) {
    return Array.from(String(value || '').matchAll(/[가-힣]/g)).length;
  }

  function assessTranslationQuality(sourceText, translatedText, targetLanguage, contract = null) {
    const source = removeContractTokens(sourceText, contract);
    const output = removeContractTokens(translatedText, contract);
    const evidence = {
      sourceChars: source.length,
      outputChars: output.length,
      sharedEnglishSequenceLength: 0,
      sharedEnglishSequenceCount: 0,
    };
    if (!output.trim()) {
      return { status: 'partial', codes: [QUALITY_CODES.EMPTY_PROSE], evidence };
    }
    const sourceProseWordCount = words(source).filter(
      (word) => !/^[A-Z0-9_]{2,}$/.test(word)
    ).length;
    const outputLetterCount = countUnicodeLetters(output);
    const outputHangulCount = countHangulSyllables(output);
    Object.assign(evidence, {
      sourceProseWordCount,
      outputLetterCount,
      outputHangulCount,
    });
    if (
      isKoreanTarget(targetLanguage) &&
      sourceProseWordCount >= 2 &&
      outputLetterCount >= 2 &&
      outputHangulCount === 0
    ) {
      return {
        status: 'partial',
        codes: [QUALITY_CODES.TARGET_LANGUAGE_MISSING],
        evidence,
      };
    }
    if (!/^en(?:glish)?\b/i.test(String(targetLanguage || '').trim())) {
      const shared = sharedEnglishEvidence(source, output);
      evidence.sharedEnglishSequenceLength = shared.longest;
      evidence.sharedEnglishSequenceCount = shared.count;
      if (shared.count) {
        return {
          status: 'partial',
          codes: [QUALITY_CODES.ENGLISH_RESIDUE],
          evidence,
        };
      }
    }
    return { status: 'complete', codes: [], evidence };
  }

  function validateBlockResponse(outputText, records, options = {}) {
    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw validationError(PROTOCOL_CODES.INVALID_JSON, 'Invalid translation JSON');
    }
    if (!Array.isArray(parsed?.translations)) {
      throw validationError(
        PROTOCOL_CODES.MISSING_TRANSLATIONS,
        'Translation response is missing translations'
      );
    }
    const expected = new Map((records || []).map((record) => [record.id, record]));
    const returned = new Map();
    for (const item of parsed.translations) {
      if (!expected.has(item?.id)) {
        throw validationError(PROTOCOL_CODES.UNEXPECTED_ID, 'Unexpected translation id');
      }
      if (returned.has(item.id)) {
        throw validationError(PROTOCOL_CODES.DUPLICATE_ID, 'Duplicate translation id');
      }
      if (typeof item.template !== 'string') {
        throw validationError(PROTOCOL_CODES.MISSING_TEMPLATE, 'Missing translation template');
      }
      returned.set(item.id, item.template);
    }
    for (const record of records || []) {
      if (!returned.has(record.id)) {
        throw validationError(PROTOCOL_CODES.MISSING_ID, 'Missing translation id');
      }
    }
    return {
      protocol: { status: 'valid', codes: [] },
      records: (records || []).map((record) => {
        const template = returned.get(record.id);
        const structureValidation = codec.validateTranslatedTemplate(
          template,
          record.contract
        );
        const structure = structureValidation.ok
          ? { status: 'safe', codes: [] }
          : {
              status: 'unsafe',
              codes: [mapStructureCode(structureValidation.errorCode)],
            };
        return {
          id: record.id,
          template,
          structure,
          quality: structureValidation.ok
            ? assessTranslationQuality(
                record.template,
                template,
                options.targetLanguage,
                record.contract
              )
            : { status: 'uncertain', codes: [], evidence: {} },
        };
      }),
    };
  }

  const api = {
    PROTOCOL_CODES,
    QUALITY_CODES,
    assessTranslationQuality,
    validateBlockResponse,
  };
  globalScope.ChromeAiTranslatorValidation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
