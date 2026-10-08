const assert = require('node:assert/strict');
const { createInlineViewport } = require('../extension/inline-viewport');
const { createInlineTranslationSession } = require('../extension/inline-translation-session');
const { createTestDocument } = require('./inline-block.test');
const { createViewportProbe } = require('./viewport-harness');

exports.name = 'inline viewport clipping regression';
exports.tests = [{
  // Regression: ISSUE-001 - preserve positioned prose escaping an overflow clip.
  // Found by /qa on 2026-10-08
  // Report: .gstack/qa-reports/run-20261008T021900Z/qa-report-github.com-2026-10-08.md
  name: 'collects escaped positioned prose while keeping clipped siblings excluded',
  fn() {
    for (const position of ['fixed', 'absolute']) {
      for (const contained of [false, true]) {
        const { document, element, text } = createTestDocument();
        const prose = element('p', text('Visible positioned prose.'));
        prose.computedStyle = { position };
        const hidden = element('p', text('Clipped ordinary prose.'));
        const clip = element('div', prose, hidden);
        clip.computedStyle = { overflow: 'hidden' };
        clip.rect = { top: 20, bottom: 21, left: 10, right: 11, width: 1, height: 1 };
        prose.offsetParent = contained ? clip : position === 'fixed' ? null : document.body;
        document.body.appendChild(clip);
        document.documentElement = { clientWidth: 500, clientHeight: 300 };
        document.createRange = () => { throw new Error('range unavailable'); };
        const session = createInlineTranslationSession();
        session.begin({});
        const admitted = [];
        const probe = createViewportProbe({
          operationId: session.operationId, status: 'active',
          isCurrent: session.isCurrent, resetQueue: session.resetQueue,
          admit(block) { admitted.push(block); return session.admit(block); },
        }, {
          document, HTMLElement: clip.constructor,
          window: { innerWidth: 500, innerHeight: 300,
            getComputedStyle: document.defaultView.getComputedStyle,
            addEventListener() {}, removeEventListener() {} },
          MutationObserver: class { observe() {} disconnect() {} },
        }, createInlineViewport);
        try {
          probe.start(document.body);
          assert.deepEqual(admitted, contained ? [] : [prose], `${position}, contained=${contained}`);
          assert.equal(session.progress().counts.failed, 0);
        } finally { probe.stop(); }
      }
    }
  },
}];
