import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

export async function readStopBlockContract(page) {
  const codec = ['placeholder-tokens.js', 'inline-block.js']
    .map(file => readFileSync(join(EXTENSION_DIR, file), 'utf8')).join('\n');
  return page.evaluate(`${codec}
    (() => {
      const block = document.getElementById('stoppedRunBlock');
      if (!block) return null;
      const hidden = block.hidden;
      block.hidden = false;
      try {
        const serialized = globalThis.ChromeAiTranslatorInlineBlock.serializeBlock(block);
        return serialized.ok ? { template: serialized.template, atoms: serialized.atoms, contract: serialized.contract } : null;
      } finally { block.hidden = hidden; }
    })()`);
}
