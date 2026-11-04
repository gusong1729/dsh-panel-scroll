# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub Actions CI (`.github/workflows/ci.yml`): node 20/22/24, syntax check on
  every entry point, `package.json` shape, the smoke test, and a published-package
  check. Concurrency cancels superseded runs.
- `scripts/check-pack.mjs` — fails if the npm tarball would miss a file the README
  needs (images included) or ship tests/CI files.
- `scripts/push-api.mjs` — push a commit through the Git Data API when `git push`
  to `github.com:443` is blocked but `api.github.com` works. Reproduces the commit
  exactly (blobs, tree, modes, parents, author/committer dates) and asserts the
  resulting SHA equals local `HEAD`.

### Fixed

- `scripts/push-api.mjs` — replay each file's original mode (`100755`, `120000`)
  instead of a hard-coded `100644`; replay **all** parents so merge commits can be
  pushed; refuse gitlinks with a clear message instead of failing on
  `cat-file blob`; add `--dry-run`; capture stderr so an expected `422` stops
  looking like a crash; always remove the temporary directory.

## [0.2.4] - 2026-11-05

### Added

- The smoke test now asserts the dispose path: after unload, the injected
  stylesheet **and** every class added to shell-owned elements are gone.

### Changed

- Right-column scan runs up to 6 measure/apply rounds per tick, so a fix that only
  exposes the next problem after reflow settles in the same frame instead of on
  the next poll.
- Documented the 60px minimum height and the real reload story (refresh the page;
  no DSH restart needed).

## [0.2.3] - 2026-11-04

### Fixed

- Uninstalling no longer leaves the sidebar capped: `max-height` / `min-height`
  moved out of inline styles into the injected stylesheet plus classes, and
  `dispose()` removes both.
- Containers the user has scrolled are no longer misread as start-edge overflow
  (`scrollTop > 0` guard). Before this, scrolling a panel made the plugin force
  `justify-content: flex-start !important` onto it — and onto the main column when
  the right bar was closed.
- Scanning no longer alternates read/write per element (measure everything, then
  apply), avoiding O(n) forced reflows on large panels.
- Start-edge detection inspects only the leading three children instead of the
  whole child list.

## [0.2.2] - 2026-11-04

### Fixed

- **Right column: the first item was unreachable even at the top.** The culprit is
  a *centred* guide container whose excess height leaks above its own top edge —
  where `scrollHeight` does not count it and no `scrollTop` reaches it — while the
  container itself is `overflow: visible`, so the previous "clipped overflow" test
  never matched it. Start-edge overflow is now detected by geometry, before the
  overflow check, and the container is aligned back to `flex-start`.

## [0.2.1] - 2026-11-04

### Fixed

- End-aligned flex containers (`justify-content: flex-end`) push their excess above
  the scroll box, where nothing can scroll to it. Detected and re-aligned to
  `flex-start`, turning it into ordinary overflow.

## [0.2.0] - 2026-11-04

### Added

- `README.md`, MIT `LICENSE`, `.gitignore`, `dsh.engines`, keywords, `npm test`.
- `tests/harness.html` — dependency-free replica of the shell skeleton for browser
  verification of both the sidebar cap and the right column.

### Fixed

- The right column no longer forces `overflow-x: hidden`, so editors and terminals
  keep their horizontal scrolling.
- The injected `<style>` handle is per-`apply()` instead of a module-level
  singleton: a second load (HMR) can no longer silently disable the cap.
- Panel rows are matched with one same-tag/class sibling instead of two, so a setup
  with only one or two panels still works.
- MutationObserver watches the list subtree and the marker row, so re-renders are
  corrected immediately; polling dropped from 800ms to a 5s fallback.
- Right-column lookup is cached and invalidated on resize.

## [0.1.0] - 2026-11-04

### Added

- Sidebar panel list capped at N rows (default 4) and scrollable — the workspace
  tree is no longer pushed out of the window.
- Containers in the right column whose content is clipped become scrollable.
- Structural DOM anchoring: rows are found as "an ancestor with a same-tag+class
  sibling", the right column by geometry — no shell class name is hard-coded, so a
  CSS-module restyle does not break the plugin.
- `dsh-panel-scroll:rows` (1–20) and `dsh-panel-scroll:unclog` settings.

[Unreleased]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gusong1729/dsh-panel-scroll/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gusong1729/dsh-panel-scroll/releases/tag/v0.1.0
