/**
 * dsh-panel-scroll — client half.
 *
 * 1. The sidebar panel list (`sidebar.panellist`) shows only N rows (default 4)
 *    and scrolls for the rest — the same behaviour the workspace tree has.
 * 2. Inside the right column, containers whose content overflows while being
 *    clipped (`overflow: hidden | clip`) are made scrollable, so panels stop
 *    swallowing their content.
 *
 * Why it works this way
 * ---------------------
 * The shell renders the panel list itself, and `sidebar.panellist`
 * registration only accepts id / order / label — there is no API to size it.
 * So this plugin registers one *invisible* marker entry: its DOM node is the
 * only stable anchor inside that list. From the anchor it walks up:
 *
 *   span (marker) -> div[display:contents] -> span.panelGlyph (display:none)
 *     -> button.panelRow   <- one row (has a same-tag+class sibling)
 *     -> nav.panelList     <- the list that gets capped
 *
 * Rows are matched structurally ("an ancestor with at least one sibling that
 * shares its tag and class"), so no shell class name is hard-coded and the
 * plugin survives a shell restyle.
 *
 * The cap is published as a stylesheet rule with `!important` rather than an
 * inline style: the shell re-renders the list and drops inline values.
 *
 * Settings (localStorage):
 *   dsh-panel-scroll:rows     visible rows, default 4 (1..20)
 *   dsh-panel-scroll:unclog   set to "off" to disable the right-column pass
 */
window.__ModuleLoader__.load({
  id: 'dsh-panel-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    const DEFAULT_ROWS = 4
    const ROWS_KEY = 'dsh-panel-scroll:rows'
    const UNCLOG_KEY = 'dsh-panel-scroll:unclog'
    const HOST_CLASS = 'dsh-panel-scroll-host'
    const COLUMN_CLASS = 'dsh-panel-scroll-column'
    const UNCLOG_CLASS = 'dsh-panel-scroll-unclog'
    const START_CLASS = 'dsh-panel-scroll-unclog-start'
    const FALLBACK_ROW_PX = 38
    const POLL_MS = 5000

    const SCROLLBAR = `
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l2, rgba(140,148,160,.45)) transparent;
`

    const CSS = `
.${HOST_CLASS} {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
${SCROLLBAR}}
.${HOST_CLASS} > * { flex-shrink: 0; }
/* The sidebar column must be allowed to shrink, or the capped list still
   pushes the workspace tree out of the window. */
.${COLUMN_CLASS} { min-height: 0 !important; }
.${HOST_CLASS}::-webkit-scrollbar { display: block !important; width: 6px; }
.${HOST_CLASS}::-webkit-scrollbar-track { background: transparent; }
.${HOST_CLASS}::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2, rgba(140,148,160,.45));
  border-radius: 3px;
}
.${HOST_CLASS}::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-label-secondary, rgba(140,148,160,.75));
}

/* Right column: clipped overflow becomes scrollable. Horizontal scrolling is
   left exactly as the shell set it — the right column also hosts editors and
   terminals, and forcing overflow-x would clip long lines. */
.${UNCLOG_CLASS} {
  overflow-y: auto !important;
  min-height: 0 !important;
  overscroll-behavior: contain;
${SCROLLBAR}}
.${UNCLOG_CLASS}::-webkit-scrollbar { display: block !important; width: 6px; }
.${UNCLOG_CLASS}::-webkit-scrollbar-track { background: transparent; }
.${UNCLOG_CLASS}::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2, rgba(140,148,160,.45));
  border-radius: 3px;
}
.${UNCLOG_CLASS}::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-label-secondary, rgba(140,148,160,.75));
}

/* Start-edge overflow: a flex container aligned to its end pushes the overflow
   ABOVE its own top edge, where scrollHeight does not count it and no scroll
   position can reach it. Aligning to the start turns it into ordinary overflow. */
.${START_CLASS} {
  justify-content: flex-start !important;
  align-content: flex-start !important;
}
`

    function readRows() {
      try {
        const raw = globalThis.localStorage?.getItem(ROWS_KEY)
        const n = Number.parseInt(raw ?? '', 10)
        if (Number.isFinite(n) && n >= 1 && n <= 20) return n
      } catch {}
      return DEFAULT_ROWS
    }

    function unclogAllowed() {
      try {
        return globalThis.localStorage?.getItem(UNCLOG_KEY) !== 'off'
      } catch {
        return true
      }
    }

    /**
     * The row that holds this anchor: an ancestor with at least one sibling
     * sharing its tag and class, and a plausible row height. One sibling is
     * enough — a user with a single panel beside the marker still gets capped.
     */
    function rowOf(el) {
      let node = el
      while (node && node.parentElement) {
        const parent = node.parentElement
        const tag = node.tagName
        const cls = String(node.className || '')
        let twins = 0
        for (const sibling of parent.children) {
          if (sibling === node) continue
          if (sibling.tagName === tag && String(sibling.className || '') === cls) twins += 1
        }
        if (twins >= 1) {
          const height = node.getBoundingClientRect().height
          if (height >= 16 && height <= 120) return { row: node, list: parent }
        }
        node = parent
      }
      return null
    }

    /**
     * Row pitch: the smallest positive top-to-top distance between two rows.
     * Using the pitch (not the row height) keeps the cap at exactly N rows
     * whether or not the list uses a flex gap.
     */
    function rowPitch(list, row) {
      const tops = []
      for (const child of list.children) {
        if (child === row) continue
        if (!(child instanceof HTMLElement)) continue
        const rect = child.getBoundingClientRect()
        if (rect.height < 16 || rect.height > 120) continue
        tops.push(rect.top)
      }
      tops.sort((a, b) => a - b)
      for (let i = 1; i < tops.length; i += 1) {
        const delta = tops[i] - tops[i - 1]
        if (delta >= 16 && delta <= 120) return delta
      }
      return 0
    }

    function verticalGap(list) {
      const style = getComputedStyle(list)
      const gap = Number.parseFloat(style.rowGap || style.gap || '0')
      return Number.isFinite(gap) && gap > 0 ? gap : 0
    }

    function verticalPadding(list) {
      const style = getComputedStyle(list)
      const top = Number.parseFloat(style.paddingTop || '0') || 0
      const bottom = Number.parseFloat(style.paddingBottom || '0') || 0
      return top + bottom
    }

    function fitList(list, row, host) {
      if (!list || !list.isConnected || !host.sheet) return
      const rows = readRows()
      const pitch = rowPitch(list, row) || FALLBACK_ROW_PX + verticalGap(list)
      const maxHeight = `${Math.round(rows * pitch + verticalPadding(list))}px`
      if (!list.classList.contains(HOST_CLASS)) {
        list.classList.add(HOST_CLASS)
        host.touched.add(list)
      }
      // Everything goes through the stylesheet: inline values would survive
      // dispose() and keep the sidebar capped after the plugin is uninstalled.
      const rule = `.${HOST_CLASS} { max-height: ${maxHeight} !important; }`
      if (host.rule !== rule) {
        host.rule = rule
        host.sheet.textContent = `${CSS}\n${rule}\n`
      }
      const column = list.parentElement
      if (column && !column.classList.contains(COLUMN_CLASS)) {
        column.classList.add(COLUMN_CLASS)
        host.touched.add(column)
      }
    }

    function PanelScrollMarker({ host }) {
      const ref = React.useRef(null)
      React.useLayoutEffect(() => {
        if (!host) return
        let row = null
        let list = null
        let frame = 0
        let observer = null

        const ensure = () => {
          const el = ref.current
          if (!el || !el.isConnected) return
          const found = rowOf(el)
          if (!found) return
          if (found.row !== row || !list || !list.isConnected) {
            row = found.row
            list = found.list
            if (row.style.display !== 'none') row.style.display = 'none'
            if (row.getAttribute('aria-hidden') !== 'true') row.setAttribute('aria-hidden', 'true')
            observe()
          }
          fitList(list, row, host)
        }

        const schedule = () => {
          if (frame) return
          frame = globalThis.requestAnimationFrame(() => {
            frame = 0
            ensure()
          })
        }

        const observe = () => {
          observer?.disconnect()
          if (!list || typeof MutationObserver === 'undefined') return
          observer = new MutationObserver(schedule)
          observer.observe(list, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style'],
          })
          // The shell re-renders our own row too; watch it separately so the
          // row cannot reappear for a polling interval.
          if (row) observer.observe(row, { attributes: true, attributeFilter: ['class', 'style'] })
        }

        ensure()
        // Fallback only — mutations and resize drive the normal path.
        const timer = globalThis.setInterval(ensure, POLL_MS)
        const onResize = () => schedule()
        globalThis.addEventListener('resize', onResize)

        return () => {
          globalThis.clearInterval(timer)
          globalThis.removeEventListener('resize', onResize)
          if (frame) globalThis.cancelAnimationFrame(frame)
          observer?.disconnect()
        }
      }, [host])

      return h('span', { ref, style: { display: 'none' }, 'aria-hidden': 'true' })
    }

    /**
     * The right column: the widest tall container that ends flush with the
     * right edge of the viewport. Found structurally — no shell class name.
     */
    function findRightColumn(host) {
      if (host.rightColumn && host.rightColumn.isConnected) return host.rightColumn
      host.rightColumn = null
      const vw = globalThis.innerWidth
      const vh = globalThis.innerHeight
      let width = 0
      for (const el of document.body.querySelectorAll('div,aside,section,main')) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 160 || rect.height < vh * 0.7) continue
        if (rect.left < vw * 0.5) continue
        if (Math.abs(rect.right - vw) > 4) continue
        if (rect.width > width) {
          width = rect.width
          host.rightColumn = el
        }
      }
      if (host.rightColumn) observeRightColumn(host)
      return host.rightColumn
    }

    /**
     * A flex/grid container can overflow on its START edge: when it is aligned
     * to the end (or centred), the excess sits above its own top, `scrollHeight`
     * does not count it, and no scrollTop can reach it. Detect that by comparing
     * the leading children against the container box.
     *
     * Guard against the obvious false positive: a container the user has
     * scrolled down legitimately has its first child above its top edge.
     */
    function hasStartOverflow(el, style = getComputedStyle(el)) {
      if (el.scrollTop > 0) return false
      if (!style.display.includes('flex') && !style.display.includes('grid')) return false
      const box = el.getBoundingClientRect()
      let inspected = 0
      for (const child of el.children) {
        if (!(child instanceof HTMLElement)) continue
        if (inspected >= 3) break
        inspected += 1
        const childStyle = getComputedStyle(child)
        if (childStyle.position === 'fixed' || childStyle.position === 'absolute') continue
        const rect = child.getBoundingClientRect()
        if (rect.height < 4) continue
        if (rect.top < box.top - 2) return true
      }
      return false
    }

    /**
     * Inside the right column:
     *  - a flex/grid container whose children sit ABOVE its top (end- or
     *    centre-aligned overflow) gets start alignment, because that overflow
     *    is unreachable: scrollHeight ignores it and no scrollTop can reach it.
     *    This is checked before the overflow style, since such a container is
     *    often `overflow: visible` and merely leaks past its own box.
     *  - a container that clips and is taller inside than outside becomes
     *    scrollable.
     */
    /** One measure-then-apply round. Returns how many elements changed. */
    function unclogPass(host, root) {
      // Pass 1 — measure only. Touching classList while measuring would
      // invalidate layout and force a re-layout for every element in the loop.
      const startFixes = []
      const scrollFixes = []
      for (const el of root.querySelectorAll('*')) {
        if (!(el instanceof HTMLElement)) continue
        if (el.clientHeight < 60) continue
        const patchedStart = el.classList.contains(START_CLASS)
        const patchedScroll = el.classList.contains(UNCLOG_CLASS)
        if (patchedStart && patchedScroll) continue
        const style = getComputedStyle(el)
        const clips = style.overflowY === 'hidden' || style.overflowY === 'clip'
        if (!patchedStart && hasStartOverflow(el, style)) {
          startFixes.push(el)
          if (clips) scrollFixes.push(el)
          continue
        }
        if (!patchedScroll && clips && el.scrollHeight > el.clientHeight + 8) scrollFixes.push(el)
      }

      // Pass 2 — apply.
      for (const el of startFixes) {
        el.classList.add(START_CLASS)
        host.touched.add(el)
      }
      for (const el of scrollFixes) {
        el.classList.add(UNCLOG_CLASS)
        host.touched.add(el)
      }
      return startFixes.length + scrollFixes.length
    }

    function unclogRightColumn(host) {
      if (!unclogAllowed()) return 0
      const root = findRightColumn(host)
      if (!root) return 0
      // Fixes cascade: un-aligning a container only makes its parent overflow
      // afterwards. Re-measure in the same tick so the parent is patched now
      // instead of on the next poll. Bounded so a pathological tree cannot loop.
      const MAX_ROUNDS = 6
      let total = 0
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const changed = unclogPass(host, root)
        total += changed
        if (!changed) break
      }
      return total
    }

    function observeRightColumn(host) {
      const root = host.rightColumn
      if (!root || typeof MutationObserver === 'undefined') return
      host.rightObserver?.disconnect()
      host.rightObserver = new MutationObserver(() => {
        const now = Date.now()
        if (now - host.unclogAt < 400) return
        host.unclogAt = now
        unclogRightColumn(host)
      })
      host.rightObserver.observe(root, { childList: true, subtree: true })
    }

    exports.inject = ['slots']
    exports.apply = (ctx) =>
      ctx.effect(() => {
        const host = {
          sheet: null,
          rule: '',
          rightColumn: null,
          rightObserver: null,
          unclogAt: 0,
          touched: new Set(),
        }

        const sheet = document.createElement('style')
        sheet.dataset.dshPanelScroll = ''
        sheet.textContent = CSS
        document.head.appendChild(sheet)
        host.sheet = sheet

        const dispose = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-panel-scroll',
              order: 9999,
              label: () => '',
            },
            () => h(PanelScrollMarker, { host }),
          ),
        )

        unclogRightColumn(host)
        const unclogTimer = globalThis.setInterval(() => unclogRightColumn(host), POLL_MS)
        const onResize = () => {
          host.rightColumn = null
          host.rule = ''
          unclogRightColumn(host)
        }
        globalThis.addEventListener('resize', onResize)

        return () => {
          dispose()
          globalThis.clearInterval(unclogTimer)
          globalThis.removeEventListener('resize', onResize)
          host.rightObserver?.disconnect()
          // Leave nothing behind on shell-owned elements.
          for (const el of host.touched) {
            el.classList.remove(HOST_CLASS, COLUMN_CLASS, UNCLOG_CLASS, START_CLASS)
          }
          host.touched.clear()
          sheet.remove()
          host.sheet = null
        }
      }, 'dsh-panel-scroll: sidebar panel scroll window')

    return exports
  },
})
