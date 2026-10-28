// `node --test test/` hands this directory to the module loader as a single
// entry point on Node 24 (the test runner no longer expands directory
// arguments), so this file fans the directory back out into the real suites.
// The guard keeps it inert if a runner ever imports it as one more test file.
import { readdirSync } from 'node:fs';

if (import.meta.main) {
  const files = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  for (const file of files) await import(`./${file}`);
}
