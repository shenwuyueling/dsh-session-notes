/**
 * session-notes — host half.
 *
 * This plugin's feature is entirely browser-side (the note panel plus its
 * localStorage bookkeeping), so the host half is deliberately inert: it claims
 * the loader row and nothing else. No service is registered, no file is
 * touched, and no profile configuration is modified.
 */
export const name = 'session-notes'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Intentionally empty. The browser half is mounted by the official client
  // module service from `dsh.client` in package.json.
  try {
    ctx?.logger?.debug?.(() => '[dsh-session-notes] host half idle')
  } catch {
    /* logging must never affect activation */
  }
}
