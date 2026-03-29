# Change Log

All notable changes to the "nodeswitcher" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Upcoming

- **Sidebar — version from `package.json`**: Detect or suggest the Node version the workspace needs by reading **`package.json`** (e.g. `engines.node`, and dependency-driven constraints where feasible), and surface that in the sidebar so you can align the active version quickly.

## [0.1.13] - 2026-03-29

- **Integrated terminals**: `PATH` / `N_PREFIX` mutators use **`applyAtShellIntegration`** as well as process creation so **already-open** terminals can pick up the switched Node when VS Code **shell integration** is enabled; success toast and README troubleshooting updated accordingly.
- **New terminal banner**: Opening a new integrated terminal prints `nodeswitcher: node.js v…` (from the active NodeSwitcher version); skipped for the **NodeSwitcher install** terminal. Removed the old yellow “previous Node version” warning on new terminals.

## [0.1.12] - 2026-03-29

- **Docs**: README **Screenshots** — removed the redundant line about hosted image URLs.

## [0.1.11] - 2026-03-29

- **Docs**: README **Contact** section adds the Wideshot logo (fixed display width), invites Marketplace **Q&A** and **ratings/reviews**, and notes that feedback is used to improve the extension.

## [0.1.10] - 2026-03-29

- **Docs**: README no longer shows the oversized top **logo** image; hero screenshot and section screenshots unchanged.

## [0.1.9] - 2026-03-29

- **Marketplace discoverability**: `displayName`, `description`, and `keywords` updated so the extension is easier to find for searches like **nvm**, **node version manager**, **node manager**, **nvm-windows**, **nvm-sh**, and **n**; README intro aligned with the same terms.

## [0.1.8] - 2026-03-29

- **Docs**: README uses hosted **PNG** marketing assets on S3 (`https://wideshot-land.s3.eu-west-3.amazonaws.com/nodeswitcher/`): logo, hero image, version picker, sidebar, project scan, and mismatch screenshots. Table of contents includes **Screenshots**; Requirements note matches **`engines.vscode`** `^1.105.0`.

## [0.1.7] - 2026-03-29

- **Status bar**: Keeps the version picker **clickable** after switches, refresh, loading states, and while the Quick Pick is open — `command` is re-bound whenever the item is repainted; picker no longer clears the tooltip to `undefined` (fixes missing pointer / dead clicks in VS Code / Cursor).
- **Picker (aligned / Windows layout)**: **Shorter rows** — version lines omit redundant multi-line `detail` when the label already shows version + release channel; footer and project-pin rows use compact one-line hints. Sidebar still uses full detail for tree hovers.
- **Terminals**: For **3 minutes** after you change Node from NodeSwitcher, **each new integrated terminal** prints a short reminder that it may still be on the **previous** Node (PowerShell `Write-Host` on Windows, `echo` elsewhere).

## [0.1.6] - 2026-03-29

- **nvm**: Switching between **already installed** versions no longer runs `nvm use`, so nvm’s global “current” symlink / default is not changed for every terminal on the machine.
- **PATH**: Node is resolved from the version install directory (`NVM_HOME\\v*\\node.exe` or nvm-sh `versions/node/...`) and prepended for **this workspace’s** integrated terminals only; removed clearing `PATH` on the extension’s unscoped environment collection.
- **UX**: Success message clarifies **new integrated terminals in this workspace**.

## [0.1.5] - 2026-03-29

- **Fix**: Version picker no longer uses the proposed `QuickPickItem.tooltip` API (which threw in normal VS Code / Cursor and left the dropdown stuck on “Loading…”). Row hints now use stable `QuickPickItem.detail` instead; sidebar tree hovers still show the same text.

## [0.1.4] - 2026-03-29

- **Fix**: Extension now loads correctly in Cursor and VS Code — engine requirement lowered from `^1.110.0` to `^1.95.0`.
- **Fix (Windows)**: Picker dropdown now loads installed versions almost instantly — nvm is called directly via `NVM_HOME/nvm.exe` instead of through PowerShell (38x faster).
- **Fix (Windows)**: Version list timeout reduced to 15 s (was 2 min) so failures surface quickly as an error instead of an indefinite spinner.

## [0.1.3] - 2026-03-28

- **What's New**: On update, a notification appears with a "What's New" button opening a changelog webview. Command palette: `NodeSwitcher: Show What's New`.
- **Picker**: Installed and other-available accordions are now mutually exclusive — opening one collapses the other automatically.
- **Picker**: Hovering a version row shows a compact tooltip with release channel (Current / Active LTS / Maintenance LTS / EOL) when known.
- **Picker load on Windows**: Fixed spinner stuck on "Loading installed versions" — release index fetch no longer blocks the picker from rendering.
- **Mismatch UX**: On project version mismatch, a one-time notification offers "Switch to project version" or "Open picker" without spamming every refresh.
- **Mismatch UX**: Status bar mismatch wording is now plain English (e.g. "Node 22 differs from project (>=24)").
- **Picker blue row**: "Project Node version" row now reads "Click to switch to project node version".
- **Release labels**: Other available versions no longer show fake Current/LTS labels — tags come from real lifecycle dates (endoflife.date API).

## [0.1.2] - 2026-03-28

- **Docs**: README hero image uses hosted **PNG** (`readme-logo.png`); `@vscode/vsce` rejects SVG in README for Marketplace packaging.
- **Tooling**: `publish:vsix` / `release` scripts; root `README`; `LICENSE` (Wideshot, Roman MERCK); `AGENTS.md` gitignored.

## [0.1.1]

- **Repository**: Canonical GitHub URL is [wideshot-fr/nodeswitcher_vscode_extension](https://github.com/wideshot-fr/nodeswitcher_vscode_extension); `package.json` `repository.url` and documentation updated for Marketplace / `vsce` link resolution.
- **Docs**: Added a root-level [README](../README.md) for the monorepo layout and links to `nodeswitcher/`; contributing / clone hints point at the org repo.
- **Meta**: MIT `LICENSE` copyright holder set to **wideshot-fr**; `.gitignore` ignores `publishBuild/` and `publishedBuild/` under `nodeswitcher/`.

## [0.1.0]

- **Build**: Added `npm run build:release` (`readme:logo` → `icons:build` → production `package`); `vscode:prepublish` delegates to it so local release builds and `vsce package` / `vsce publish` share one pipeline.
- **Docs**: README Development section documents `build:release` next to compile, lint, and package.

## [0.0.3]

- **Docs**: Added a **Roadmap and platform testing** section to the README (macOS Sequoia vs legacy, Linux and Windows coverage, planned improvements).

## [0.0.2]

- **Marketplace / Extensions UI icon**: `package.json` `icon` points to `media/extension-icon.png` (128×128 PNG exported from the green `logo.svg`) so the store listing and in-app extension identity show the branded mark.
- **README**: Hero image uses `media/readme-logo.png` because the VS Code Marketplace packaging pipeline does not allow SVG in the README; both PNGs are regenerated by `npm run readme:logo` (also part of `vscode:prepublish`).
- **In-editor branding**: Activity bar and views keep `media/logo.svg` (gradient). The status bar uses `media/logo-status-glyph.svg` (`currentColor`) for the font glyph so it stays a clean light icon on the colored status bar.

## [0.0.1]

- Initial release