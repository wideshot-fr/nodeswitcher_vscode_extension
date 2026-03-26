import * as vscode from 'vscode';

let error_panel: vscode.WebviewPanel | undefined;

const CLI_DETAIL_MAX_CHARS = 12_000;

export function truncate_cli_output(text: string, maxChars = CLI_DETAIL_MAX_CHARS): string {
	const t = text.trimEnd();
	if (t.length <= maxChars) {
		return t;
	}
	return `${t.slice(0, maxChars)}\n\n… (truncated)`;
}

function escape_html(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function build_webview_html(summary: string, detail: string): string {
	const s = escape_html(summary);
	const d = escape_html(detail);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
	<style>
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; line-height: 1.45; }
		h1 { font-size: 1.15em; font-weight: 600; margin: 0 0 12px 0; color: var(--vscode-errorForeground, var(--vscode-foreground)); }
		.summary { margin: 0 0 16px 0; opacity: 0.95; }
		pre.detail { margin: 0; padding: 12px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); overflow-x: auto; }
	</style>
</head>
<body>
	<h1>NodeSwitcher</h1>
	<p class="summary">${s}</p>
	<pre class="detail" tabindex="0">${d}</pre>
</body>
</html>`;
}

function preferred_column(): vscode.ViewColumn {
	return vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
}

export function show_nodeswitcher_error_panel(
	context: vscode.ExtensionContext,
	summary: string,
	detail: string
): void {
	const title = 'NodeSwitcher — Error';
	const column = preferred_column();
	const html = build_webview_html(summary, detail);
	if (error_panel) {
		error_panel.title = title;
		error_panel.webview.html = html;
		error_panel.reveal(column);
	} else {
		error_panel = vscode.window.createWebviewPanel(
			'nodeswitcherError',
			title,
			{ viewColumn: column, preserveFocus: false },
			{ enableScripts: false, retainContextWhenHidden: true }
		);
		error_panel.webview.html = html;
		error_panel.onDidDispose(() => {
			error_panel = undefined;
		});
		context.subscriptions.push(error_panel);
	}
	void vscode.window.showErrorMessage(summary);
}

export function report_nodeswitcher_failure(
	context: vscode.ExtensionContext,
	summary: string,
	err: unknown
): void {
	const detail =
		err instanceof Error ? err.stack ?? err.message : typeof err === 'string' ? err : String(err);
	show_nodeswitcher_error_panel(context, summary, truncate_cli_output(detail));
}
