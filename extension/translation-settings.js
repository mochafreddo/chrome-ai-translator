(function initTranslationSettings(globalScope) {
  const TONE_INSTRUCTIONS = {
    technical: 'Use a clear, technical tone suitable for docs.',
    natural: 'Use natural, fluent tone.',
    formal: 'Use formal and polite tone.',
  };

  function getToneInstruction(tone) {
    return TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.technical;
  }

  function getTargetLanguageCode(targetLanguage) {
    const normalized = String(targetLanguage || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
    if (!normalized) return '';
    if (
      /^en(?:[-_][a-z0-9]+)*$/i.test(normalized) ||
      /^english\b/i.test(normalized) ||
      /^(?:american|british|us|uk|australian|canadian|new zealand) english\b/i.test(
        normalized
      ) ||
      /^(?:(?:미국|영국|호주|캐나다|뉴질랜드)(?:식)?\s*)?(?:영어|영문)(?:\s|$|\()/.test(
        normalized
      )
    ) {
      return 'en';
    }
    if (
      /^ko(?:[-_][a-z0-9]+)*$/i.test(normalized) ||
      /^(?:korean|south korean|north korean)\b/i.test(normalized) ||
      /^(?:한국어|한국말|조선어|조선말)(?:\s|$|\()/.test(normalized)
    ) {
      return 'ko';
    }
    return '';
  }

  const api = { getToneInstruction, getTargetLanguageCode };
  globalScope.ChromeAiTranslatorTranslationSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
