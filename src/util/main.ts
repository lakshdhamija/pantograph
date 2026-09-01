import { pathToFileURL } from 'node:url';

/**
 * `import.meta.url === "file://" + process.argv[1]` is the usual idiom and it is
 * wrong: import.meta.url is percent-encoded, so any path containing a space
 * (or any non-ASCII character) silently fails the comparison and the module
 * never runs as a script.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
