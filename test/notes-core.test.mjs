/**
 * Checks for dsh-session-notes.
 *
 * The client half is a hand-written bundle with no build step, so these tests
 * load the shipped file itself through a stubbed `window.__ModuleLoader__` and
 * exercise the exact bytes the browser will run — no copy of the logic and no
 * bundler in the loop.
 *
 * Run with `node --test test/` (Node's test runner) or plainly with
 * `node test/notes-core.test.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const clientPath = join(packageRoot, 'lib', 'client.js')
const clientSource = readFileSync(clientPath, 'utf8')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const patchText = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')

/** Load the shipped bundle and capture what it registers with the loader. */
function loadBundle() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registrations.push(entry)
      },
    },
  }

  const renderCalls = []
  const unmountCalls = []
  const fakeReact = {
    createElement: (type, props, children) => ({ type, props, children }),
    useState: () => [],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const modules = {
    react: fakeReact,
    'react-dom': {},
    'react/jsx-runtime': {},
    'react-dom/client': {
      createRoot(componentContainer) {
        return {
          container: componentContainer,
          render(element) {
            renderCalls.push({ container: componentContainer, element })
          },
          unmount() {
            unmountCalls.push(componentContainer)
          },
        }
      },
    },
  }

  // A bare import of the file evaluates `window.__ModuleLoader__.load(...)`.
  const load = new Function(`${clientSource}\nreturn window.__ModuleLoader__`)
  load()
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  const entry = registrations[0]
  const runtime = { module: { exports: {} } }
  entry.factory((id) => {
    if (!(id in modules)) throw new Error(`unexpected require(${id})`)
    return modules[id]
  })
  return { entry, runtime, renderCalls, unmountCalls, fakeReact }
}

/** Minimal in-memory Storage with an optional write-failure switch. */
function mockStorage() {
  const map = new Map()
  return {
    map,
    failWrites: false,
    get length() {
      return map.size
    },
    key(index) {
      return [...map.keys()][index] ?? null
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null
    },
    setItem(key, value) {
      if (this.failWrites) {
        const error = new Error('quota')
        error.name = 'QuotaExceededError'
        throw error
      }
      map.set(String(key), String(value))
    },
    removeItem(key) {
      map.delete(String(key))
    },
  }
}

const loaded = loadBundle()
const entry = loaded.entry
const exports_ = entry.runtime.module.exports
const core = exports_.__core

let failures = 0
let passes = 0
const pending = []

function test(name, body) {
  pending.push({ name, body })
}

function storageOf(mock) {
  return core.createStorage(mock)
}

test('the shipped bundle registers the package id and the expected contract', () => {
  assert.equal(entry.id, packageJson.name)
  assert.equal(typeof entry.factory, 'function')
  assert.equal(typeof exports_.apply, 'function')
  assert.deepEqual(exports_.inject, ['sessions'])
  assert.equal(typeof exports_.__internals.SessionNotesPanel, 'function')
  assert.equal(typeof exports_.__internals.mountPanel, 'function')
  assert.ok(exports_.__internals.CSS.includes('.dsn-root'))
  assert.ok(exports_.__internals.CSS.includes('position: fixed'))
})

test('package.json and cordis.patch.yml agree on name, entry, and mount row', () => {
  assert.equal(packageJson.name, 'dsh-session-notes')
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.main, 'lib/index.js')
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(Array.isArray(packageJson.dsh.client.inject))
  assert.ok(typeof packageJson.dsh.engines.dsh === 'string')
  assert.ok(patchText.includes('name: dsh-session-notes'), 'the insert row must use the package name')
  assert.ok(/-\s*insert:/.test(patchText))
  assert.ok(patchText.includes('id: session-notes'))
})

test('byteSize and charCount count real storage size and code points', () => {
  assert.equal(core.byteSize('abc'), 3)
  assert.equal(core.byteSize('中文'), 6)
  assert.equal(core.byteSize('😀'), 4)
  assert.equal(core.charCount('😀'), 1)
  assert.equal(core.charCount('ab中'), 3)
  assert.equal(core.charCount(''), 0)
  assert.equal(core.charCount(undefined), 0)
})

test('formatBytes, formatClock and shortSessionId stay readable', () => {
  assert.equal(core.formatBytes(0), '0 B')
  assert.equal(core.formatBytes(512), '512 B')
  assert.equal(core.formatBytes(2048), '2.0 KB')
  assert.equal(core.formatBytes(3 * 1024 * 1024), '3.00 MB')
  assert.equal(core.formatBytes(Number.NaN), '0 B')
  assert.equal(core.formatClock(0), '')
  assert.match(core.formatClock(Date.now()), /^\d{2}:\d{2}$/)
  assert.equal(core.shortSessionId('abc'), 'abc')
  assert.equal(core.shortSessionId('session-6d53d778c670'), 'session-…')
  assert.equal(core.shortSessionId(undefined), '')
})

test('no storage available degrades to a read-only adapter', () => {
  const storage = core.createStorage(null)
  assert.equal(storage.available, false)
  assert.equal(storage.get('anything'), null)
  assert.equal(storage.set('anything', 'value'), false)
  assert.deepEqual(storage.keys(), [])
  assert.deepEqual(core.readNote(storage, 's1'), { text: '', updatedAt: 0, corrupt: false })
})

test('note create/read/update/delete keeps the index in sync', () => {
  const storage = storageOf(mockStorage())
  assert.deepEqual(core.readNote(storage, 's1'), { text: '', updatedAt: 0, corrupt: false })

  const first = core.writeNote(storage, 's1', '重点一', 111)
  assert.equal(first.ok, true)
  assert.deepEqual(core.listSessions(storage), ['s1'])
  assert.deepEqual(core.readNote(storage, 's1'), { text: '重点一', updatedAt: 111, corrupt: false })

  core.writeNote(storage, 's2', 'another', 222)
  assert.deepEqual(core.listSessions(storage).sort(), ['s1', 's2'])
  // Rewriting an existing session must not duplicate the index entry.
  core.writeNote(storage, 's1', '更新', 333)
  assert.deepEqual(core.listSessions(storage).sort(), ['s1', 's2'])

  core.deleteNote(storage, 's1')
  assert.deepEqual(core.listSessions(storage), ['s2'])
  assert.equal(storage.get(`${core.SESSION_PREFIX}s1`), null)
})

test('corrupt and mistyped values degrade instead of throwing', () => {
  const mock = mockStorage()
  const storage = storageOf(mock)
  storage.set(`${core.SESSION_PREFIX}s1`, '{not json')
  storage.set(`${core.SESSION_PREFIX}s2`, JSON.stringify({ text: 42 }))
  storage.set(core.INDEX_KEY, 'nope')

  assert.deepEqual(core.readNote(storage, 's1'), { text: '', updatedAt: 0, corrupt: true })
  assert.deepEqual(core.readNote(storage, 's2'), { text: '', updatedAt: 0, corrupt: true })
  // A junk index is rebuilt from what actually exists.
  assert.deepEqual(core.listSessions(storage).sort(), ['s1', 's2'])
  // A stale index entry is dropped.
  storage.set(core.INDEX_KEY, JSON.stringify(['s1', 'ghost']))
  assert.deepEqual(core.listSessions(storage), ['s1'])
})

test('mainViewSessionId follows the retainedBy.mainView marker only', () => {
  assert.equal(core.mainViewSessionId(undefined), undefined)
  assert.equal(core.mainViewSessionId(null), undefined)
  assert.equal(core.mainViewSessionId({}), undefined)
  assert.equal(core.mainViewSessionId({ a: { id: 'a' } }), undefined)
  assert.equal(core.mainViewSessionId({
    a: { id: 'a', retainedBy: { sidebar: 1 } },
    b: { id: 'b', retainedBy: { mainView: 1 } },
  }), 'b')
  assert.equal(core.mainViewSessionId({ a: { retainedBy: { mainView: 2 } } }), undefined)
})

test('resolveSession only falls back to the manual override when needed', () => {
  const byId = { a: { id: 'a', retainedBy: { mainView: 1 } } }
  assert.deepEqual(core.resolveSession(byId, 'manual-id'), { id: 'a', source: 'mainView' })
  assert.deepEqual(core.resolveSession({}, 'manual-id'), { id: 'manual-id', source: 'manual' })
  assert.deepEqual(core.resolveSession({}, null), { id: undefined, source: 'none' })
  assert.deepEqual(core.resolveSession(undefined, ''), { id: undefined, source: 'none' })
})

test('the manual session override round-trips', () => {
  const storage = storageOf(mockStorage())
  assert.equal(core.readManualSession(storage), null)
  core.writeManualSession(storage, 'session-x')
  assert.equal(core.readManualSession(storage), 'session-x')
  core.writeManualSession(storage, '')
  assert.equal(core.readManualSession(storage), null)
})

test('clampGeometry keeps the panel on screen at every size', () => {
  const viewport = { width: 1280, height: 800 }
  const tiny = core.clampGeometry({ x: -400, y: -400 }, { w: 40, h: 40 }, viewport)
  assert.equal(tiny.size.w, core.MIN_W)
  assert.equal(tiny.size.h, core.MIN_H)
  assert.ok(tiny.pos.x >= 0 && tiny.pos.y >= 0)

  const huge = core.clampGeometry({ x: 99999, y: 99999 }, { w: 99999, h: 99999 }, viewport)
  assert.ok(huge.size.w <= core.MAX_W)
  assert.ok(huge.size.h <= core.MAX_H)
  assert.ok(huge.pos.x + huge.size.w <= viewport.width)
  assert.ok(huge.pos.y + huge.size.h <= viewport.height)

  // A viewport smaller than the minimums must not produce negative geometry.
  const small = core.clampGeometry({ x: 10, y: 10 }, { w: 400, h: 300 }, { width: 300, height: 220 })
  assert.ok(small.size.w >= core.MIN_W)
  assert.ok(small.pos.x >= 0)

  const nan = core.clampGeometry(
    { x: Number.NaN, y: Number.NaN },
    { w: Number.NaN, h: Number.NaN },
    viewport,
  )
  assert.ok(Number.isFinite(nan.pos.x) && Number.isFinite(nan.pos.y))
  assert.equal(nan.size.w, core.MIN_W)
  assert.equal(nan.size.h, core.MIN_H)
})

test('defaultPosition parks the panel clear of the bottom-right corner', () => {
  const viewport = { width: 1280, height: 800 }
  const settled = core.defaultPosition({ w: 320, h: 260 }, viewport, { right: 300, bottom: 96 })
  assert.equal(settled.size.w, 320)
  assert.equal(settled.pos.x, viewport.width - 300 - 320)
  assert.equal(settled.pos.y, viewport.height - 96 - 260)
  const clamped = core.defaultPosition({ w: 700, h: 600 }, { width: 400, height: 300 }, { right: 300, bottom: 96 })
  assert.ok(clamped.pos.x >= 0 && clamped.pos.y >= 0)
})

test('panel preferences survive a round-trip and reject junk', () => {
  const mock = mockStorage()
  const storage = storageOf(mock)
  const fresh = core.readPanel(storage)
  assert.equal(fresh.collapsed, false)
  assert.ok(fresh.size.w > 0)

  core.writePanel(storage, { pos: { x: 12, y: 34 }, size: { w: 400, h: 300 }, collapsed: true })
  assert.deepEqual(core.readPanel(storage), {
    pos: { x: 12, y: 34 },
    size: { w: 400, h: 300 },
    collapsed: true,
  })

  mock.setItem(core.PANEL_KEY, '{"pos":{"x":"nope"},"size":{"w":null},"collapsed":"yes"}')
  const degraded = core.readPanel(storage)
  assert.equal(degraded.pos.x, null)
  assert.equal(degraded.collapsed, false)
  assert.ok(Number.isFinite(degraded.size.w))

  mock.setItem(core.PANEL_KEY, '[1,2,3]')
  assert.equal(core.readPanel(storage).collapsed, false)
})

test('a full storage reports failure instead of throwing', () => {
  const mock = mockStorage()
  const storage = storageOf(mock)
  storage.set('probe', 'ok')
  mock.failWrites = true
  const result = core.writeNote(storage, 's1', 'x')
  assert.equal(result.ok, false)
  assert.equal(storage.quotaExceeded, true)
  assert.equal(storage.get(`${core.SESSION_PREFIX}s1`), null)
  mock.failWrites = false
  assert.equal(core.writeNote(storage, 's1', 'x').ok, true)
  assert.equal(storage.quotaExceeded, false)
})

test('the four clear actions never overstep their stated scope', () => {
  const storage = storageOf(mockStorage())
  core.writeNote(storage, 's1', 'a', 1)
  core.writeNote(storage, 's2', 'b', 2)
  core.writeNote(storage, 's3', 'c', 3)
  core.writePanel(storage, { pos: { x: 5, y: 6 }, size: { w: 300, h: 200 }, collapsed: false })

  // 1. current session only
  assert.deepEqual(core.clearCurrentNote(storage, 's2'), { removed: 1 })
  assert.deepEqual(core.listSessions(storage).sort(), ['s1', 's3'])
  assert.equal(core.readPanel(storage).pos.x, 5)

  // 3. orphans only (s1 left the catalog, s3 is known)
  assert.deepEqual(core.clearOrphans(storage, new Set(['s3'])), { removed: 1 })
  assert.deepEqual(core.listSessions(storage), ['s3'])
  assert.equal(core.readPanel(storage).pos.x, 5)

  // 4. panel state only — the remaining note is untouched
  assert.deepEqual(core.resetPanelState(storage), { removed: 1 })
  assert.equal(core.readPanel(storage).pos.x, null)
  assert.equal(core.readNote(storage, 's3').text, 'c')

  // 2. all notes — panel geometry is kept as it currently reads
  core.writePanel(storage, { pos: { x: 7, y: 8 }, size: { w: 300, h: 200 }, collapsed: false })
  assert.deepEqual(core.clearAllNotes(storage), { removed: 1 })
  assert.deepEqual(core.listSessions(storage), [])
  assert.equal(core.readPanel(storage).pos.x, 7)
})

test('clearEverything removes every key and leaves foreign data alone', () => {
  const mock = mockStorage()
  const storage = storageOf(mock)
  core.writeNote(storage, 's1', 'a', 1)
  core.writePanel(storage, { pos: { x: 1, y: 2 }, size: { w: 300, h: 200 }, collapsed: true })
  core.writeManualSession(storage, 's9')
  mock.setItem('unrelated-key', 'keep me')

  assert.deepEqual(core.ownedKeys(storage).sort(), [
    core.INDEX_KEY,
    core.MANUAL_KEY,
    core.PANEL_KEY,
    `${core.SESSION_PREFIX}s1`,
  ].sort())

  assert.deepEqual(core.clearEverything(storage), { removed: 4 })
  assert.deepEqual(core.ownedKeys(storage), [])
  assert.equal(storage.get('unrelated-key'), 'keep me')
})

test('measureNotes reports sizes, orphans, and corruption', () => {
  const storage = storageOf(mockStorage())
  core.writeNote(storage, 's1', 'hello', 1)
  core.writeNote(storage, 's2', '你好', 2)
  core.writeNote(storage, 'gone', 'stale', 3)
  storage.set(`${core.SESSION_PREFIX}bad`, '{oops')

  const report = core.measureNotes(storage, { id: 's1' }, new Set(['s1', 's2']))
  assert.equal(report.sessionCount, 4)
  assert.ok(report.totalBytes > 0)
  assert.ok(report.currentBytes > 0)
  assert.equal(report.currentChars, 5)
  assert.equal(report.currentUpdatedAt, 1)
  assert.deepEqual(report.orphans.sort(), ['bad', 'gone'])
  assert.equal(report.corruption, 1)

  // Without a known-session set, orphans are simply not computed.
  const noCatalog = core.measureNotes(storage, { id: 's2' })
  assert.deepEqual(noCatalog.orphans, [])
  assert.equal(noCatalog.currentChars, 2)
})

test('export then import round-trips, and the newer note wins', () => {
  const source = storageOf(mockStorage())
  core.writeNote(source, 's1', 'from source', 100)
  core.writeNote(source, 's2', 'second', 200)
  const document_ = core.buildExportDocument(source, undefined)
  assert.equal(document_.scope, 'all')
  assert.equal(document_.format, `${core.NAMESPACE}/${core.VERSION}`)
  assert.deepEqual(Object.keys(document_.notes).sort(), ['s1', 's2'])

  const single = core.buildExportDocument(source, 's1')
  assert.equal(single.scope, 'session')
  assert.deepEqual(Object.keys(single.notes), ['s1'])
  assert.deepEqual(core.buildExportDocument(source, 'missing').notes, {})

  const target = storageOf(mockStorage())
  core.writeNote(target, 's1', 'local newer', 500)
  const result = core.importNotes(target, JSON.parse(JSON.stringify(document_)))
  assert.equal(result.imported, 1) // s2 is new; s1 is older and skipped
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 0)
  assert.equal(core.readNote(target, 's1').text, 'local newer')
  assert.equal(core.readNote(target, 's2').text, 'second')

  assert.deepEqual(core.importNotes(target, { nope: true }), { imported: 0, skipped: 0, failed: 0 })
  assert.equal(core.importNotes(target, { s3: 'not an object', s4: { text: 7 } }).skipped, 2)
})

test('importing an empty or malformed document is a no-op', () => {
  const storage = storageOf(mockStorage())
  assert.deepEqual(core.importNotes(storage, null), { imported: 0, skipped: 0, failed: 0 })
  assert.deepEqual(core.importNotes(storage, []), { imported: 0, skipped: 0, failed: 0 })
  assert.deepEqual(core.importNotes(storage, { notes: {} }), { imported: 0, skipped: 0, failed: 0 })
  // A valid row with no timestamp still lands in empty storage.
  assert.deepEqual(core.importNotes(storage, { s1: { text: 'fresh' } }), { imported: 1, skipped: 0, failed: 0 })
  assert.equal(core.readNote(storage, 's1').text, 'fresh')
})

test('createFace reads the session catalog defensively', () => {
  const listeners = new Set()
  const state = { byId: { a: { id: 'a', retainedBy: { mainView: 1 } } }, revision: 7 }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
  }
  const face = exports_.__internals.createFace(ctx)
  assert.equal(face.getById(), state.byId)
  assert.equal(face.revision(), 7)
  assert.deepEqual(face.getKnownIds(), new Set(['a']))
  assert.deepEqual(core.resolveSession(face.getById(), null), { id: 'a', source: 'mainView' })

  let fired = 0
  const off = face.subscribe(() => { fired += 1 })
  for (const listener of listeners) listener()
  assert.equal(fired, 1)
  off()
  assert.equal(listeners.size, 0)

  // A refused service must degrade, not throw.
  const broken = exports_.__internals.createFace({
    get sessions() {
      throw new Error('proxy refused')
    },
  })
  assert.equal(broken.getById(), null)
  assert.equal(broken.revision(), 0)
  assert.deepEqual(broken.getKnownIds(), new Set())
  assert.doesNotThrow(() => broken.subscribe(() => {}))
})

/** A document stub recording created elements and body/head appends. */
function fakeDocument() {
  const created = []
  const bodyChildren = []
  const headChildren = []
  const queries = []
  const makeElement = (tag) => {
    const element = {
      tagName: tag,
      dataset: {},
      textContent: '',
      style: {},
      removed: false,
      remove() {
        this.removed = true
        const index = bodyChildren.indexOf(this)
        if (index >= 0) bodyChildren.splice(index, 1)
      },
    }
    created.push(element)
    return element
  }
  return {
    created,
    bodyChildren,
    headChildren,
    createElement: makeElement,
    // Stale-root cleanup queries this; the stub reports nothing to remove.
    querySelectorAll: (selector) => {
      queries.push(selector)
      return []
    },
    body: {
      appendChild(element) {
        bodyChildren.push(element)
        return element
      },
    },
    head: {
      appendChild(element) {
        headChildren.push(element)
        return element
      },
    },
  }
}

test('apply() mounts one panel root on document.body and cleans it up', () => {
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
  }
  const styleTags = []
  const dom = fakeDocument()
  const originalDocument = globalThis.document
  globalThis.document = dom
  globalThis.styles = { insert: (css) => { styleTags.push(css); return () => {} } }
  try {
    exports_.apply(ctx)
  } finally {
    delete globalThis.styles
    globalThis.document = originalDocument
  }

  assert.equal(effects.length, 2)
  assert.deepEqual(effects.map((entry) => entry.label.includes('session-notes')), [true, true])
  assert.equal(effects[0].label.endsWith('stylesheet'), true)
  assert.equal(effects[1].label.endsWith('note panel'), true)
  assert.equal(styleTags.length, 1)
  assert.ok(styleTags[0].includes('.dsn-root'))

  // Exactly one container, tagged so it is identifiable and removable.
  assert.equal(dom.bodyChildren.length, 1)
  const container = dom.bodyChildren[0]
  assert.equal(container.tagName, 'div')
  assert.equal(container.dataset.dshPlugin, 'dsh-session-notes')
  assert.ok('dshSessionNotesRoot' in container.dataset)

  // React rendered the panel component into it, with a face carrying the API.
  assert.equal(loaded.renderCalls.length, 1)
  assert.equal(loaded.renderCalls[0].container, container)
  const element = loaded.renderCalls[0].element
  assert.equal(element.type, exports_.__internals.SessionNotesPanel)
  const face = element.props.face
  assert.equal(typeof face.subscribe, 'function')
  assert.equal(typeof face.getById, 'function')
  assert.equal(typeof face.getKnownIds, 'function')
  assert.equal(face.getById(), null)
  assert.deepEqual(face.getKnownIds(), new Set())

  // Disposal unmounts and removes the container.
  effects[1].dispose()
  assert.deepEqual(loaded.unmountCalls, [container])
  assert.equal(dom.bodyChildren.length, 0)
})

test('apply() survives a missing document instead of throwing', () => {
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
  }
  const errors = []
  const originalError = console.error
  const originalDocument = globalThis.document
  delete globalThis.document
  console.error = (...args) => errors.push(args)
  try {
    assert.doesNotThrow(() => exports_.apply(ctx))
    for (const entry of effects) assert.doesNotThrow(() => entry.dispose())
  } finally {
    console.error = originalError
    globalThis.document = originalDocument
  }
  assert.ok(errors.length >= 1, 'the missing body must be reported')
})

test('insertStyles falls back to a tagged <style> element', () => {
  const dom = fakeDocument()
  const originalDocument = globalThis.document
  delete globalThis.styles
  globalThis.document = dom
  try {
    assert.doesNotThrow(() => exports_.apply({ effect: (callback) => { callback() } }))
  } finally {
    globalThis.document = originalDocument
  }
  const styleTag = dom.headChildren[0]
  assert.ok(styleTag !== undefined)
  assert.equal(styleTag.tagName, 'style')
  assert.equal(styleTag.dataset.plugin, 'dsh-session-notes')
  assert.ok(styleTag.textContent.includes('.dsn-root'))
})

for (const { name, body } of pending) {
  try {
    await body()
    passes += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
