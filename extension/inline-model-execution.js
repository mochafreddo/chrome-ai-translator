(function initInlineModelExecution(globalScope) {
  const codec = globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-block.js') : null);
  const { getToneInstruction, getTargetLanguageCode } =
    globalScope.ChromeAiTranslatorTranslationSettings ||
    (typeof module !== 'undefined' && module.exports ? require('./translation-settings.js') : {});
  const INLINE_BLOCK_MIN_OUTPUT_TOKENS = 4096;
  const INLINE_BLOCK_MAX_OUTPUT_TOKENS = 16000;

  function isKoreanTargetLanguage(targetLanguage) {
    return getTargetLanguageCode(targetLanguage) === 'ko';
  }

  function buildBlockInstructions({ targetLanguage, tone }) {
    const instructions = [
      `Translate each complete semantic block into ${targetLanguage}.`,
      getToneInstruction(tone),
      'Return one translation object for every input record and preserve every id exactly.',
      'Preserve every token byte-for-byte and emit each token exactly once.',
      'Translate all source-language prose, including text between wrapper OPEN and CLOSE tokens; wrapper tokens preserve formatting, not wording.',
      'Use atom labels only as context; atomic visible text remains represented by its token and only atom text marked preserveText may remain unchanged.',
      'Reorder and rewrite grammar naturally for the target language; source word order is not a constraint, but token parent relationships must not change.',
      'Never return the source template unchanged or partially copy source-language prose.',
    ];
    if (isKoreanTargetLanguage(targetLanguage)) {
      instructions.push(
        'For Korean, place a preserved atom before the translated noun phrase when natural. Example: “Reasoning models like [GPT-5.5] use ...” becomes “[GPT-5.5]와 같은 추론 모델은 ...”; write “모델은”, never “모델는”, choose particles from the visible label, and never emit empty example parenthesis.',
        'For Korean, do not guess a particle after an opaque technical or model atom. Add an appropriate classifier and attach the particle there, such as “[gpt-5.4] 모델을 고려하세요,” never “[gpt-5.4]을 고려하세요,” or rewrite the sentence to avoid a direct particle.'
      );
    }
    instructions.push(
      'When repair is non-null, redo the translation and correct previousErrorCode.',
      'Do not output HTML, Markdown, commentary, or any field not required by the schema.'
    );
    return instructions.join('\n');
  }

  function buildBlockResponseFormat(recordCount) {
    const count = Number(recordCount);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Semantic Block response format needs a record count');
    }
    return {
      type: 'json_schema',
      name: 'inline_block_translations',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          translations: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                template: { type: 'string' },
              },
              required: ['id', 'template'],
            },
          },
        },
        required: ['translations'],
      },
    };
  }

  function getBlockBatchMaxOutputTokens(recordCost) {
    const scaled = Math.ceil((Number(recordCost) || 0) * 1.25);
    return Math.min(
      INLINE_BLOCK_MAX_OUTPUT_TOKENS,
      Math.max(INLINE_BLOCK_MIN_OUTPUT_TOKENS, scaled)
    );
  }

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
      'output_parse_failed', 'source_syntax_changed',
    ]);
    return `structure.${known.has(code) ? code : 'output_parse_failed'}`;
  }

  function words(value, contract = null) {
    const sourceSyntax = Array.isArray(contract?.sourceSyntax)
      ? contract.sourceSyntax.map((item) => item?.value).filter(Boolean)
      : [];
    const proseOnly = codec.stripSourceSyntax(
      String(value || ''),
      sourceSyntax
    );
    return Array.from(
      proseOnly.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g),
      (match) => match[0]
    );
  }

  function sharedEnglishEvidence(source, output, contract = null) {
    const sourceWords = words(source, contract);
    const outputWords = words(output, contract).map((word) => word.toLowerCase());
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
    const sourceProseWordCount = words(source, contract).filter(
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
      const shared = sharedEnglishEvidence(source, output, contract);
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
          ? {
              status: 'safe',
              codes: structureValidation.droppedWrappers?.length
                ? ['structure.emphasis_dropped']
                : [],
            }
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
    if (attempt === 2 && code === 'quality.target_language_missing') {
      return decision(
        'reject',
        null,
        code,
        'wrong_target_language_rejected'
      );
    }
    return attempt === 1
      ? decision('retry', 'quality', code, 'repairing_quality')
      : decision(
          'apply_with_warning',
          null,
          code,
          'partial_translation_applied'
        );
  }

  async function execute(records, settings, request) {
    async function requestAndValidate(batch) {
      const modelRecords = batch.map((record) => ({
        id: record.id,
        template: record.template,
        atoms: record.atoms,
        repair: record.repair || null,
      }));
      const output = await request({
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        instructions: buildBlockInstructions(settings),
        input: JSON.stringify({ records: modelRecords }),
        textFormat: buildBlockResponseFormat(batch.length),
        maxOutputTokens: getBlockBatchMaxOutputTokens(
          batch.reduce((sum, record) => sum + codec.getRecordCost(record), 0)
        ),
      });
      return validateBlockResponse(output, batch, {
        targetLanguage: settings.targetLanguage,
      }).records;
    }

    const initial = await requestAndValidate(records);
    const terminalById = new Map();
    const initialById = new Map(initial.map((result) => [result.id, result]));
    const repairs = [];
    for (const result of initial) {
      const decision = decideBlockDisposition(result, 1);
      if (decision.disposition === 'retry') {
        const source = records.find((record) => record.id === result.id);
        repairs.push({
          ...source,
          repair: { attempt: 1, previousErrorCode: decision.terminalCode },
        });
      } else {
        terminalById.set(result.id, {
          result,
          decision,
          attemptCount: 1,
          timeline: [{
            stage: 'initial_validation',
            disposition: decision.disposition,
            codes: [decision.terminalCode].filter(Boolean),
          }],
        });
      }
    }
    if (repairs.length) {
      try {
        const repaired = await requestAndValidate(repairs);
        for (const result of repaired) {
          const initialResult = initialById.get(result.id);
          const initialDecision = decideBlockDisposition(initialResult, 1);
          const decision = decideBlockDisposition(result, 2);
          terminalById.set(result.id, {
            result,
            decision,
            attemptCount: 2,
            timeline: [
              { stage: 'initial_validation', disposition: 'retry', codes: [initialDecision.terminalCode].filter(Boolean) },
              { stage: 'repair_validation', disposition: decision.disposition, codes: [decision.terminalCode].filter(Boolean) },
            ],
          });
        }
      } catch (error) {
        const repairCode = String(error?.code || '').startsWith('protocol.')
          ? error.code
          : 'runtime.repair_request_failed';
        for (const repair of repairs) {
          const initialResult = initialById.get(repair.id);
          const initialDecision = decideBlockDisposition(initialResult, 1);
          terminalById.set(repair.id, {
            result: initialResult,
            decision: {
              disposition: 'reject',
              terminalCode: repairCode,
              messageKey: 'repair_request_failed',
            },
            attemptCount: 2,
            timeline: [
              { stage: 'initial_validation', disposition: 'retry', codes: [initialDecision.terminalCode].filter(Boolean) },
              { stage: 'repair_validation', disposition: 'reject', codes: [repairCode] },
            ],
          });
        }
      }
    }
    const results = records.map((record) => {
      const terminal = terminalById.get(record.id);
      const apply = terminal.decision.disposition !== 'reject';
      return {
        id: record.id,
        disposition: terminal.decision.disposition,
        ...(apply ? { template: terminal.result.template } : {}),
        terminalCode: terminal.decision.terminalCode,
        messageKey: terminal.decision.messageKey,
        attemptCount: terminal.attemptCount,
        diagnostic: {
          structure: terminal.result.structure,
          quality: terminal.result.quality,
          timeline: terminal.timeline,
        },
      };
    });
    return results;
  }

  const api = { execute };
  globalScope.ChromeAiTranslatorInlineModelExecution = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
