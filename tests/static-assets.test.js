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
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/full-page-markdown\.js/
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/page-access\.js/
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/default-model\.js/
      );
    },
  },
  {
    name: 'loads the full-page Markdown codec before the content script',
    fn() {
      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      const filesMatch = backgroundJs.match(
        /function getInlineContentScriptFiles\(\) \{\s*return \[([^\]]+)\]/s
      );

      assert.equal(
        fs.existsSync(
          path.join(__dirname, '..', 'extension', 'full-page-markdown.js')
        ),
        true
      );
      assert.ok(filesMatch);
      assert.notEqual(filesMatch[1].indexOf("'full-page-markdown.js'"), -1);
      assert.equal(
        filesMatch[1].indexOf("'full-page-markdown.js'") <
          filesMatch[1].indexOf("'content.js'"),
        true
      );
    },
  },
];
