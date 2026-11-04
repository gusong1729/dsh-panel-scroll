// Smoke test: load client.js in Node with a minimal DOM/loader stub and run
// apply() end to end. Catches load-time and registration-path errors that
// `node --check` cannot see, plus the dispose path (nothing may be left behind
// on shell-owned elements). Geometry is only faked to the extent the right
// column scan needs it — the real layout is covered by tests/harness.html.
import { pathToFileURL } from 'node:url'

// ---- minimal DOM ---------------------------------------------------------
class FakeHTMLElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.clientHeight = 0
    this.scrollHeight = 0
    this.scrollTop = 0
    this.style = {}
    this._classes = new Set()
    const classes = this._classes
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    }
  }
  get className() { return [...this._classes].join(' ') }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  querySelectorAll() { return [] }
}
globalThis.HTMLElement = FakeHTMLElement

globalThis.getComputedStyle = (el) => ({
  display: el.__display || 'block',
  overflowY: el.__overflowY || 'visible',
  flexDirection: 'column',
  justifyContent: 'normal',
  rowGap: '0px',
  gap: '0px',
  paddingTop: '0px',
  paddingBottom: '0px',
})

// The clipped right-column body the scan must discover and patch.
const fakeBody = new FakeHTMLElement('div')
fakeBody.clientHeight = 600
fakeBody.scrollHeight = 1200
fakeBody.__overflowY = 'hidden'

const fakeColumn = new FakeHTMLElement('div')
fakeColumn.isConnected = true
fakeColumn.clientHeight = 700
fakeColumn.getBoundingClientRect = () => ({
  top: 0, left: 700, right: 1000, bottom: 700, width: 300, height: 700,
})
fakeColumn.querySelectorAll = (selector) => (selector === '*' ? [fakeBody] : [])

const appended = []
globalThis.document = {
  createElement: (tag) => {
    const el = new FakeHTMLElement(tag)
    if (tag === 'style') {
      el.dataset = {}
      el.textContent = ''
      el.remove = function remove() { this.removed = true }
    }
    return el
  },
  head: { appendChild(el) { appended.push(el) } },
  body: { querySelectorAll: () => [fakeColumn] },
}

globalThis.window = {
  __ModuleLoader__: { load(definition) { globalThis.__captured = definition } },
}
globalThis.innerWidth = 1000
globalThis.innerHeight = 900
globalThis.localStorage = { getItem: () => null }
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}

// ---- load and run --------------------------------------------------------
await import(pathToFileURL('./client.js').href)

const captured = globalThis.__captured
if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')
if (captured.id !== 'dsh-panel-scroll') throw new Error(`unexpected id: ${captured.id}`)

const React = {
  createElement: (type, props) => ({ type, props }),
  useRef: () => ({ current: null }),
  useLayoutEffect: () => {},
}

let registrations = 0
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose !== 'function') throw new Error('effect must return a dispose function')
    return dispose
  },
  slots: {
    inject(key, callback) {
      if (key !== 'sidebar.panellist') throw new Error(`unexpected slot: ${key}`)
      return callback()
    },
    register(options, component) {
      registrations += 1
      if (options.name !== 'sidebar.panellist') throw new Error('bad registration options')
      if (typeof component !== 'function') throw new Error('component is not a function')
      return () => {}
    },
  },
}

const client = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

if (typeof client.apply !== 'function') throw new Error('missing apply')
if (!Array.isArray(client.inject) || !client.inject.includes('slots')) throw new Error('missing inject')

const dispose = client.apply(ctx)
if (appended.length !== 1) throw new Error(`expected one <style>, got ${appended.length}`)
if (!appended[0].textContent.includes('dsh-panel-scroll-host')) throw new Error('stylesheet has no host rule')
if (registrations !== 1) throw new Error(`expected one slot registration, got ${registrations}`)

// The clipped right-column body must have been made scrollable.
if (!fakeBody.classList.contains('dsh-panel-scroll-unclog')) {
  throw new Error('clipped right-column body was not patched')
}

if (typeof dispose !== 'function') throw new Error('apply must return/dispose cleanly')
dispose()

if (!appended[0].removed) throw new Error('stylesheet was not removed on dispose')
if (fakeBody.classList.contains('dsh-panel-scroll-unclog')) {
  throw new Error('dispose left classes on a shell-owned element')
}
if (fakeBody.classList.contains('dsh-panel-scroll-unclog-start')) {
  throw new Error('dispose left the start-alignment class behind')
}

console.log('SMOKE OK — apply() ran, one style injected, one slot registered,')
console.log('           right-column body patched, dispose removed style + classes')
