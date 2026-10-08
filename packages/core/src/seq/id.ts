/**
 * Short unique ids for documents, features and primers.
 * Not cryptographic; deliberately avoids `crypto.randomUUID`, which is missing in some
 * non-secure webview contexts.
 */
let counter = 0;
const sessionPrefix = Math.floor(Math.random() * 36 ** 4)
  .toString(36)
  .padStart(4, '0');

export function newId(prefix = 'id'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${sessionPrefix}${counter.toString(36)}`;
}
