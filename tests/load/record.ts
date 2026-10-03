import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Where `npm run load` writes what it measured: tests/load/last-run.json (git-ignored), one list of
// results per test file ("section"), so a run of one file never wipes another's. Vitest does not show
// a test's console output under the emulators, so a file is what to read.

const FILE = fileURLToPath(new URL('./last-run.json', import.meta.url));
type Results = Record<string, Record<string, unknown>[]>;

function read(): Results {
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    // A file from before results had sections is a list; it is not worth keeping.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Results)
      : {};
  } catch {
    return {};
  }
}

function write(all: Results) {
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
}

/** A recorder for one test file's section: `reset` at the start, `record` after each measurement. */
export function sectionRecorder(section: string) {
  return {
    reset() {
      const all = read();
      all[section] = [];
      write(all);
    },
    record(result: Record<string, unknown>) {
      const all = read();
      all[section] = [...(all[section] ?? []), result];
      write(all);
    },
  };
}
