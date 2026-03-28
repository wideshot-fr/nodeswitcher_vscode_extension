# NodeSwitcher (VS Code extension)

Open-source **Visual Studio Code** extension to **switch and install Node.js** from the **status bar** and **sidebar**, using the same tools you use in the terminal: [**n**](https://github.com/tj/n) / [**nvm-sh**](https://github.com/nvm-sh/nvm) on macOS, Linux, and Unix, and [**nvm-windows**](https://github.com/coreybutler/nvm-windows) on Windows.

**License:** [MIT](nodeswitcher/LICENSE).

**Repository:** [github.com/wideshot-fr/nodeswitcher_vscode_extension](https://github.com/wideshot-fr/nodeswitcher_vscode_extension)

## Layout

| Path | Purpose |
|------|---------|
| [`nodeswitcher/`](nodeswitcher/) | Extension source, `package.json`, build scripts, tests, and user-facing [README](nodeswitcher/README.md) |
| [`nodeswitcher/LICENSE`](nodeswitcher/LICENSE) | MIT license text |

The manifest’s `repository.directory` field is `nodeswitcher` so clones and tools know where the extension package lives.

## Documentation

- **Features, setup, commands, troubleshooting:** [nodeswitcher/README.md](nodeswitcher/README.md)
- **Release history:** [nodeswitcher/CHANGELOG.md](nodeswitcher/CHANGELOG.md)

## Quick start (from source)

```bash
cd nodeswitcher
npm install
npm run compile    # dev build
```

For a production build before packaging: `npm run build:release` (see the extension README). **Automated release** (version bump, changelog stub, VSIX under `publishBuild/`, commit, tag, push): `npm run release -- patch` from `nodeswitcher/` (see [nodeswitcher/README.md](nodeswitcher/README.md)). To publish to the Marketplace with a PAT, use [`vsce publish`](https://code.visualstudio.com/api/working-with-extensions/publishing-extension); otherwise upload the generated `.vsix` in the vendor UI.

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/wideshot-fr/nodeswitcher_vscode_extension). Please keep changes focused and match existing style in `nodeswitcher/src`.
