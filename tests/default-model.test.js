const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_MODEL } = require('../extension/default-model.js');
const background = require('../extension/background.js');
const content = require('../extension/content.js');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');

// Matches the model name only where it stands alone, so a default of `gpt-5` is not
// reported as living inside a longer name like `gpt-5.4-mini` that merely starts with it.
function countStandaloneMentions(source, value) {
  const pattern = new RegExp(
    `(?<![\\w.-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`,
    'g'
  );
  return (source.match(pattern) || []).length;
}

exports.name = 'default model';
exports.tests = [
  {
    name: 'names a model',
    fn() {
      assert.equal(typeof DEFAULT_MODEL, 'string');
      assert.notEqual(DEFAULT_MODEL, '');
    },
  },
  {
    name: 'agrees with the settings the worker stores when the reader has chosen none',
    fn() {
      // The point of the shared value: changing it there has to change what the extension
      // actually defaults to, not merely what one more copy of the string says.
      assert.equal(
        background.mergeSettingsWithExisting({}, {}).model,
        DEFAULT_MODEL
      );
    },
  },
  {
    name: 'agrees with the settings the content script snapshots when none are supplied',
    fn() {
      assert.equal(
        content.createInlineTranslationSettingsSnapshot({}).model,
        DEFAULT_MODEL
      );
    },
  },
  {
    name: 'is written down in exactly one place',
    fn() {
      // Each fallback is only reached when a setting is absent, so a copy left behind after
      // a change disagrees with the rest without anything on the screen reporting it.
      // Nothing but a count of the homes catches that.
      const homes = fs
        .readdirSync(EXTENSION_DIR)
        .filter((file) => /\.(js|html|json)$/.test(file))
        .filter(
          (file) =>
            countStandaloneMentions(
              fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'),
              DEFAULT_MODEL
            ) > 0
        );

      assert.deepEqual(homes, ['default-model.js']);
      assert.equal(
        countStandaloneMentions(
          fs.readFileSync(path.join(EXTENSION_DIR, 'default-model.js'), 'utf8'),
          DEFAULT_MODEL
        ),
        1
      );
    },
  },
];
