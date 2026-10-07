/**
 * session-notes — DSH client half.
 *
 * A hand-written single-file browser bundle in the shape the DSH module loader
 * expects (`window.__ModuleLoader__.load({ id, factory })`), so the plugin needs
 * no build step and no toolchain to ship or patch.
 *
 * The panel is mounted in its own fixed-position React root appended to
 * `document.body` (the same shape the whale/pet widgets use) and binds to the
 * Session the main view currently shows, derived from the session catalog's
 * `retainedBy.mainView` ownership count. Every note lives in this browser's
 * localStorage, keyed per session.
 *
 * Why the storage layer is embedded rather than imported: the module loader
 * resolves module ids from its boot graph, so a relative `require('./x.js')`
 * has no resolver. Keeping the whole plugin in one file is what makes the
 * hand-written, buildless install work at all. `exports.__core` exposes that
 * layer so the test suite can exercise exactly the bytes that ship.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-notes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDomClient = require('react-dom/client')
    const h = React.createElement
    const createRoot = ReactDomClient.createRoot

    // #region core (pure storage/session/geometry logic)

    const NAMESPACE = 'dsh-session-notes'
    const VERSION = 'v1'
    const INDEX_KEY = `${NAMESPACE}:${VERSION}:index`
    const PANEL_KEY = `${NAMESPACE}:${VERSION}:panel`
    const MANUAL_KEY = `${NAMESPACE}:${VERSION}:manualSession`
    const SESSION_PREFIX = `${NAMESPACE}:${VERSION}:session:`

    const MIN_W = 260
    const MIN_H = 160
    const MAX_W = 720
    const MAX_H = 640
    const VIEWPORT_GAP = 24

    const DEFAULT_PANEL = Object.freeze({
      pos: { x: null, y: null },
      size: { w: 320, h: 260 },
      collapsed: false,
    })

    /** @param {unknown} error */
    function isQuotaError(error) {
      if (error === null || typeof error !== 'object') return false
      const name = error.name
      const code = error.code
      return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || code === 22
        || code === 1014
    }

    /** Real stored byte size of a string, as UTF-8. */
    function byteSize(text) {
      const value = typeof text === 'string' ? text : String(text ?? '')
      try {
        if (typeof Blob === 'function') return new Blob([value]).size
      } catch {
        /* fall through to the approximation */
      }
      let bytes = 0
      for (const char of value) {
        const point = char.codePointAt(0) ?? 0
        if (point < 0x80) bytes += 1
        else if (point < 0x800) bytes += 2
        else if (point < 0x10000) bytes += 3
        else bytes += 4
      }
      return bytes
    }

    /** User-facing character count (code points, not UTF-16 units). */
    function charCount(text) {
      if (typeof text !== 'string' || text.length === 0) return 0
      return [...text].length
    }

    /** Parse JSON that may be absent, corrupt, or of the wrong shape. */
    function safeParse(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }

    /** Failure-tolerant wrapper around a Storage object. */
    class StorageAdapter {
      constructor(backing) {
        this.backing = backing ?? null
        this.quotaExceeded = false
      }

      get available() {
        return this.backing !== null
      }

      get(key) {
        if (this.backing === null) return null
        try {
          return this.backing.getItem(key)
        } catch {
          return null
        }
      }

      set(key, value) {
        if (this.backing === null) return false
        try {
          this.backing.setItem(key, value)
          this.quotaExceeded = false
          return true
        } catch (error) {
          if (isQuotaError(error)) this.quotaExceeded = true
          return false
        }
      }

      remove(key) {
        if (this.backing === null) return false
        try {
          this.backing.removeItem(key)
          return true
        } catch {
          return false
        }
      }

      keys() {
        if (this.backing === null) return []
        try {
          const out = []
          for (let index = 0; index < this.backing.length; index += 1) {
            const key = this.backing.key(index)
            if (key !== null) out.push(key)
          }
          return out
        } catch {
          return []
        }
      }

      sizeOf(key) {
        const value = this.get(key)
        return value === null ? 0 : byteSize(value)
      }
    }

    /** Build an adapter; resolves `localStorage` lazily and never throws. */
    function createStorage(backing) {
      let target = backing
      if (target === undefined || target === null) {
        try {
          target = typeof localStorage === 'undefined' ? null : localStorage
        } catch {
          target = null
        }
      }
      return new StorageAdapter(target)
    }

    function noteKey(sessionId) {
      return `${SESSION_PREFIX}${sessionId}`
    }

    /** Read one session's note. */
    function readNote(storage, sessionId) {
      const raw = storage.get(noteKey(sessionId))
      if (raw === null) return { text: '', updatedAt: 0, corrupt: false }
      const parsed = safeParse(raw)
      if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
        return { text: '', updatedAt: 0, corrupt: true }
      }
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0
      return { text, updatedAt, corrupt: typeof parsed.text !== 'string' }
    }

    function dedupe(values) {
      return [...new Set(values)]
    }

    /** Session ids the index remembers, validated against storage. */
    function listSessions(storage) {
      const parsed = safeParse(storage.get(INDEX_KEY))
      const rows = Array.isArray(parsed)
        ? parsed.filter((id) => typeof id === 'string' && id.length > 0)
        : []
      const live = []
      let repaired = false
      for (const id of dedupe(rows)) {
        if (storage.get(noteKey(id)) === null) {
          repaired = true
          continue
        }
        live.push(id)
      }
      if (repaired || live.length !== rows.length) writeIndex(storage, live)
      return live
    }

    function writeIndex(storage, ids) {
      if (ids.length === 0) storage.remove(INDEX_KEY)
      else storage.set(INDEX_KEY, JSON.stringify(ids))
    }

    function addToIndex(storage, sessionId) {
      const ids = listSessions(storage)
      if (ids.includes(sessionId)) return
      ids.push(sessionId)
      writeIndex(storage, ids)
    }

    function removeFromIndex(storage, sessionId) {
      writeIndex(storage, listSessions(storage).filter((id) => id !== sessionId))
    }

    /** Write one session's note and keep the index in sync. */
    function writeNote(storage, sessionId, text, now) {
      const stamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      const ok = storage.set(noteKey(sessionId), JSON.stringify({ text, updatedAt: stamp }))
      if (ok) addToIndex(storage, sessionId)
      return { ok, updatedAt: stamp }
    }

    /** Delete one session's note and drop it from the index. */
    function deleteNote(storage, sessionId) {
      const removed = storage.remove(noteKey(sessionId))
      removeFromIndex(storage, sessionId)
      return removed
    }

    function finiteOrNull(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    function finiteOrFallback(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /** Panel geometry preferences. */
    function readPanel(storage) {
      const parsed = safeParse(storage.get(PANEL_KEY))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { pos: { x: null, y: null }, size: { ...DEFAULT_PANEL.size }, collapsed: false }
      }
      return {
        pos: { x: finiteOrNull(parsed.pos?.x), y: finiteOrNull(parsed.pos?.y) },
        size: {
          w: finiteOrFallback(parsed.size?.w, DEFAULT_PANEL.size.w),
          h: finiteOrFallback(parsed.size?.h, DEFAULT_PANEL.size.h),
        },
        collapsed: parsed.collapsed === true,
      }
    }

    function writePanel(storage, panel) {
      return storage.set(PANEL_KEY, JSON.stringify({
        pos: { x: finiteOrNull(panel?.pos?.x), y: finiteOrNull(panel?.pos?.y) },
        size: {
          w: finiteOrFallback(panel?.size?.w, DEFAULT_PANEL.size.w),
          h: finiteOrFallback(panel?.size?.h, DEFAULT_PANEL.size.h),
        },
        collapsed: panel?.collapsed === true,
      }))
    }

    function clampNumber(value, min, max) {
      if (max < min) return min
      return Math.min(max, Math.max(min, value))
    }

    /** Clamp panel geometry into a viewport. */
    function clampGeometry(pos, size, viewport) {
      const vw = Math.max(1, Math.floor(finiteOrFallback(viewport?.width, 1280)))
      const vh = Math.max(1, Math.floor(finiteOrFallback(viewport?.height, 800)))
      const maxW = Math.max(MIN_W, Math.min(MAX_W, vw - VIEWPORT_GAP * 2))
      const maxH = Math.max(MIN_H, Math.min(MAX_H, vh - VIEWPORT_GAP * 2))
      const w = clampNumber(finiteOrFallback(size?.w, DEFAULT_PANEL.size.w), MIN_W, maxW)
      const height = clampNumber(finiteOrFallback(size?.h, DEFAULT_PANEL.size.h), MIN_H, maxH)
      const maxX = Math.max(VIEWPORT_GAP, vw - w - VIEWPORT_GAP)
      const maxY = Math.max(VIEWPORT_GAP, vh - height - VIEWPORT_GAP)
      return {
        pos: {
          x: clampNumber(finiteOrFallback(pos?.x, maxX), VIEWPORT_GAP, maxX),
          y: clampNumber(finiteOrFallback(pos?.y, maxY), VIEWPORT_GAP, maxY),
        },
        size: { w, h: height },
      }
    }

    /** Fresh-panel placement: bottom-right, clear of the widget corner. */
    function defaultPosition(size, viewport, inset) {
      const right = finiteOrFallback(inset?.right, 300)
      const bottom = finiteOrFallback(inset?.bottom, 96)
      const vw = Math.max(1, Math.floor(finiteOrFallback(viewport?.width, 1280)))
      const vh = Math.max(1, Math.floor(finiteOrFallback(viewport?.height, 800)))
      return clampGeometry(
        { x: vw - right - size.w, y: vh - bottom - size.h },
        size,
        { width: vw, height: vh },
      )
    }

    /**
     * Derive the session the main view currently shows.
     *
     * The client session controller keeps no global "current" selection; view
     * selection is published through the catalog's per-source ownership counts
     * (`SessionSummary.retainedBy.mainView`). When that marker is unavailable we
     * return undefined and let the caller fall back instead of guessing.
     */
    function mainViewSessionId(byId) {
      if (byId === undefined || byId === null || typeof byId !== 'object') return undefined
      for (const row of Object.values(byId)) {
        if (row === null || row === undefined) continue
        if (typeof row.id !== 'string' || row.id.length === 0) continue
        if ((row.retainedBy?.mainView ?? 0) > 0) return row.id
      }
      return undefined
    }

    /** Pick the bound session; a manual override only answers when auto cannot. */
    function resolveSession(byId, manual) {
      const auto = mainViewSessionId(byId)
      if (auto !== undefined) return { id: auto, source: 'mainView' }
      if (typeof manual === 'string' && manual.length > 0) return { id: manual, source: 'manual' }
      return { id: undefined, source: 'none' }
    }

    function readManualSession(storage) {
      const raw = storage.get(MANUAL_KEY)
      return typeof raw === 'string' && raw.length > 0 ? raw : null
    }

    function writeManualSession(storage, sessionId) {
      if (sessionId === null || sessionId === undefined || sessionId === '') {
        storage.remove(MANUAL_KEY)
        return true
      }
      return storage.set(MANUAL_KEY, String(sessionId))
    }

    /** Storage-usage report for the management sheet. */
    function measureNotes(storage, current, knownSessionIds) {
      const ids = listSessions(storage)
      const known = knownSessionIds === undefined || knownSessionIds === null
        ? null
        : new Set(knownSessionIds)

      let totalBytes = 0
      let corruption = 0
      const orphans = []
      for (const id of ids) {
        const raw = storage.get(noteKey(id)) ?? ''
        totalBytes += byteSize(raw)
        if (safeParse(raw) === undefined) corruption += 1
        if (known !== null && !known.has(id)) orphans.push(id)
      }

      let currentBytes = 0
      let currentChars = 0
      let currentUpdatedAt = 0
      const currentId = current?.id
      if (typeof currentId === 'string' && currentId.length > 0) {
        const raw = storage.get(noteKey(currentId))
        currentBytes = raw === null ? 0 : byteSize(raw)
        const note = readNote(storage, currentId)
        currentChars = charCount(note.text)
        currentUpdatedAt = note.updatedAt
      }

      return {
        sessionCount: ids.length,
        totalBytes,
        indexBytes: storage.sizeOf(INDEX_KEY),
        panelBytes: storage.sizeOf(PANEL_KEY),
        currentBytes,
        currentChars,
        currentUpdatedAt,
        orphans,
        corruption,
      }
    }

    /** Best-effort quota reading; never throws. */
    async function estimateQuota() {
      try {
        const manager = typeof navigator === 'undefined' ? undefined : navigator.storage
        if (manager === undefined || typeof manager.estimate !== 'function') return null
        const result = await manager.estimate()
        const usage = typeof result?.usage === 'number' ? result.usage : 0
        const quota = typeof result?.quota === 'number' ? result.quota : 0
        if (quota <= 0) return null
        return { usage, quota }
      } catch {
        return null
      }
    }

    /** Every note as `{ [sessionId]: { text, updatedAt } }`. */
    function exportAll(storage) {
      const out = {}
      for (const id of listSessions(storage)) {
        const note = readNote(storage, id)
        out[id] = { text: note.text, updatedAt: note.updatedAt }
      }
      return out
    }

    /** Merge an exported document; a newer `updatedAt` wins per session. */
    function importNotes(storage, document) {
      const rows = document !== null
        && typeof document === 'object'
        && !Array.isArray(document)
        && typeof document.notes === 'object'
        && document.notes !== null
        ? document.notes
        : document

      let imported = 0
      let skipped = 0
      let failed = 0
      if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) {
        return { imported, skipped, failed }
      }
      for (const [sessionId, raw] of Object.entries(rows)) {
        if (sessionId.length === 0 || raw === null || typeof raw !== 'object' || typeof raw.text !== 'string') {
          skipped += 1
          continue
        }
        const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
        const existing = readNote(storage, sessionId)
        const empty = existing.text === '' && existing.updatedAt === 0 && existing.corrupt === false
        if (empty || updatedAt > existing.updatedAt) {
          if (writeNote(storage, sessionId, raw.text, updatedAt).ok) imported += 1
          else failed += 1
        } else {
          skipped += 1
        }
      }
      return { imported, skipped, failed }
    }

    /** Build the export document for one session or for all of them. */
    function buildExportDocument(storage, onlySessionId) {
      const all = exportAll(storage)
      const scoped = typeof onlySessionId === 'string' && onlySessionId.length > 0
      const notes = scoped
        ? (onlySessionId in all ? { [onlySessionId]: all[onlySessionId] } : {})
        : all
      return {
        format: `${NAMESPACE}/${VERSION}`,
        exportedAt: new Date().toISOString(),
        scope: scoped ? 'session' : 'all',
        notes,
      }
    }

    /** Action 1/4: remove only the current session's note. */
    function clearCurrentNote(storage, sessionId) {
      return { removed: deleteNote(storage, sessionId) ? 1 : 0 }
    }

    /** Action 2/4: remove every note, keeping the panel geometry. */
    function clearAllNotes(storage) {
      const ids = listSessions(storage)
      let removed = 0
      for (const id of ids) {
        if (storage.remove(noteKey(id))) removed += 1
      }
      storage.remove(INDEX_KEY)
      return { removed }
    }

    /** Action 3/4: remove notes whose session no longer exists. */
    function clearOrphans(storage, knownSessionIds) {
      const known = new Set(knownSessionIds)
      const ids = listSessions(storage)
      let removed = 0
      for (const id of ids) {
        if (known.has(id)) continue
        if (storage.remove(noteKey(id))) removed += 1
      }
      writeIndex(storage, ids.filter((id) => known.has(id)))
      return { removed }
    }

    /** Action 4/4: reset panel geometry and collapse state only. */
    function resetPanelState(storage) {
      return { removed: storage.remove(PANEL_KEY) ? 1 : 0 }
    }

    /** Every key this plugin owns. */
    function ownedKeys(storage) {
      return storage.keys().filter((key) => key === INDEX_KEY
        || key === PANEL_KEY
        || key === MANUAL_KEY
        || key.startsWith(SESSION_PREFIX))
    }

    /** Full reset: notes, index, panel state, and the manual override. */
    function clearEverything(storage) {
      let removed = 0
      for (const key of ownedKeys(storage)) {
        if (storage.remove(key)) removed += 1
      }
      return { removed }
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(2)} MB`
    }

    /** `HH:MM` for a timestamp, or an empty string when there is none. */
    function formatClock(time) {
      if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return ''
      const date = new Date(time)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function shortSessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
      return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}…`
    }

    const core = {
      NAMESPACE,
      VERSION,
      INDEX_KEY,
      PANEL_KEY,
      MANUAL_KEY,
      SESSION_PREFIX,
      MIN_W,
      MIN_H,
      MAX_W,
      MAX_H,
      DEFAULT_PANEL,
      createStorage,
      StorageAdapter,
      byteSize,
      charCount,
      safeParse,
      readNote,
      writeNote,
      deleteNote,
      listSessions,
      readPanel,
      writePanel,
      clampGeometry,
      defaultPosition,
      mainViewSessionId,
      resolveSession,
      readManualSession,
      writeManualSession,
      measureNotes,
      estimateQuota,
      exportAll,
      importNotes,
      buildExportDocument,
      clearCurrentNote,
      clearAllNotes,
      clearOrphans,
      resetPanelState,
      ownedKeys,
      clearEverything,
      formatBytes,
      formatClock,
      shortSessionId,
    }

    // #endregion

    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const PLUGIN_ID = 'dsh-session-notes'
    const SAVE_DEBOUNCE_MS = 400
    const DEFAULT_INSET = { right: 300, bottom: 96 }
    const CSS_PREFIX = 'dsn'

    const storage = createStorage()

    // #region styles

    const CSS = `
.${CSS_PREFIX}-root {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  font: inherit;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  background: var(--dsw-alias-bg-layer-1, #1c1d21);
  border: 1px solid var(--dsw-alias-border-l2, #33363d);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  pointer-events: auto;
}
.${CSS_PREFIX}-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  background: var(--dsw-alias-bg-layer-2, #23252a);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2c2f36);
}
.${CSS_PREFIX}-header:active { cursor: grabbing; }
.${CSS_PREFIX}-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${CSS_PREFIX}-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.${CSS_PREFIX}-dot[data-state="none"] { background: var(--dsw-alias-state-idle-primary, #6b7280); }
.${CSS_PREFIX}-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #e5484d); }
.${CSS_PREFIX}-btn {
  flex: none;
  appearance: none;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 6px;
  cursor: pointer;
}
.${CSS_PREFIX}-btn:hover {
  color: var(--dsw-alias-label-primary, #e6e8eb);
  background: rgba(127, 127, 127, 0.14);
}
.${CSS_PREFIX}-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.${CSS_PREFIX}-btn:disabled { opacity: 0.5; cursor: default; }
.${CSS_PREFIX}-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.${CSS_PREFIX}-input {
  flex: 1 1 auto;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  resize: none;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  background: transparent;
  border: 0;
  outline: none;
  padding: 9px 11px;
  overflow: auto;
}
.${CSS_PREFIX}-input::placeholder { color: var(--dsw-alias-label-secondary, #9aa0a6); }
.${CSS_PREFIX}-input:disabled { color: var(--dsw-alias-label-secondary, #9aa0a6); }
.${CSS_PREFIX}-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  border-top: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-2, #23252a);
}
.${CSS_PREFIX}-footText {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${CSS_PREFIX}-footText[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CSS_PREFIX}-grip {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  touch-action: none;
  opacity: 0.55;
  background:
    linear-gradient(135deg, transparent 0 48%, currentColor 48% 62%, transparent 62% 70%,
      currentColor 70% 84%, transparent 84% 92%, currentColor 92% 100%);
}
.${CSS_PREFIX}-grip:hover { opacity: 1; }
.${CSS_PREFIX}-sheet {
  box-sizing: border-box;
  flex: none;
  max-height: min(60vh, 460px);
  overflow: auto;
  padding: 10px 11px 12px;
  font-size: 12px;
  line-height: 1.5;
  border-top: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  background: var(--dsw-alias-bg-layer-1, #1c1d21);
}
.${CSS_PREFIX}-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 8px;
}
.${CSS_PREFIX}-row:last-child { margin-bottom: 0; }
.${CSS_PREFIX}-label {
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
}
.${CSS_PREFIX}-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #23252a);
}
.${CSS_PREFIX}-stat { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.${CSS_PREFIX}-stat dt {
  margin: 0;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  white-space: nowrap;
}
.${CSS_PREFIX}-stat dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.${CSS_PREFIX}-text {
  box-sizing: border-box;
  flex: 1 1 160px;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  background: var(--dsw-alias-bg-base, #141519);
  border: 1px solid var(--dsw-alias-border-l1, #2c2f36);
  border-radius: 6px;
  padding: 5px 7px;
}
.${CSS_PREFIX}-action {
  appearance: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  background: var(--dsw-alias-bg-layer-2, #23252a);
  border: 1px solid var(--dsw-alias-border-l2, #33363d);
  border-radius: 6px;
  padding: 5px 9px;
  cursor: pointer;
}
.${CSS_PREFIX}-action:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${CSS_PREFIX}-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.${CSS_PREFIX}-action:disabled {
  opacity: 0.5;
  cursor: default;
  border-color: var(--dsw-alias-border-l1, #2c2f36);
}
.${CSS_PREFIX}-action[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CSS_PREFIX}-action[data-danger="true"]:hover { border-color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CSS_PREFIX}-hint {
  flex: 1 1 100%;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  font-size: 11px;
}
.${CSS_PREFIX}-note {
  flex: 1 1 100%;
  font-size: 11px;
  color: var(--dsw-alias-state-success-primary, #3fb950);
}
.${CSS_PREFIX}-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.${CSS_PREFIX}-divider {
  height: 1px;
  margin: 10px 0;
  background: var(--dsw-alias-border-l1, #2c2f36);
}
.${CSS_PREFIX}-hidden { display: none; }
`

    // #endregion

    // #region helpers

    /** Viewport size; safe outside a browser. */
    function viewportSize() {
      const width = typeof window === 'undefined' ? 1280 : window.innerWidth
      const height = typeof window === 'undefined' ? 800 : window.innerHeight
      return { width: width || 1280, height: height || 800 }
    }

    /** The session catalog's list service (`ctx.sessions.list`), or undefined. */
    function readSessionList(ctx) {
      try {
        const service = ctx.sessions
        if (service === undefined || service === null) return undefined
        const list = service.list
        return list === undefined || list === null ? undefined : list
      } catch {
        return undefined
      }
    }

    /** Run `read` against the live list service, or answer with `fallback`. */
    function withSessionList(ctx, read, fallback) {
      const list = readSessionList(ctx)
      if (list === undefined) return fallback
      try {
        return read(list)
      } catch (error) {
        console.error(`[${PLUGIN_ID}] session catalog read failed`, error)
        return fallback
      }
    }

    /** Every session id the catalog knows, or null when it is unreadable. */
    function knownSessionIds(ctx) {
      return withSessionList(ctx, (list) => {
        const byId = list.getSnapshot()?.byId
        if (byId === null || typeof byId !== 'object') return new Set()
        const ids = new Set()
        for (const row of Object.values(byId)) {
          if (row !== null && row !== undefined && typeof row.id === 'string') ids.add(row.id)
        }
        return ids
      }, null)
    }

    /** Trigger a browser download; returns whether the download was armed. */
    function downloadText(filename, text) {
      try {
        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        const revoke = () => {
          try {
            URL.revokeObjectURL(url)
          } catch {
            /* ignore */
          }
        }
        if (typeof setTimeout === 'function') setTimeout(revoke, 4000)
      } catch (error) {
        console.error(`[${PLUGIN_ID}] export failed`, error)
        return false
      }
      return true
    }

    /** `YYYYMMDD-HHMM` stamp for export filenames. */
    function stamp() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `-${pad(now.getHours())}${pad(now.getMinutes())}`
    }

    /**
     * Insert the stylesheet, preferring the documented client-half builtin and
     * degrading to a tagged `<style>` element when it is not composed in.
     */
    function insertStyles(css) {
      try {
        return styles.insert(css)
      } catch {
        /* fall through to the DOM path */
      }
      try {
        const tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.textContent = css
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            /* the shell may already have replaced <head> */
          }
        }
      } catch (error) {
        console.error(`[${PLUGIN_ID}] stylesheet injection failed`, error)
        return () => {}
      }
    }

    // #endregion

    // #region panel component

    /**
     * Resolve everything the panel needs from the plugin context. Every failure
     * degrades to a readable value instead of throwing into the shell's tree.
     *
     * The session service is re-read on every call rather than captured here:
     * a panel mounted while the service is still composing must recover once it
     * arrives, instead of staying permanently empty.
     */
    function createFace(ctx) {
      return {
        storage,
        storageAvailable: storage.available,
        subscribe(listener) {
          return withSessionList(ctx, (list) => list.subscribe(listener), () => {})
        },
        getById() {
          return withSessionList(ctx, (list) => list.getSnapshot()?.byId ?? null, null)
        },
        getKnownIds() {
          return knownSessionIds(ctx)
        },
        revision() {
          return withSessionList(ctx, (list) => list.getSnapshot()?.revision ?? 0, 0)
        },
      }
    }

    /** Title-bar button. */
    function headerButton(label, title, onClick, disabled) {
      return h('button', {
        type: 'button',
        className: `${CSS_PREFIX}-btn`,
        title,
        'aria-label': title,
        disabled: disabled === true,
        onClick,
      }, label)
    }

    /** One label/value row of the usage grid. */
    function stat(label, value) {
      return h('div', { className: `${CSS_PREFIX}-stat`, key: label }, [
        h('dt', { key: 'k' }, label),
        h('dd', { key: 'v' }, value),
      ])
    }

    /**
     * The draggable, resizable session note panel.
     *
     * Mounted in the frame-wide overlay so it survives session switches; the
     * bound session is read from the catalog rather than from a session-scoped
     * slot, so switching sessions never unmounts the panel or loses its state.
     */
    function SessionNotesPanel(props) {
      const face = props.face

      const [byId, setById] = useState(() => face.getById())
      const [manual, setManual] = useState(() => readManualSession(face.storage))
      const [manualDraft, setManualDraft] = useState(() => readManualSession(face.storage) ?? '')
      const [panel, setPanel] = useState(() => readPanel(face.storage))
      const [note, setNote] = useState({ text: '', updatedAt: 0 })
      const [savedAt, setSavedAt] = useState(0)
      const [saveError, setSaveError] = useState(false)
      const [manageOpen, setManageOpen] = useState(false)
      const [notice, setNotice] = useState(null)
      const [stats, setStats] = useState(null)
      const [quota, setQuota] = useState(null)
      const [rev, setRev] = useState(0)
      const [drag, setDrag] = useState(null)
      const [loadedSession, setLoadedSession] = useState(null)
      const [armed, setArmed] = useState(null)

      const timerRef = useRef(null)
      const pendingRef = useRef(null)
      const loadedRef = useRef(null)
      const panelRef = useRef(panel)
      const fileRef = useRef(null)

      panelRef.current = panel
      loadedRef.current = loadedSession

      const resolved = useMemo(() => resolveSession(byId, manual), [byId, manual, rev])
      const sessionId = resolved.id
      const sessionSource = resolved.source

      // #region persistence

      /** Write the in-flight edit immediately, if there is one. */
      const flush = useCallback(() => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        const pending = pendingRef.current
        if (pending === null) return
        pendingRef.current = null
        const result = writeNote(face.storage, pending.sessionId, pending.text, Date.now())
        setSaveError(result.ok !== true)
        if (result.ok === true) setSavedAt(result.updatedAt)
      }, [face])

      const scheduleSave = useCallback((targetSessionId, text) => {
        pendingRef.current = { sessionId: targetSessionId, text }
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
      }, [flush])

      // #endregion

      // #region catalog and cross-tab subscription

      useEffect(() => {
        let alive = true
        const refreshFromCatalog = () => {
          if (!alive) return
          setById(face.getById())
          setRev((value) => value + 1)
        }
        refreshFromCatalog()
        const off = face.subscribe(refreshFromCatalog)

        let offStorage = () => {}
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const onStorage = (event) => {
            const key = event === null || event === undefined ? undefined : event.key
            if (typeof key === 'string' && key.length > 0 && !key.startsWith(`${NAMESPACE}:`)) return
            const stored = readPanel(face.storage)
            panelRef.current = stored
            setPanel(stored)
            setRev((value) => value + 1)
          }
          window.addEventListener('storage', onStorage)
          offStorage = () => window.removeEventListener('storage', onStorage)
        }

        return () => {
          alive = false
          off()
          offStorage()
        }
      }, [face])

      // #endregion

      // #region load on session change

      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          // Keep any in-flight edit of the previous session instead of dropping it.
          flush()
          setLoadedSession(null)
          setNote({ text: '', updatedAt: 0 })
          return
        }
        if (loadedRef.current === sessionId) return
        // Switching sessions: persist what is still queued for the old one first.
        flush()
        const loaded = readNote(face.storage, sessionId)
        setNote({ text: loaded.text, updatedAt: loaded.updatedAt })
        setSavedAt(loaded.updatedAt)
        setSaveError(false)
        setLoadedSession(sessionId)
      }, [sessionId, flush, face])

      // Flush on unmount and on page hide so a pending keystroke is never lost.
      useEffect(() => {
        const onHide = () => flush()
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') flush()
        }
        if (typeof window !== 'undefined') window.addEventListener('beforeunload', onHide)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onHide)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
          flush()
        }
      }, [flush])

      // #endregion

      // #region geometry

      const parked = panel.pos.x === null || panel.pos.y === null

      const geometry = useMemo(() => {
        const viewport = viewportSize()
        const clamped = clampGeometry(
          {
            x: panel.pos.x === null ? Number.NaN : panel.pos.x,
            y: panel.pos.y === null ? Number.NaN : panel.pos.y,
          },
          panel.size,
          viewport,
        )
        return parked ? defaultPosition(clamped.size, viewport, DEFAULT_INSET) : clamped
      }, [panel, parked, rev])

      // Re-clamp whenever the window changes size.
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => {
          const current = panelRef.current
          const viewport = viewportSize()
          const settled = clampGeometry(
            {
              x: current.pos.x === null ? Number.NaN : current.pos.x,
              y: current.pos.y === null ? Number.NaN : current.pos.y,
            },
            current.size,
            viewport,
          )
          const merged = { ...panelRef.current, pos: settled.pos, size: settled.size }
          panelRef.current = merged
          setPanel(merged)
          writePanel(face.storage, merged)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [face])

      // #endregion

      // #region pointer gestures

      const startDrag = useCallback((event) => {
        if (event.button !== undefined && event.button !== 0) return
        if (event.target !== null && typeof event.target.closest === 'function'
          && event.target.closest('button') !== null) return
        const current = geometry
        event.preventDefault()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* pointer capture is best-effort */
        }
        setDrag({
          kind: 'move',
          pointerId: event.pointerId,
          originX: event.clientX,
          originY: event.clientY,
          startX: current.pos.x,
          startY: current.pos.y,
        })
      }, [geometry])

      const startResize = useCallback((event) => {
        if (event.button !== undefined && event.button !== 0) return
        const current = geometry
        event.preventDefault()
        event.stopPropagation()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* pointer capture is best-effort */
        }
        setDrag({
          kind: 'size',
          pointerId: event.pointerId,
          originX: event.clientX,
          originY: event.clientY,
          startW: current.size.w,
          startH: current.size.h,
          startX: current.pos.x,
          startY: current.pos.y,
        })
      }, [geometry])

      const onPointerMove = useCallback((event) => {
        if (drag === null || event.pointerId !== drag.pointerId) return
        const viewport = viewportSize()
        const dx = event.clientX - drag.originX
        const dy = event.clientY - drag.originY
        if (drag.kind === 'move') {
          const next = clampGeometry({ x: drag.startX + dx, y: drag.startY + dy }, panel.size, viewport)
          setPanel((previous) => ({ ...previous, pos: next.pos }))
          return
        }
        const next = clampGeometry(
          { x: drag.startX, y: drag.startY },
          { w: drag.startW + dx, h: drag.startH + dy },
          viewport,
        )
        setPanel((previous) => ({ ...previous, size: next.size, pos: next.pos }))
      }, [drag, panel.size])

      const endGesture = useCallback((event) => {
        if (drag === null) return
        if (event !== undefined && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return
        setDrag(null)
        writePanel(face.storage, panelRef.current)
      }, [drag, face])

      // #endregion

      // #region keyboard

      const toggleCollapsed = useCallback(() => {
        setPanel((previous) => {
          const merged = { ...previous, collapsed: !previous.collapsed }
          panelRef.current = merged
          writePanel(face.storage, merged)
          return merged
        })
      }, [face])

      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
          if (key === 'n' && (event.ctrlKey === true || event.metaKey === true) && event.shiftKey === true) {
            event.preventDefault()
            toggleCollapsed()
            return
          }
          if (key === 'escape') {
            if (drag !== null) {
              setDrag(null)
              const stored = readPanel(face.storage)
              panelRef.current = stored
              setPanel(stored)
              return
            }
            if (manageOpen) setManageOpen(false)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [drag, manageOpen, face, toggleCollapsed])

      // #endregion

      // #region management data

      const refreshStats = useCallback(() => {
        const known = face.getKnownIds()
        const next = measureNotes(
          face.storage,
          sessionId === undefined ? undefined : { id: sessionId },
          known === null ? undefined : known,
        )
        setStats(next)
        return next
      }, [face, sessionId])

      useEffect(() => {
        if (!manageOpen) return undefined
        let alive = true
        setNotice(null)
        refreshStats()
        estimateQuota().then((value) => {
          if (alive) setQuota(value)
        })
        return () => {
          alive = false
        }
      }, [manageOpen, refreshStats, rev, savedAt])

      // Disarm a pending confirmation after a few seconds of silence.
      useEffect(() => {
        if (armed === null) return undefined
        const timer = setTimeout(() => setArmed(null), 4000)
        return () => clearTimeout(timer)
      }, [armed])

      /** Two-step confirmation: the first activation only arms the action. */
      const confirmStep = useCallback((key, message, action) => {
        if (armed === key) {
          setArmed(null)
          action()
          return
        }
        setArmed(key)
        setNotice({ tone: 'error', text: message })
      }, [armed])

      // #endregion

      // #region management actions

      const runAction = useCallback((label, action) => {
        let message
        try {
          message = action()
        } catch (error) {
          console.error(`[${PLUGIN_ID}] ${label} failed`, error)
          setNotice({ tone: 'error', text: `${label}失败：${error?.message ?? error}` })
          refreshStats()
          setRev((value) => value + 1)
          return
        }
        setNotice({ tone: 'ok', text: `${label}：${message}` })
        refreshStats()
        setRev((value) => value + 1)
      }, [refreshStats])

      const onClearCurrent = useCallback(() => {
        if (sessionId === undefined) return
        confirmStep('clear-current', '再点一次「删除本条记事」即清除当前会话的记事。', () => {
          flush()
          const target = sessionId
          runAction('删除本条', () => `已删除（${clearCurrentNote(face.storage, target).removed} 条）`)
          setNote({ text: '', updatedAt: 0 })
          setSavedAt(0)
          setSaveError(false)
          setLoadedSession(target)
        })
      }, [sessionId, confirmStep, runAction, flush, face])

      const onClearAll = useCallback(() => {
        const count = stats === null ? listSessions(face.storage).length : stats.sessionCount
        if (count === 0) {
          setNotice({ tone: 'ok', text: '没有可清除的记事。' })
          return
        }
        confirmStep('clear-all', `再点一次即清除全部 ${count} 条会话记事（便签位置与尺寸保留）。`, () => {
          pendingRef.current = null
          runAction('清空全部记事', () => `已清除 ${clearAllNotes(face.storage).removed} 条`)
          setNote({ text: '', updatedAt: 0 })
          setSavedAt(0)
          setSaveError(false)
          setLoadedSession(null)
        })
      }, [stats, confirmStep, runAction, face])

      const onClearOrphans = useCallback(() => {
        const known = face.getKnownIds()
        if (known === null) {
          setNotice({ tone: 'error', text: '无法读取会话列表，已跳过孤儿清理。' })
          return
        }
        runAction('清理孤儿数据', () => `已清除 ${clearOrphans(face.storage, known).removed} 条`)
      }, [face, runAction])

      const onResetPanel = useCallback(() => {
        confirmStep('reset-panel', '再点一次即把便签位置、尺寸、折叠状态恢复默认（记事内容不受影响）。', () => {
          runAction('重置便签位置', () => {
            resetPanelState(face.storage)
            return '已恢复默认'
          })
          const stored = readPanel(face.storage)
          panelRef.current = stored
          setPanel(stored)
        })
      }, [confirmStep, runAction, face])

      const onResetAll = useCallback(() => {
        const count = stats === null ? 0 : stats.sessionCount
        confirmStep('reset-all', `再点一次即清除全部记事与便签状态（${count} 条记事不可恢复）。`, () => {
          pendingRef.current = null
          runAction('全部重置', () => `已清除 ${clearEverything(face.storage).removed} 个存储键`)
          const stored = readPanel(face.storage)
          panelRef.current = stored
          setPanel(stored)
          setNote({ text: '', updatedAt: 0 })
          setSavedAt(0)
          setSaveError(false)
          setManual(null)
          setManualDraft('')
          setLoadedSession(null)
        })
      }, [confirmStep, runAction, stats, face])

      const onExport = useCallback((onlyCurrent) => {
        flush()
        const target = onlyCurrent ? sessionId : undefined
        const document_ = buildExportDocument(face.storage, target)
        const scope = onlyCurrent ? (shortSessionId(target) || 'session') : 'all'
        const name = `session-notes-${scope}-${stamp()}.json`
        const ok = downloadText(name, JSON.stringify(document_, null, 2))
        setNotice(ok
          ? { tone: 'ok', text: `已导出 ${Object.keys(document_.notes).length} 条到 ${name}` }
          : { tone: 'error', text: '导出失败，详见控制台。' })
      }, [flush, sessionId, face])

      const onImportFile = useCallback((event) => {
        const input = event.target
        const file = input?.files?.[0]
        if (file === undefined || file === null) return
        const reader = new FileReader()
        reader.onerror = () => setNotice({ tone: 'error', text: '读取文件失败。' })
        reader.onload = () => {
          let parsed
          try {
            parsed = JSON.parse(String(reader.result))
          } catch {
            parsed = undefined
          }
          if (parsed === undefined) {
            setNotice({ tone: 'error', text: '导入失败：不是合法 JSON。' })
            return
          }
          const result = importNotes(face.storage, parsed)
          runAction('导入', () => `新增/更新 ${result.imported} 条、跳过 ${result.skipped} 条、失败 ${result.failed} 条`)
          if (sessionId !== undefined) {
            const reloaded = readNote(face.storage, sessionId)
            setNote({ text: reloaded.text, updatedAt: reloaded.updatedAt })
            setSavedAt(reloaded.updatedAt)
            setLoadedSession(sessionId)
          }
        }
        reader.readAsText(file)
        if (input !== null && input !== undefined) input.value = ''
      }, [face, runAction, sessionId])

      const onManualChange = useCallback((value) => {
        const next = String(value ?? '').trim()
        setManualDraft(next)
        setManual(next.length === 0 ? null : next)
        writeManualSession(face.storage, next.length === 0 ? null : next)
        setLoadedSession(null)
        setRev((value_) => value_ + 1)
      }, [face])

      // #endregion

      // #region derived view state

      const target = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : loadedSession
      const editable = face.storageAvailable && typeof target === 'string' && target.length > 0
      const lastSaved = Math.max(savedAt, note.updatedAt)

      const statusText = (() => {
        if (!face.storageAvailable) return '浏览器存储不可用（可能处于隐私模式）'
        if (sessionSource === 'none') return '未选中会话'
        if (sessionSource === 'manual') return `手动指定：${shortSessionId(target)}`
        return `会话 ${shortSessionId(target)}`
      })()

      const footRight = (() => {
        if (saveError) return `保存失败：存储已满（${charCount(note.text)} 字）`
        if (lastSaved > 0) return `${charCount(note.text)} 字 · 已保存 ${formatClock(lastSaved)}`
        return `${charCount(note.text)} 字 · 自动保存`
      })()

      // #endregion

      // #region management sheet

      /** The data-management sheet: usage, export/import, and the four clear actions. */
      const renderManageSheet = () => {
        const rows = []
        const usage = stats

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'label-usage' },
          h('span', { className: `${CSS_PREFIX}-label` }, '存储用量')))

        rows.push(h('dl', { className: `${CSS_PREFIX}-stats`, key: 'stats' }, [
          stat('会话记事', usage === null ? '…' : `${usage.sessionCount} 条`),
          stat('记事合计', usage === null ? '…' : formatBytes(usage.totalBytes)),
          stat('本条', usage === null ? '…' : (usage.currentBytes === 0 ? '空' : formatBytes(usage.currentBytes))),
          stat('浏览器配额', quota === null
            ? (usage === null ? '…' : '不可读')
            : `${formatBytes(quota.usage)} / ${formatBytes(quota.quota)}`),
          stat('孤儿数据', usage === null ? '…' : `${usage.orphans.length} 条`),
          stat('脏数据', usage === null ? '…' : `${usage.corruption} 条`),
        ]))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'label-data' },
          h('span', { className: `${CSS_PREFIX}-label` }, '数据')))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'actions-data' }, [
          h('button', {
            key: 'export-current',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            disabled: sessionId === undefined,
            onClick: () => onExport(true),
          }, '导出本条'),
          h('button', {
            key: 'export-all',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            disabled: usage === null || usage.sessionCount === 0,
            onClick: () => onExport(false),
          }, '导出全部'),
          h('button', {
            key: 'import',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            onClick: () => {
              if (fileRef.current !== null) fileRef.current.click()
            },
          }, '导入 JSON'),
          h('input', {
            key: 'file',
            ref: fileRef,
            type: 'file',
            accept: 'application/json,.json',
            className: `${CSS_PREFIX}-hidden`,
            onChange: onImportFile,
          }),
        ]))

        rows.push(h('div', { className: `${CSS_PREFIX}-divider`, key: 'divider-1' }))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'label-clear' },
          h('span', { className: `${CSS_PREFIX}-label` }, '清空缓存（按影响范围）')))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'actions-clear' }, [
          h('button', {
            key: 'clear-current',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            'data-danger': 'true',
            disabled: sessionId === undefined,
            onClick: onClearCurrent,
          }, armed === 'clear-current' ? '确认删除本条？' : '删除本条记事'),
          h('button', {
            key: 'clear-all',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            'data-danger': 'true',
            onClick: onClearAll,
          }, armed === 'clear-all' ? '确认清空全部？' : '清空全部记事'),
          h('button', {
            key: 'clear-orphans',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            disabled: usage === null || usage.orphans.length === 0,
            onClick: onClearOrphans,
          }, usage !== null && usage.orphans.length > 0
            ? `清理孤儿数据 (${usage.orphans.length})`
            : '清理孤儿数据'),
          h('button', {
            key: 'reset-panel',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            onClick: onResetPanel,
          }, armed === 'reset-panel' ? '确认重置位置？' : '仅重置便签位置'),
          h('button', {
            key: 'reset-all',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            'data-danger': 'true',
            onClick: onResetAll,
          }, armed === 'reset-all' ? '确认全部重置？' : '全部重置'),
        ]))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'hint-1' },
          h('span', { className: `${CSS_PREFIX}-hint` },
            '「删除本条 / 清空全部记事」只清内容，便签位置与尺寸保留；'
            + '「仅重置便签位置」只清位置尺寸，内容保留。')))

        if (notice !== null) {
          rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'notice' },
            h('span', {
              className: `${CSS_PREFIX}-note`,
              'data-tone': notice.tone,
            }, notice.text)))
        }

        rows.push(h('div', { className: `${CSS_PREFIX}-divider`, key: 'divider-2' }))

        rows.push(h('div', { className: `${CSS_PREFIX}-row`, key: 'manual' }, [
          h('span', { key: 'label', className: `${CSS_PREFIX}-label` }, '会话绑定'),
          h('input', {
            key: 'manual-input',
            className: `${CSS_PREFIX}-text`,
            type: 'text',
            placeholder: '自动识别失败时可手动填会话 ID',
            value: manualDraft,
            onChange: (event) => setManualDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onManualChange(event.currentTarget.value)
            },
            onBlur: (event) => {
              if (event.currentTarget.value.trim() !== (manual ?? '')) onManualChange(event.currentTarget.value)
            },
          }),
          h('button', {
            key: 'manual-clear',
            type: 'button',
            className: `${CSS_PREFIX}-action`,
            disabled: manual === null && manualDraft.length === 0,
            onClick: () => onManualChange(''),
          }, '恢复自动'),
          h('span', { key: 'hint', className: `${CSS_PREFIX}-hint` },
            sessionSource === 'manual'
              ? '当前使用手动会话 ID；自动识别恢复后会自动让位。'
              : '默认自动跟随主视图会话；仅在识别不到时才用手动值。'),
        ]))

        return h('div', {
          className: `${CSS_PREFIX}-sheet`,
          key: 'sheet',
          onPointerDown: (event) => event.stopPropagation(),
        }, rows)
      }

      // #endregion

      // #region render

      return h('div', {
        className: `${CSS_PREFIX}-root`,
        'data-collapsed': panel.collapsed ? 'true' : 'false',
        style: panel.collapsed
          ? { left: `${geometry.pos.x}px`, top: `${geometry.pos.y}px` }
          : {
            left: `${geometry.pos.x}px`,
            top: `${geometry.pos.y}px`,
            width: `${geometry.size.w}px`,
            height: `${geometry.size.h}px`,
          },
      }, [
        h('div', {
          key: 'header',
          className: `${CSS_PREFIX}-header`,
          onPointerDown: startDrag,
          onPointerMove,
          onPointerUp: endGesture,
          onPointerCancel: endGesture,
          role: 'toolbar',
          'aria-label': '会话记事标题栏（可拖动）',
        }, [
          h('span', {
            key: 'dot',
            className: `${CSS_PREFIX}-dot`,
            'data-state': saveError ? 'error' : (sessionSource === 'none' ? 'none' : 'ok'),
          }),
          h('span', {
            key: 'title',
            className: `${CSS_PREFIX}-title`,
            title: target ?? '',
          }, sessionSource === 'none' ? '会话记事' : `会话记事 · ${shortSessionId(target)}`),
          headerButton(manageOpen ? '收起' : '管理', '数据管理：用量、导出导入、清空缓存', () => {
            setManageOpen((open) => !open)
          }),
          headerButton(
            panel.collapsed ? '▸' : '▾',
            panel.collapsed ? '展开（Ctrl/Cmd+Shift+N）' : '折叠（Ctrl/Cmd+Shift+N）',
            toggleCollapsed,
          ),
        ]),

        panel.collapsed ? null : h('div', { key: 'body', className: `${CSS_PREFIX}-body` }, [
          h('textarea', {
            key: 'input',
            className: `${CSS_PREFIX}-input`,
            value: note.text,
            placeholder: sessionSource === 'none'
              ? '未选中会话：请在左侧选择一个会话后开始记录'
              : '记下这个会话的重点，例如待办、结论、约束…',
            disabled: !editable,
            spellCheck: false,
            onChange: (event) => {
              const value = event.target.value
              setNote((previous) => ({ ...previous, text: value }))
              if (editable) scheduleSave(target, value)
            },
            onBlur: () => flush(),
          }),
          h('div', { key: 'foot', className: `${CSS_PREFIX}-foot` }, [
            h('span', {
              key: 'status',
              className: `${CSS_PREFIX}-footText`,
              title: statusText,
            }, statusText),
            h('span', {
              key: 'right',
              className: `${CSS_PREFIX}-footText`,
              'data-tone': saveError ? 'error' : 'normal',
              style: { flex: '0 0 auto', textAlign: 'right' },
            }, footRight),
          ]),
        ]),

        panel.collapsed ? null : (manageOpen ? renderManageSheet() : null),

        panel.collapsed ? null : h('div', {
          key: 'grip',
          className: `${CSS_PREFIX}-grip`,
          title: '拖动调整大小',
          onPointerDown: startResize,
          onPointerMove,
          onPointerUp: endGesture,
          onPointerCancel: endGesture,
        }),
      ])
    }

    // #endregion

    // #region plugin entry

    const inject = ['sessions']

    /**
     * Mount the note panel in its own fixed root on `document.body`.
     *
     * A frame-wide floating surface could also be registered into
     * `shell.overlay`, but that slot is click-through and its activation
     * semantics are owned by the shell; a standalone root gives the panel full
     * control of its own stacking and pointer behaviour with no shell coupling.
     */
    function mountPanel(ctx) {
      if (typeof document === 'undefined' || document.body === null) {
        console.error(`[${PLUGIN_ID}] document.body is unavailable; the note panel was not mounted`)
        return () => {}
      }

      // A reload that re-mounts without tearing the old root down first would
      // otherwise leave a second panel stacked on the first.
      try {
        for (const stale of document.querySelectorAll(`[data-dsh-plugin="${PLUGIN_ID}"]`)) {
          stale.remove()
        }
      } catch {
        /* the selector is best-effort cleanup */
      }

      const face = createFace(ctx)
      const container = document.createElement('div')
      container.dataset.dshPlugin = PLUGIN_ID
      container.dataset.dshSessionNotesRoot = ''
      document.body.appendChild(container)

      const root = createRoot(container)
      root.render(h(SessionNotesPanel, { face }))

      return () => {
        try {
          root.unmount()
        } catch (error) {
          console.error(`[${PLUGIN_ID}] unmount failed`, error)
        }
        try {
          container.remove()
        } catch {
          /* already detached */
        }
      }
    }

    function apply(ctx) {
      // `styles` is a documented builtin of a dynamic client half; the DOM
      // fallback keeps the panel styled when it is not composed in.
      ctx.effect(() => insertStyles(CSS), `${PLUGIN_ID}: stylesheet`)
      ctx.effect(() => mountPanel(ctx), `${PLUGIN_ID}: note panel`)
    }

    exports.apply = apply
    exports.inject = inject
    // Test hook: the pure storage/session/geometry layer, so the suite can
    // exercise exactly the bytes that ship.
    exports.__core = core
    exports.__internals = {
      SessionNotesPanel,
      createFace,
      mountPanel,
      CSS,
      PLUGIN_ID,
      viewportSize,
      knownSessionIds,
      downloadText,
    }

    return module.exports
  },
})
