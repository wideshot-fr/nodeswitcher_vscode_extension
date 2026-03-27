import * as vscode from 'vscode';
import {
	get_ordered_installer_remediation_steps,
	get_runtime_snapshot_cached,
	get_saved_installer_remediation_method,
	installer_remediation_step_label,
	poll_until_n_has_active_node,
	reveal_nodeswitcher_install_terminal,
	run_chained_installer_remediation,
	run_single_installer_remediation_step,
	send_text_in_nodeswitcher_install_terminal,
	type InstallerRemediationMethod
} from './node_backends';

const NVM_SH_DOC = 'https://github.com/nvm-sh/nvm';

let panel: vscode.WebviewPanel | undefined;
let chain_cts: vscode.CancellationTokenSource | undefined;
let single_cts: vscode.CancellationTokenSource | undefined;
export type RemediationPanelScenario = 'general' | 'n_no_active' | 'permission';

let pending_remediation_error = '';
let pending_remediation_scenario: RemediationPanelScenario = 'general';
let remediation_panel_state: { error: string; scenario: RemediationPanelScenario } = {
	error: '',
	scenario: 'general'
};

function remediation_html(csp_source: string, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp_source} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<title>NodeSwitcher repair</title>
	<style>
		body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; max-width: 720px; }
		h1 { font-size: 1.25em; font-weight: 600; margin: 0 0 12px; }
		.muted { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-bottom: 16px; }
		.err { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 10px; border-radius: 4px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px; margin-bottom: 16px; max-height: 160px; overflow: auto; }
		.row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
		button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 14px; cursor: pointer; border-radius: 2px; font-size: var(--vscode-font-size); }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		button:disabled { opacity: 0.45; cursor: not-allowed; }
		#log { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); padding: 10px; border-radius: 4px; min-height: 200px; max-height: 360px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
		.log-ok { color: var(--vscode-testing-iconPassed); }
		.log-fail { color: var(--vscode-errorForeground); }
		.log-info { color: var(--vscode-descriptionForeground); }
		.steps { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
		.step-btn { text-align: left; }
		.badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
		.no-active-box { margin-bottom: 16px; padding: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
	</style>
</head>
<body>
	<h1>NodeSwitcher installer repair</h1>
	<p class="muted">Runs fixes for <code>n</code> / <code>nvm</code> on macOS and Linux. The automatic chain tries each step until <code>n ls</code> or <code>nvm</code> works. Your last successful method is remembered for next time.</p>
	<div id="noActiveSection" class="no-active-box" style="display:none;">
		<p class="muted" style="margin:0 0 10px">n is installed but no default Node is active.</p>
		<div class="row" style="margin-bottom:0">
			<button id="btnNLts">Run <code>n lts</code> in install terminal</button>
			<button class="secondary" id="btnNPoll">Poll until active Node</button>
			<button class="secondary" id="btnNPicker">Open version picker</button>
		</div>
	</div>
	<div id="errorBox" class="err" style="display:none;"></div>
	<p><span class="badge" id="platformBadge"></span> <span class="muted" id="savedLine"></span></p>
	<p class="muted">nodeswitcher.nPrefix: <code id="nPrefixVal"></code></p>
	<div class="row">
		<button id="btnChain">Run automatic repair chain</button>
		<button class="secondary" id="btnCancel" disabled>Cancel running repair</button>
	</div>
	<div class="row">
		<button class="secondary" id="btnTerminal">Show NodeSwitcher install terminal</button>
		<button class="secondary" id="btnSettings">Open nPrefix setting</button>
		<button class="secondary" id="btnNvmDoc">Open nvm docs</button>
	</div>
	<div class="row">
		<button class="secondary" id="btnRetry">Retry last Node switch</button>
		<button class="secondary" id="btnPicker">Open version picker</button>
	</div>
	<p class="muted">Run one step only (waits/polls like the chain):</p>
	<div class="steps" id="stepButtons"></div>
	<h2 style="font-size:1em;margin:20px 0 8px">Activity</h2>
	<div id="log"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const logEl = document.getElementById('log');
		const errorBox = document.getElementById('errorBox');
		const stepButtons = document.getElementById('stepButtons');
		function log(line, cls) {
			const d = document.createElement('div');
			d.className = cls || 'log-info';
			d.textContent = line;
			logEl.appendChild(d);
			logEl.scrollTop = logEl.scrollHeight;
		}
		document.getElementById('btnChain').addEventListener('click', () => {
			log('Starting automatic repair chain…', 'log-info');
			vscode.postMessage({ type: 'runChain' });
		});
		document.getElementById('btnCancel').addEventListener('click', () => vscode.postMessage({ type: 'cancelChain' }));
		document.getElementById('btnTerminal').addEventListener('click', () => vscode.postMessage({ type: 'revealTerminal' }));
		document.getElementById('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
		document.getElementById('btnNvmDoc').addEventListener('click', () => vscode.postMessage({ type: 'openNvmDoc' }));
		document.getElementById('btnRetry').addEventListener('click', () => vscode.postMessage({ type: 'retryLast' }));
		document.getElementById('btnPicker').addEventListener('click', () => vscode.postMessage({ type: 'openPicker' }));
		document.getElementById('btnNLts').addEventListener('click', () => {
			log('Sending n lts to NodeSwitcher install terminal…', 'log-info');
			vscode.postMessage({ type: 'runNLts' });
		});
		document.getElementById('btnNPoll').addEventListener('click', () => {
			vscode.postMessage({ type: 'pollNActive' });
		});
		document.getElementById('btnNPicker').addEventListener('click', () => vscode.postMessage({ type: 'openPicker' }));
		window.addEventListener('message', (e) => {
			const m = e.data;
			if (m.type === 'init') {
				const noActive = document.getElementById('noActiveSection');
				noActive.style.display = m.scenario === 'n_no_active' ? 'block' : 'none';
				document.getElementById('platformBadge').textContent = m.platform;
				document.getElementById('savedLine').textContent = m.savedMethod
					? 'Preferred fix: ' + m.savedMethod
					: 'No preferred fix saved yet';
				document.getElementById('nPrefixVal').textContent = m.nPrefix || '(empty — default /usr/local)';
				if (m.errorText) {
					errorBox.style.display = 'block';
					errorBox.textContent = m.errorText;
				} else {
					errorBox.style.display = 'none';
				}
				stepButtons.innerHTML = '';
				(m.steps || []).forEach((s) => {
					const b = document.createElement('button');
					b.className = 'secondary step-btn';
					b.textContent = s.label;
					b.addEventListener('click', () => {
						log('Running single step: ' + s.label, 'log-info');
						vscode.postMessage({ type: 'runStep', step: s.id });
					});
					stepButtons.appendChild(b);
				});
			}
			if (m.type === 'step') {
				log('Step ' + m.i + '/' + m.t + ': ' + m.label, 'log-info');
			}
			if (m.type === 'stepEnd') {
				log('  → ' + (m.ok ? 'OK' : 'no change yet'), m.ok ? 'log-ok' : 'log-fail');
			}
			if (m.type === 'done') {
				document.getElementById('btnCancel').disabled = true;
				if (m.outcome === 'success') {
					log('Done: success (' + (m.method || '') + '). Check notification for retry options.', 'log-ok');
				} else if (m.outcome === 'cancelled') {
					log('Cancelled.', 'log-fail');
				} else {
					log('Chain finished without fixing n/nvm. Try another step or install outside VS Code.', 'log-fail');
				}
			}
			if (m.type === 'chainRunning') {
				document.getElementById('btnCancel').disabled = !m.running;
			}
			if (m.type === 'singleDone') {
				log(m.ok ? 'Single step succeeded.' : 'Single step did not pass checks yet (see terminal / try sudo steps).', m.ok ? 'log-ok' : 'log-fail');
			}
			if (m.type === 'nActivePoll') {
				if (m.status === 'polling') {
					log('Polling until n reports an active Node (up to ~5 min, every 2s)…', 'log-info');
				} else if (m.status === 'ok') {
					log('Active Node detected. Retry last switch or pick a version again.', 'log-ok');
				} else if (m.status === 'timeout') {
					log('Still no active Node. Run n lts in the terminal or use the repair steps / nPrefix below.', 'log-fail');
				}
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}

async function post_init(
	panel_ref: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	error_text: string,
	scenario: RemediationPanelScenario
): Promise<void> {
	remediation_panel_state = { error: error_text, scenario };
	if (process.platform === 'win32') {
		panel_ref.webview.postMessage({
			type: 'init',
			platform: 'win32',
			steps: [],
			savedMethod: '',
			nPrefix: '',
			errorText: 'Installer repair applies to macOS and Linux only.',
			scenario: 'general'
		});
		return;
	}
	const snap = await get_runtime_snapshot_cached(context, false).catch(() => null);
	const platform_has_brew = process.platform === 'darwin' || snap?.has_brew === true;
	const saved = get_saved_installer_remediation_method(context);
	const steps = get_ordered_installer_remediation_steps(saved, platform_has_brew);
	const n_prefix = vscode.workspace.getConfiguration('nodeswitcher').get<string>('nPrefix', '') ?? '';
	panel_ref.webview.postMessage({
		type: 'init',
		platform: process.platform,
		steps: steps.map((id) => ({ id, label: installer_remediation_step_label(id) })),
		savedMethod: saved ?? '',
		nPrefix: n_prefix,
		errorText: error_text,
		scenario
	});
}

export function open_remediation_webview(
	context: vscode.ExtensionContext,
	error_text = '',
	scenario: RemediationPanelScenario = 'general'
): void {
	pending_remediation_error = error_text;
	pending_remediation_scenario = scenario;
	const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
	if (panel) {
		panel.reveal(column);
		void post_init(panel, context, error_text, scenario);
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'nodeswitcher.remediation',
		'NodeSwitcher: installer repair',
		{ viewColumn: column, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	const nonce = String(Date.now()) + String(Math.random());
	panel.webview.html = remediation_html(panel.webview.cspSource, nonce);
	const sub = panel.webview.onDidReceiveMessage((msg: { type: string; step?: InstallerRemediationMethod }) => {
		void handle_message(context, msg);
	});
	panel.onDidDispose(() => {
		sub.dispose();
		chain_cts?.cancel();
		chain_cts?.dispose();
		chain_cts = undefined;
		single_cts?.cancel();
		single_cts?.dispose();
		single_cts = undefined;
		panel = undefined;
	});
}

async function handle_message(context: vscode.ExtensionContext, msg: { type: string; step?: InstallerRemediationMethod }): Promise<void> {
	const w = panel?.webview;
	if (!w) {
		return;
	}
	switch (msg.type) {
		case 'ready': {
			const err = pending_remediation_error;
			const scen = pending_remediation_scenario;
			pending_remediation_error = '';
			pending_remediation_scenario = 'general';
			await post_init(panel!, context, err, scen);
			return;
		}
		case 'runChain': {
			chain_cts?.cancel();
			chain_cts?.dispose();
			chain_cts = new vscode.CancellationTokenSource();
			w.postMessage({ type: 'chainRunning', running: true });
			try {
				await run_chained_installer_remediation(context, {
					token: chain_cts.token,
					reporter: {
						onStep: (i, t, step, label) => w.postMessage({ type: 'step', i, t, step, label }),
						onStepEnd: (step, ok) => w.postMessage({ type: 'stepEnd', step, ok }),
						onDone: (outcome, method) => {
							w.postMessage({ type: 'done', outcome, method });
							w.postMessage({ type: 'chainRunning', running: false });
							chain_cts?.dispose();
							chain_cts = undefined;
						}
					}
				});
			} finally {
				w.postMessage({ type: 'chainRunning', running: false });
			}
			void post_init(panel!, context, '', 'general');
			return;
		}
		case 'cancelChain':
			chain_cts?.cancel();
			w.postMessage({ type: 'chainRunning', running: false });
			return;
		case 'runStep': {
			if (!msg.step || process.platform === 'win32') {
				return;
			}
			single_cts?.cancel();
			single_cts?.dispose();
			single_cts = new vscode.CancellationTokenSource();
			const ok = await run_single_installer_remediation_step(context, msg.step, single_cts.token);
			w.postMessage({ type: 'singleDone', ok });
			single_cts.dispose();
			single_cts = undefined;
			void post_init(panel!, context, '', 'general');
			return;
		}
		case 'runNLts': {
			send_text_in_nodeswitcher_install_terminal('n lts', true);
			return;
		}
		case 'pollNActive': {
			if (process.platform === 'win32') {
				return;
			}
			w.postMessage({ type: 'nActivePoll', status: 'polling' });
			const poll_cts = new vscode.CancellationTokenSource();
			let ok: boolean;
			try {
				ok = await poll_until_n_has_active_node(poll_cts.token);
			} finally {
				poll_cts.dispose();
			}
			w.postMessage({ type: 'nActivePoll', status: ok ? 'ok' : 'timeout' });
			void post_init(
				panel!,
				context,
				remediation_panel_state.error,
				remediation_panel_state.scenario
			);
			return;
		}
		case 'revealTerminal':
			reveal_nodeswitcher_install_terminal();
			return;
		case 'openSettings':
			await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id} nPrefix`);
			return;
		case 'openNvmDoc':
			await vscode.env.openExternal(vscode.Uri.parse(NVM_SH_DOC));
			return;
		case 'retryLast':
			await vscode.commands.executeCommand('nodeswitcher.retryLastNodeSwitch');
			return;
		case 'openPicker':
			await vscode.commands.executeCommand('nodeswitcher.openVersionPickerQuickPick');
			return;
		default:
			return;
	}
}
