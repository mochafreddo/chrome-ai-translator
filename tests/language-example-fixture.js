const source = 'Prefer active voice. Before: "The report was written by Maya." After: "Maya wrote the report."';
const template = '능동태를 쓰세요. 이전: "The report was written by Maya."(마야가 보고서를 작성했다.) 이후: "Maya wrote the report."(마야가 보고서를 작성했다.)';

function example(sourceText, outputText, original, meaning, outputStart = outputText.indexOf(original)) {
  const sourceStart = sourceText.indexOf(original);
  const meaningStart = outputText.indexOf(meaning, outputStart + original.length);
  return { source: original, meaning, sourceStart, sourceEnd: sourceStart + original.length,
    outputStart, outputEnd: outputStart + original.length, meaningStart, meaningEnd: meaningStart + meaning.length };
}

function activeVoiceFixture() {
  return { source, template, languageExamples: [
    example(source, template, 'The report was written by Maya.', '마야가 보고서를 작성했다.'),
    example(source, template, 'Maya wrote the report.', '마야가 보고서를 작성했다.'),
  ] };
}

module.exports = { activeVoiceFixture, example };
