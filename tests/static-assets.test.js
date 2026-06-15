const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.name = 'static assets';
exports.tests = [
  {
    name: 'ships the stylesheet referenced by extension HTML',
    fn() {
      assert.equal(
        fs.existsSync(path.join(__dirname, '..', 'extension', 'styles.css')),
        true
      );
    },
  },
];
