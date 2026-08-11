const assert = require('node:assert/strict');
const controls = require('../extension/inline-translation-controls.js');

exports.name = 'inline translation controls';
exports.tests = [
  {
    name: 'offers only starting until Inline Translation has run',
    fn() {
      const idle = controls.getInlineTranslationControlAvailability('original');

      assert.equal(idle.canStart, true);
      assert.equal(idle.canStop, false);
      assert.equal(idle.canRestore, false);

      // A home that has not heard anything yet asks the same question of nothing.
      assert.deepEqual(
        controls.getInlineTranslationControlAvailability(),
        idle
      );
    },
  },
  {
    name: 'offers stopping only while a run is under way',
    fn() {
      assert.equal(
        controls.getInlineTranslationControlAvailability('active').canStop,
        true
      );
      for (const status of ['original', 'translating', 'translated', 'stopped']) {
        assert.equal(
          controls.getInlineTranslationControlAvailability(status).canStop,
          false,
          status
        );
      }
    },
  },
  {
    name: 'offers restoring while translated text is still on the page',
    fn() {
      // Restoring outlasts the run that put the text there: stopping and finishing both
      // leave something to put back.
      for (const status of ['active', 'translated', 'stopped']) {
        assert.equal(
          controls.getInlineTranslationControlAvailability(status).canRestore,
          true,
          status
        );
      }
      for (const status of ['original', 'translating']) {
        assert.equal(
          controls.getInlineTranslationControlAvailability(status).canRestore,
          false,
          status
        );
      }
    },
  },
  {
    name: 'refuses to start a translation that is already in flight',
    fn() {
      assert.equal(
        controls.getInlineTranslationControlAvailability('translating').canStart,
        false
      );
    },
  },
  {
    name: 'names the content script step each control is carried out by',
    fn() {
      assert.equal(
        controls.getInlineTranslationControlStep(
          controls.INLINE_TRANSLATION_CONTROLS.START
        ),
        'startInlineTranslation'
      );
      assert.equal(
        controls.getInlineTranslationControlStep(
          controls.INLINE_TRANSLATION_CONTROLS.STOP
        ),
        'stopInlineTranslation'
      );
      assert.equal(
        controls.getInlineTranslationControlStep(
          controls.INLINE_TRANSLATION_CONTROLS.RESTORE
        ),
        'restoreInlineOriginal'
      );
      assert.equal(controls.getInlineTranslationControlStep('translateTab'), '');
      assert.equal(controls.getInlineTranslationControlStep(), '');
    },
  },
];
