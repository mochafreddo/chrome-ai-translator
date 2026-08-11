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
