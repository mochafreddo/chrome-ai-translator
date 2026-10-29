export function parseBrowserCheckMode(args) {
  if (args.length === 0) return { fixture: true, reported: true };
  if (args.length === 1 && args[0] === '--fixture-only') return { fixture: true, reported: false };
  if (args.length === 1 && args[0] === '--reported-only') return { fixture: false, reported: true };
  throw new Error('Usage: [--fixture-only | --reported-only]');
}
