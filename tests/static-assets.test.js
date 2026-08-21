const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
  {
    name: 'keeps extension controls usable on narrow panels',
    fn() {
      const css = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'styles.css'),
        'utf8'
      );

      assert.match(css, /min-height:\s*4[04]px/);
      assert.match(css, /@media\s*\(max-width:\s*460px\)/);
      assert.match(css, /grid-template-columns:\s*1fr/);
    },
  },
  {
    name: 'sets each interactive control family to touch-sized height',
    fn() {
      const css = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'styles.css'),
        'utf8'
      );
      const contentJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'content.js'),
        'utf8'
      );

      assert.match(css, /input,\nselect\s*\{[^}]*min-height:\s*44px/s);
      assert.match(css, /\.btn\s*\{[^}]*min-height:\s*44px/s);
      assert.match(css, /\.tab\s*\{[^}]*min-height:\s*44px/s);
      assert.match(contentJs, /button\s*\{[^}]*min-height:\s*44px/s);
    },
  },
  {
    name: 'ships a close control on the Floating Translate Button',
    fn() {
      // Closing is unit-tested on the state helpers, but nothing there would notice if the
      // control the reader reaches for stopped being rendered.
      const contentJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'content.js'),
        'utf8'
      );

      assert.match(contentJs, /<button[^>]*data-action="close"[^>]*>[^<]+</);
    },
  },
  {
    name: 'ships an Inline translation section of its own in the side panel',
    fn() {
      // The view model decides what the section says, but nothing there would notice if
      // the controls the reader reaches for stopped being rendered — or if the section
      // were folded into the Side Panel Translation row, which translates something else,
      // puts it somewhere else, and needs different permissions.
      const html = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'sidepanel.html'),
        'utf8'
      );

      assert.match(html, /<section id="inlineTranslation"[^>]*>/);
      assert.match(html, />\s*Inline translation\s*</);
      for (const id of ['btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']) {
        assert.match(html, new RegExp(`<button[^>]*id="${id}"`));
      }
      assert.match(html, /id="inlineStatus"[^>]*role="status"[^>]*aria-live="polite"/);
      assert.match(html, /id="inlineError"[^>]*role="alert"[^>]*hidden/);

      const inlineSection = html.slice(html.indexOf('id="inlineTranslation"'));
      assert.equal(inlineSection.includes('id="btnTranslate"'), false);
      assert.equal(inlineSection.includes('id="viewMode"'), false);
    },
  },
  {
    name: 'loads the shared Inline Translation control rules into both of their homes',
    fn() {
      // The rules are only shared if both homes actually load them. The content script
      // reads them through the injected file list; the side panel through its own tag,
      // ahead of the script that calls them.
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const sidepanelHtml = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'sidepanel.html'),
        'utf8'
      );
      const filesMatch = backgroundJs.match(
        /function getInlineContentScriptFiles\(\) \{\s*return \[([^\]]+)\]/s
      );

      assert.equal(
        fs.existsSync(
          path.join(
            __dirname,
            '..',
            'extension',
            'inline-translation-controls.js'
          )
        ),
        true
      );
      assert.ok(filesMatch);
      assert.equal(
        filesMatch[1].indexOf("'inline-translation-controls.js'") <
          filesMatch[1].indexOf("'content.js'"),
        true
      );
      assert.equal(
        sidepanelHtml.indexOf('src="inline-translation-controls.js"') <
          sidepanelHtml.indexOf('src="sidepanel.js"'),
        true
      );
    },
  },
  {
    name: 'loads the one home of the default model into all four contexts that fall back to it',
    fn() {
      // A shared value is only shared where it is actually loaded: the worker imports it,
      // the content script gets it from the injected file list ahead of content.js, and
      // both extension pages take their own tag ahead of the script that reads it.
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const filesMatch = backgroundJs.match(
        /function getInlineContentScriptFiles\(\) \{\s*return \[([^\]]+)\]/s
      );

      assert.equal(
        fs.existsSync(path.join(__dirname, '..', 'extension', 'default-model.js')),
        true
      );
      assert.match(backgroundJs, /importScripts\('default-model\.js'\)/);
      assert.ok(filesMatch);
      assert.equal(
        filesMatch[1].indexOf("'default-model.js'") <
          filesMatch[1].indexOf("'content.js'"),
        true
      );

      for (const [page, pageScript] of [
        ['options.html', 'options.js'],
        ['sidepanel.html', 'sidepanel.js'],
      ]) {
        const html = fs.readFileSync(
          path.join(__dirname, '..', 'extension', page),
          'utf8'
        );

        assert.notEqual(html.indexOf('src="default-model.js"'), -1);
        assert.equal(
          html.indexOf('src="default-model.js"') <
            html.indexOf(`src="${pageScript}"`),
          true
        );
      }
    },
  },
  {
    name: 'leaves both model placeholders to the shared default',
    fn() {
      // A placeholder still naming the model the extension defaulted to yesterday is the
      // same quiet lie as a stale fallback, so the markup carries no model name of its own.
      for (const [page, pageScript] of [
        ['options.html', 'options.js'],
        ['sidepanel.html', 'sidepanel.js'],
      ]) {
        const html = fs.readFileSync(
          path.join(__dirname, '..', 'extension', page),
          'utf8'
        );
        const input = html.match(/<input id="model"[^>]*>/);

        assert.ok(input);
        assert.equal(/placeholder=/.test(input[0]), false);
        assert.match(
          fs.readFileSync(
            path.join(__dirname, '..', 'extension', pageScript),
            'utf8'
          ),
          /elModel\.placeholder = DEFAULT_MODEL/
        );
      }
    },
  },
  {
    name: 'loads the shared missing-access wording into both places that say it',
    fn() {
      // The panel and the background worker only agree on what to tell the reader about a
      // tab out of reach if both actually load the words. The worker imports them; the side
      // panel takes its own tag, ahead of the script that reads them.
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const sidepanelHtml = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'sidepanel.html'),
        'utf8'
      );

      assert.equal(
        fs.existsSync(path.join(__dirname, '..', 'extension', 'page-access.js')),
        true
      );
      assert.match(backgroundJs, /importScripts\('page-access\.js'\)/);
      assert.notEqual(sidepanelHtml.indexOf('src="page-access.js"'), -1);
      assert.equal(
        sidepanelHtml.indexOf('src="page-access.js"') <
          sidepanelHtml.indexOf('src="sidepanel.js"'),
        true
      );
    },
  },
  {
    name: 'keeps Inline Translation progress and errors out of the Floating Translate Button',
    fn() {
      // Single-sourced in the panel: the button carries the controls and nothing else.
      const contentJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'content.js'),
        'utf8'
      );

      assert.equal(/data-role="message"/.test(contentJs), false);
    },
  },
  {
    name: 'ships the three exclusive Button Visibility choices on the options page',
    fn() {
      // The choice is unit-tested on the options helpers, but nothing there would notice if
      // one of the three controls the reader picks from stopped being rendered.
      const optionsHtml = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'options.html'),
        'utf8'
      );
      const choices = Array.from(
        optionsHtml.matchAll(
          /<input type="radio" name="buttonVisibility" value="([a-zA-Z]+)"/g
        )
      ).map((match) => match[1]);

      assert.deepEqual(choices, ['never', 'onInvocation', 'allPages']);
      assert.equal(optionsHtml.includes('inlineAutoShow'), false);
      assert.match(optionsHtml, /<script src="button-visibility\.js"><\/script>/);
    },
  },
  {
    name: 'keeps choice labels visually attached to their control',
    fn() {
      const optionsHtml = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'options.html'),
        'utf8'
      );
      const css = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'styles.css'),
        'utf8'
      );

      assert.match(
        optionsHtml,
        /<label class="choice-label">\s*<input type="radio"/
      );
      assert.match(css, /\.choice-label\s*\{[^}]*display:\s*flex/s);
      assert.match(
        css,
        /\.choice-label input\[type="radio"\]\s*\{[^}]*width:\s*44px/s
      );
    },
  },
  {
    name: 'keeps tracked files outside ignored paths',
    fn() {
      const repoRoot = path.join(__dirname, '..');
      const trackedFiles = execFileSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter((file) => file && fs.existsSync(path.join(repoRoot, file)));
      const ignoredTrackedFiles = trackedFiles.filter((file) => {
        try {
          execFileSync('git', ['check-ignore', '--no-index', '-q', file], {
            cwd: repoRoot,
          });
          return true;
        } catch {
          return false;
        }
      });

      assert.deepEqual(ignoredTrackedFiles, []);
    },
  },
  {
    name: 'checks semantic block codec syntax with extension scripts',
    fn() {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
      );

      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/inline-block\.js/
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/openai-response\.js/
      );
      for (const file of [
        'markdown-entries',
        'markdown-document',
        'markdown-rehydration',
        'translation-chunks',
      ]) {
        assert.match(
          packageJson.scripts['check:syntax'],
          new RegExp(`node --check extension/${file}\\.js`),
          file
        );
      }
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/page-access\.js/
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/default-model\.js/
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/placeholder-tokens\.js/
      );
    },
  },
  {
    name: 'loads every shared module ahead of the modules that read it as they load',
    fn() {
      // A module resolved at load time and listed after its dependency leaves the reader
      // holding null and failing on the first page it is asked about — in the worker or in the
      // page, whichever list is the one that was missed. Neither list is derived from the
      // directory, and a module both runtimes reach appears in both of them.
      //
      // Two shared modules are guarded here. The Placeholder Token contract is read by the
      // inline codec, which runs in both, and by Side Panel Translation's rehydration half,
      // which runs only in the worker. The Markdown entry module is read by the two halves of
      // Side Panel Translation's codec that render a span, which sit one on each side.
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const filesMatch = backgroundJs.match(
        /function getInlineContentScriptFiles\(\) \{\s*return \[([^\]]+)\]/s
      );
      assert.ok(filesMatch);

      const inWorker = (file) => backgroundJs.indexOf(`importScripts('${file}')`);
      const inPage = (file) => filesMatch[1].indexOf(`'${file}'`);
      const dependencies = [
        ['placeholder-tokens.js', 'inline-block.js', ['worker', 'page']],
        ['placeholder-tokens.js', 'markdown-rehydration.js', ['worker']],
        ['markdown-entries.js', 'markdown-rehydration.js', ['worker']],
        ['markdown-entries.js', 'translation-chunks.js', ['worker']],
        ['markdown-entries.js', 'markdown-document.js', ['page']],
      ];

      for (const [shared, reader, runtimes] of dependencies) {
        assert.equal(
          fs.existsSync(path.join(__dirname, '..', 'extension', shared)),
          true,
          shared
        );
        for (const runtime of runtimes) {
          const position = runtime === 'worker' ? inWorker : inPage;
          assert.notEqual(position(reader), -1, `${runtime}: ${reader}`);
          assert.equal(
            position(shared) < position(reader),
            true,
            `${runtime}: ${shared} after ${reader}`
          );
        }
      }
    },
  },
  {
    name: 'declares the Inline Translation Shortcut the worker listens for',
    fn() {
      // The manifest's command key and the name the worker compares against are one
      // vocabulary with nothing linking them: a rename on either side alone leaves the
      // reader a shortcut Chrome offers and the worker ignores, and nothing reports it.
      // The key and its description also have to name the feature the shortcut starts —
      // the old name described the other one (ADR-0004).
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '..', 'extension', 'manifest.json'),
          'utf8'
        )
      );
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const { INLINE_TRANSLATION_SHORTCUT_COMMAND } = require('../extension/background.js');

      assert.equal(INLINE_TRANSLATION_SHORTCUT_COMMAND, 'translate-inline');
      assert.deepEqual(Object.keys(manifest.commands), [
        INLINE_TRANSLATION_SHORTCUT_COMMAND,
      ]);
      assert.match(
        manifest.commands[INLINE_TRANSLATION_SHORTCUT_COMMAND].description,
        /inline/i
      );
      // The constant carries nothing unless the command listener is what reads it.
      assert.match(
        backgroundJs,
        /onCommand\.addListener[\s\S]{0,200}INLINE_TRANSLATION_SHORTCUT_COMMAND/
      );
    },
  },
  {
    name: 'loads the Markdown document model codec before the content script',
    fn() {
      // The page runs one of the codec's three parts and is given nothing else from it: the
      // chunker and the rehydration half are the worker's, and listing either here would ship
      // the page code it never calls.
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const filesMatch = backgroundJs.match(
        /function getInlineContentScriptFiles\(\) \{\s*return \[([^\]]+)\]/s
      );

      assert.equal(
        fs.existsSync(
          path.join(__dirname, '..', 'extension', 'markdown-document.js')
        ),
        true
      );
      assert.ok(filesMatch);
      assert.notEqual(filesMatch[1].indexOf("'markdown-document.js'"), -1);
      assert.equal(
        filesMatch[1].indexOf("'markdown-document.js'") <
          filesMatch[1].indexOf("'content.js'"),
        true
      );
      for (const workerOnly of [
        'translation-chunks.js',
        'markdown-rehydration.js',
      ]) {
        assert.equal(filesMatch[1].indexOf(`'${workerOnly}'`), -1, workerOnly);
      }
    },
  },
];
