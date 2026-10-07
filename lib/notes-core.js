/**
 * Consolidated into `lib/client.js`.
 *
 * The DSH module loader resolves module ids from its boot graph, so a relative
 * `require('./notes-core.js')` from the client bundle has no resolver. To keep
 * the plugin buildless — one file, installable by copying or linking — the pure
 * storage/session/geometry layer lives inside `lib/client.js` and is exposed
 * there as `exports.__core`.
 *
 * `test/notes-core.test.mjs` loads `lib/client.js` through a stubbed
 * `window.__ModuleLoader__` and exercises `__core`, so the tests still cover
 * exactly the bytes that ship. This file is intentionally inert.
 */
export const note = 'see lib/client.js'
