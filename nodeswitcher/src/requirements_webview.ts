import * as vscode from 'vscode';

const REQUIREMENTS_WEBVIEW_SHOWN_KEY = 'nodeswitcher.requirementsWebviewShown';

const NVM_WINDOWS_RELEASES = 'https://github.com/coreybutler/nvm-windows/releases';
const N_GITHUB = 'https://github.com/tj/n';
const NVM_SH_GITHUB = 'https://github.com/nvm-sh/nvm';

let requirements_panel: vscode.WebviewPanel | undefined;

function preferred_column(): vscode.ViewColumn {
	return vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
}

function build_requirements_html(csp_source: string, nonce: string, platform: NodeJS.Platform): string {
	const win_block =
		platform === 'win32'
			? `<section>
	<h2>Windows</h2>
	<ul>
		<li><strong>nvm-windows</strong> must be installed and on your PATH when VS Code starts.</li>
		<li>NodeSwitcher does <strong>not</strong> use nvm-sh or the <code>n</code> tool on Windows.</li>
	</ul>
	<p><button type="button" class="link" data-url="${NVM_WINDOWS_RELEASES}">Open nvm-windows releases</button></p>
</section>`
			: '';

	const unix_block =
		platform !== 'win32'
			? `<section>
	<h2>${platform === 'darwin' ? 'macOS' : 'Linux / Unix'}</h2>
	<ul>
		<li>Install <strong>n</strong> (e.g. <code>brew install n</code> on macOS, or <code>npm install -g n</code>) <em>or</em> install <strong>nvm-sh</strong>.</li>
		<li>When both <code>n</code> and nvm are present, NodeSwitcher prefers <code>n</code>.</li>
		<li>If <code>n</code> fails with permission errors under <code>/usr/local/n</code>, set the <code>nodeswitcher.nPrefix</code> setting to a folder under your home directory (same idea as <code>N_PREFIX</code>).</li>
	</ul>
	<p>
		<button type="button" class="link" data-url="${N_GITHUB}">n (tj/n) on GitHub</button>
		<button type="button" class="link" data-url="${NVM_SH_GITHUB}">nvm-sh on GitHub</button>
	</p>
</section>`
			: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp_source} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<title>NodeSwitcher requirements</title>
	<style>
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; line-height: 1.5; max-width: 640px; }
		h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 8px 0; }
		.lead { margin: 0 0 20px 0; color: var(--vscode-descriptionForeground); }
		h2 { font-size: 1.05em; font-weight: 600; margin: 20px 0 10px 0; }
		ul { margin: 0 0 12px 0; padding-left: 1.25em; }
		li { margin: 6px 0; }
		code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
		.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
		button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; border-radius: 2px; font-size: var(--vscode-font-size); }
		button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; padding: 0; font-size: var(--vscode-font-size); font-family: inherit; margin-right: 12px; }
		.foot { margin-top: 24px; font-size: 0.92em; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<h1>NodeSwitcher is installed</h1>
	<p class="lead">Install the tooling below on this machine so you can switch Node versions from the status bar. You can reopen this panel anytime from the Command Palette: <strong>NodeSwitcher: Show install requirements</strong>.</p>
	${win_block}
	${unix_block}
	<div class="row">
		<button type="button" class="primary" id="gotIt">Got it</button>
	</div>
	<p class="foot">After installing, reload the VS Code window if NodeSwitcher still cannot find your version manager.</p>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('gotIt').addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			vscode.postMessage({ type: 'gotIt' });
		});
		document.body.addEventListener('click', (e) => {
			const el = e.target;
			if (el && el.dataset && el.dataset.url) {
				e.preventDefault();
				vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
			}
		});
	</script>
</body>
</html>`;
}

function open_requirements_panel(context: vscode.ExtensionContext, mark_seen_on_dispose: boolean): void {
	const column = preferred_column();
	const platform = process.platform;

	const apply_html = (panel: vscode.WebviewPanel): void => {
		const nonce = String(Date.now()) + String(Math.random());
		panel.webview.html = build_requirements_html(panel.webview.cspSource, nonce, platform);
	};

	if (requirements_panel) {
		apply_html(requirements_panel);
		requirements_panel.reveal(column);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'nodeswitcherRequirements',
		'NodeSwitcher — What you need',
		{ viewColumn: column, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	requirements_panel = panel;

	const sub = panel.webview.onDidReceiveMessage(async (msg: { type?: string; url?: string }) => {
		if (msg?.type === 'openUrl' && msg.url) {
			await vscode.env.openExternal(vscode.Uri.parse(msg.url));
			return;
		}
		if (msg?.type === 'gotIt') {
			queueMicrotask(() => {
				panel.dispose();
			});
		}
	});

	panel.onDidDispose(() => {
		sub.dispose();
		requirements_panel = undefined;
		if (mark_seen_on_dispose) {
			void context.globalState.update(REQUIREMENTS_WEBVIEW_SHOWN_KEY, true);
		}
	});

	context.subscriptions.push(panel);
	apply_html(panel);
}

export function maybe_show_install_requirements_webview(context: vscode.ExtensionContext): void {
	if (context.globalState.get<boolean>(REQUIREMENTS_WEBVIEW_SHOWN_KEY) === true) {
		return;
	}
	open_requirements_panel(context, true);
}

export function show_install_requirements_webview(context: vscode.ExtensionContext): void {
	open_requirements_panel(context, false);
}
