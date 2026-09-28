const assert = require('node:assert/strict');
const session = require('../extension/inline-translation-session.js');
const codec = require('../extension/inline-block.js');
const { createReasoningFixture } = require('./inline-block.test');
const { DEFAULT_MODEL } = require('../extension/default-model.js');

const KOREAN = {
  targetLanguage: 'Korean',
  tone: 'technical',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'none',
};
const JAPANESE = { ...KOREAN, targetLanguage: 'Japanese' };
const TRANSLATED_TEXT = 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.';

// A Semantic Block translated on a real block the way the page does it: serialized by the
// codec, patched with a translation that keeps every token, and stamped with the settings it
// was translated under.
function translateBlock(settings) {
  const fixture = createReasoningFixture();
  const { snapshot, contract } = fixture.serialized;
  const wrapper = contract.entries.find((entry) => entry.kind === 'wrapper');
  const atom = contract.entries.find((entry) => entry.kind === 'atom');
  const plan = codec.createPatchPlan(
    snapshot,
    `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`
  );
  assert.equal(codec.applyPatchPlan(snapshot, plan).ok, true);
  assert.equal(fixture.block.textContent, TRANSLATED_TEXT);
  const record = {
    state: 'translated',
    snapshot,
    translationSettingsSignature: session.getSettingsSignature(settings),
  };
  return { ...fixture, originalText: 'Reasoning models like GPT-5.5 use internal reasoning tokens.', record };
}

exports.name = 'inline translation session';
exports.tests = [
  {
    name: 'keeps the Session Budget across stop, Start and Original text',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      visit.charge(1200);
      visit.stop();
      assert.equal(visit.spent, 1200);
      visit.begin(KOREAN);
      visit.charge(300);
      visit.restore();
      assert.equal(visit.spent, 1500);
      visit.begin(JAPANESE);
      assert.equal(visit.spent, 1500);

      // Only a new page visit starts counting again.
      assert.equal(session.createInlineTranslationSession().spent, 0);
    },
  },
  {
    name: 'advances the operation id on begin, stop and restore',
    fn() {
      const visit = session.createInlineTranslationSession();
      assert.equal(visit.status, 'original');
      const initial = visit.operationId;

      const { operationId: first } = visit.begin(KOREAN);
      assert.equal(first > initial, true);
      assert.equal(visit.operationId, first);
      assert.equal(visit.status, 'active');

      const stopped = visit.stop();
      assert.equal(stopped > first, true);
      assert.equal(visit.operationId, stopped);
      assert.equal(visit.status, 'stopped');
      // A second Stop has no operation left to end.
      assert.equal(visit.stop(), stopped);

      const { operationId: second } = visit.begin(KOREAN);
      assert.equal(second > stopped, true);

      const restored = visit.restore();
      assert.equal(restored > second, true);
      assert.equal(visit.operationId, restored);
      assert.equal(visit.status, 'original');
    },
  },
  {
    name: 'carries translated blocks into the next operation under unchanged settings',
    fn() {
      const visit = session.createInlineTranslationSession();
      const { translationCache: firstCache } = visit.begin(KOREAN);
      const { block, record } = translateBlock(KOREAN);
      visit.stop([record]);

      // The API key is not a translation setting, so it does not change what carries over.
      const { carriedRecords, translationCache } = visit.begin({ ...KOREAN, apiKey: 'other' });

      assert.deepEqual(carriedRecords, [record]);
      assert.equal(translationCache, firstCache);
      assert.equal(record.state, 'translated');
      assert.equal(block.textContent, TRANSLATED_TEXT);
    },
  },
  {
    name: 'restores carried blocks when the settings change',
    fn() {
      const visit = session.createInlineTranslationSession();
      const { translationCache: koreanCache } = visit.begin(KOREAN);
      const { block, strong, link, originalText, record } = translateBlock(KOREAN);
      visit.stop([record]);

      const { carriedRecords, translationCache } = visit.begin(JAPANESE);

      assert.deepEqual(carriedRecords, []);
      assert.notEqual(translationCache, koreanCache);
      assert.equal(record.state, 'original');
      assert.equal(block.textContent, originalText);
      assert.equal(block.childNodes[0], strong);
      assert.equal(block.childNodes[2], link);
    },
  },
  {
    name: 'restores through Original text every block the visit translated',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const earlier = translateBlock(KOREAN);
      visit.stop([earlier.record]);
      visit.begin(KOREAN);
      const current = translateBlock(KOREAN);
      const queued = { state: 'queued' };

      // The current operation hands over only its own records; the earlier one's block is
      // the session's to remember.
      visit.restore([current.record, queued]);

      for (const { block, originalText, record } of [earlier, current]) {
        assert.equal(block.textContent, originalText);
        assert.equal(record.state, 'original');
      }
      assert.equal(queued.state, 'original');

      // Nothing restored is carried into the next operation.
      assert.deepEqual(visit.begin(KOREAN).carriedRecords, []);
    },
  },
  {
    name: 'keeps one translation cache bucket per translation settings',
    fn() {
      const visit = session.createInlineTranslationSession();
      const bucket = (settings) => visit.begin(settings).translationCache;
      const korean = bucket({ ...KOREAN, apiKey: 'secret-one' });
      const variantSettings = [
        { ...KOREAN, targetLanguage: 'Japanese' },
        { ...KOREAN, tone: 'natural' },
        { ...KOREAN, model: 'gpt-5.4' },
        { ...KOREAN, reasoningEffort: 'low' },
      ];
      const variants = variantSettings.map(bucket);

      assert.equal(bucket({ ...KOREAN, apiKey: 'secret-two' }), korean);
      assert.equal(bucket(KOREAN), korean);
      assert.equal(new Set([korean, ...variants]).size, 5);
      assert.deepEqual(variantSettings.map(bucket), variants);
    },
  },
  {
    name: 'builds inline translation settings snapshot without api key',
    fn() {
      assert.deepEqual(
        session.createSettingsSnapshot({
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          apiKey: 'sk-secret',
          viewMode: 'bilingual',
          chunkMaxChars: 24000,
        }),
        {
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
        }
      );
      assert.deepEqual(session.createSettingsSnapshot({}), {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: DEFAULT_MODEL,
        reasoningEffort: 'none',
      });
    },
  },
];
