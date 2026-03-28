import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const LAST_SEEN_VERSION_KEY = 'nodeswitcher.lastSeenVersion';

let changelog_panel: vscode.WebviewPanel | undefined;

function escape_html(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function markdown_to_html(md: string): string {
	const lines = md.split('\n');
	const html: string[] = [];
	let in_list = false;

	for (const raw of lines) {
		const line = raw.trimEnd();

		if (line.startsWith('## ')) {
			if (in_list) {
				html.push('</ul>');
				in_list = false;
			}
			const title = escape_html(line.slice(3));
			html.push(`<h2>${title}</h2>`);
			continue;
		}

		if (line.startsWith('# ')) {
			if (in_list) {
				html.push('</ul>');
				in_list = false;
			}
			const title = escape_html(line.slice(2));
			html.push(`<h1>${title}</h1>`);
			continue;
		}

		if (line.startsWith('- ')) {
			if (!in_list) {
				html.push('<ul>');
				in_list = true;
			}
			const content = render_inline(escape_html(line.slice(2)));
			html.push(`<li>${content}</li>`);
			continue;
		}

		if (line.trim() === '') {
			if (in_list) {
				html.push('</ul>');
				in_list = false;
			}
			continue;
		}

		if (in_list) {
			html.push('</ul>');
			in_list = false;
		}
		html.push(`<p>${render_inline(escape_html(line))}</p>`);
	}

	if (in_list) {
		html.push('</ul>');
	}

	return html.join('\n');
}

function render_inline(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '<em>$1</em>');
}

function build_changelog_html(webview: vscode.Webview, body_html: string, version: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			margin: 0;
			padding: 20px 28px 40px;
			line-height: 1.55;
			max-width: 760px;
		}
		.header {
			display: flex;
			align-items: baseline;
			gap: 10px;
			margin-bottom: 4px;
		}
		.header h1 {
			margin: 0;
			font-size: 1.4em;
			font-weight: 700;
		}
		.version-badge {
			background: var(--vscode-badge-background, #007ACC);
			color: var(--vscode-badge-foreground, #fff);
			border-radius: 3px;
			padding: 1px 7px;
			font-size: 0.78em;
			font-weight: 600;
			letter-spacing: 0.03em;
		}
		.subtitle {
			color: var(--vscode-descriptionForeground);
			font-size: 0.88em;
			margin: 0 0 24px 0;
		}
		h1 { font-size: 1.15em; font-weight: 700; margin: 24px 0 6px; }
		h2 {
			font-size: 1em;
			font-weight: 700;
			margin: 24px 0 8px;
			padding-bottom: 4px;
			border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
			color: var(--vscode-foreground);
		}
		ul { margin: 0 0 4px 0; padding-left: 20px; }
		li { margin: 3px 0; }
		p { margin: 6px 0; }
		strong { color: var(--vscode-foreground); }
		code {
			font-family: var(--vscode-editor-font-family);
			font-size: 0.92em;
			background: var(--vscode-textCodeBlock-background);
			border-radius: 3px;
			padding: 1px 4px;
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>NodeSwitcher</h1>
		<span class="version-badge">v${escape_html(version)}</span>
	</div>
	<p class="subtitle">What changed in this update</p>
	${body_html}
</body>
</html>`;
}

export function show_changelog_webview(context: vscode.ExtensionContext): void {
	const version = context.extension.packageJSON.version as string ?? '';
	const changelog_path = path.join(context.extensionPath, 'CHANGELOG.md');
	let md = '';
	try {
		md = fs.readFileSync(changelog_path, 'utf8');
	} catch {
		md = `## v${version}\n\nChangelog not available.`;
	}

	const body_html = markdown_to_html(md);
	const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

	if (changelog_panel) {
		changelog_panel.title = `NodeSwitcher — What's New`;
		changelog_panel.webview.html = build_changelog_html(changelog_panel.webview, body_html, version);
		changelog_panel.reveal(column, true);
		return;
	}

	changelog_panel = vscode.window.createWebviewPanel(
		'nodeswitcherChangelog',
		`NodeSwitcher — What's New`,
		{ viewColumn: column, preserveFocus: true },
		{ enableScripts: false, retainContextWhenHidden: true }
	);
	changelog_panel.webview.html = build_changelog_html(changelog_panel.webview, body_html, version);
	changelog_panel.onDidDispose(() => {
		changelog_panel = undefined;
	});
	context.subscriptions.push(changelog_panel);
}

export function maybe_show_changelog_on_update(context: vscode.ExtensionContext): void {
	const current_version: string = context.extension.packageJSON.version ?? '';
	const last_seen = context.globalState.get<string>(LAST_SEEN_VERSION_KEY);
	if (last_seen === current_version) {
		return;
	}
	void context.globalState.update(LAST_SEEN_VERSION_KEY, current_version);
	if (!last_seen) {
		return;
	}
	void vscode.window
		.showInformationMessage(
			`NodeSwitcher updated to v${current_version}.`,
			"What's New"
		)
		.then((choice) => {
			if (choice === "What's New") {
				show_changelog_webview(context);
			}
		});
}
