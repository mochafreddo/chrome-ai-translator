(function initSidePanelTranslationExecution(globalScope) {
  const translationChunks = globalScope.ChromeAiTranslatorTranslationChunks ||
    (typeof module !== 'undefined' && module.exports ? require('./translation-chunks.js') : null);
  const markdownRehydration = globalScope.ChromeAiTranslatorMarkdownRehydration ||
    (typeof module !== 'undefined' && module.exports ? require('./markdown-rehydration.js') : null);
  const { getToneInstruction } = globalScope.ChromeAiTranslatorTranslationSettings ||
    (typeof module !== 'undefined' && module.exports ? require('./translation-settings.js') : {});

  const MAX_TOTAL_CHARS = 60000;
  const TOKEN_ERROR_CODES = new Set([
    'markdown.token_missing',
    'markdown.token_duplicate',
    'markdown.token_unknown',
    'markdown.token_nesting_invalid',
  ]);

  function buildInstructions({ targetLanguage, tone }, repair = null) {
    const instructions = [
      `Translate the user's input into ${targetLanguage}.`,
      getToneInstruction(tone),
      'Preserve Markdown structure (headings, lists, links).',
      'Do NOT translate code blocks fenced by ``` or inline code wrapped by backticks. Keep them exactly as-is.',
      'Text between ⟦ and ⟧ is a placeholder standing in for a link or for code. Copy every placeholder byte-for-byte, emit each one exactly once, and invent none: a placeholder the input does not contain is as wrong as a missing one.',
      'A LINK_OPEN placeholder must still come before the LINK_CLOSE placeholder carrying the same id, with the translated link text between the two. Reorder the words around the placeholders however the target language needs, but never translate, reword, split, or drop anything between ⟦ and ⟧.',
      'Do NOT add extra commentary. Output ONLY the translated Markdown.',
    ];
    if (repair) {
      instructions.push(
        `The previous answer to this same input was refused: ${repair.previousErrorCode}. Its placeholders were handled instead of carried.`,
        'Translate it again, and this time reproduce every ⟦…⟧ placeholder from the input exactly, once each, adding none.'
      );
    }
    return instructions.join('\n');
  }

  async function translateChunk(chunk, settings, request, repair = null) {
    try {
      const output = await request({
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        instructions: buildInstructions(settings, repair),
        input: chunk.template,
        maxOutputTokens: Math.min(128000, Math.max(8192, chunk.template.length)),
      });
      return markdownRehydration.validateAndRehydrateChunk(output, chunk);
    } catch (error) {
      // A Translation Chunk gets one recovery in all; the first failure owns it (ADR-0005).
      if ((Number(chunk.recoveryDepth) || 0) >= 1) throw error;
      if (TOKEN_ERROR_CODES.has(error?.code)) {
        return translateChunk({ ...chunk, recoveryDepth: 1 }, settings, request, {
          previousErrorCode: error.code,
        });
      }
      if (error?.code !== 'response.incomplete.max_output_tokens') throw error;
      const children = translationChunks.splitChunkForRecovery(chunk);
      const translated = [];
      for (const child of children) {
        translated.push(await translateChunk(child, settings, request));
      }
      return translated.join('\n\n');
    }
  }

  async function execute(extraction, settings, request, onProgress = () => {}) {
    if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) {
      throw new Error('Article extraction is malformed.');
    }
    const { title, url, langHint, contentMarkdown, translationDocument } = extraction;
    if (
      typeof title !== 'string' ||
      typeof url !== 'string' ||
      typeof langHint !== 'string' ||
      typeof contentMarkdown !== 'string'
    ) {
      throw new Error('Article extraction is malformed.');
    }
    if (!translationDocument || !Array.isArray(translationDocument.blocks)) {
      throw new Error('Article extraction did not include a translation document.');
    }
    if (contentMarkdown.length > MAX_TOTAL_CHARS) {
      throw new Error(
        `Full-page translation has too much text (${contentMarkdown.length}/${MAX_TOTAL_CHARS} characters)`
      );
    }
    const chunks = translationChunks.createTranslationChunks(
      translationDocument,
      settings.chunkMaxChars
    );
    onProgress({ progress: null });

    // Publish only the whole document: a late failure discards earlier billed answers (ADR-0006).
    const translated = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress({ progress: { current: i + 1, total: chunks.length } });
      translated.push((await translateChunk(chunks[i], settings, request)).trim());
    }
    return translated.join('\n\n');
  }

  const api = { execute };
  globalScope.ChromeAiTranslatorSidePanelTranslationExecution = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
