import * as vscode from 'vscode';
import {
	apply_nodeswitcher_status_bar_style,
	apply_nodeswitcher_status_bar_visibility,
	check_and_prompt_required_runtime,
	dispose_refresh_status_bar_debounce,
	initialize_status,
	open_version_picker,
	refresh_status_bar,
	repaint_status_bar_for_display_settings,
	retry_last_failed_node_switch,
	run_resolve_project_node_mismatch_command,
	STATUS_BAR_ICON
} from './node_backends';
import { open_remediation_webview } from './remediation_webview';
import { registerNodeSidebar } from './node_sidebar';

const switch_command_id = 'nodeswitcher.switchNodeVersion';
const refresh_command_id = 'nodeswitcher.refreshNodeVersions';

let status_item: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
	const priority = vscode.workspace.getConfiguration('nodeswitcher').get<number>('statusBarPriority', 1000);
	status_item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
	status_item.command = undefined;
	status_item.text = `$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — scanning project…`;
	status_item.tooltip = 'NodeSwitcher is scanning project Node declarations, then reading your active Node version…';
	apply_nodeswitcher_status_bar_style(status_item);
	apply_nodeswitcher_status_bar_visibility(status_item);
	context.subscriptions.push(status_item);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('nodeswitcher')) {
				return;
			}
			apply_nodeswitcher_status_bar_visibility(status_item);
			setTimeout(() => {
				apply_nodeswitcher_status_bar_visibility(status_item);
				const run = repaint_status_bar_for_display_settings(context, status_item);
				void run.catch(() => refresh_status_bar(context, status_item, true));
			}, 0);
		})
	);

	const node_sidebar = registerNodeSidebar(context, status_item);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.openExtensionSettings', async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(switch_command_id, async () => {
			await open_version_picker(context, status_item);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.openVersionPickerQuickPick', async () => {
			await open_version_picker(context, status_item);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(refresh_command_id, async () => {
			node_sidebar.invalidateVersionCache();
			await refresh_status_bar(context, status_item, true);
			vscode.window.showInformationMessage('NodeSwitcher refreshed versions.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.chooseProjectNodeMismatch', async () => {
			await run_resolve_project_node_mismatch_command(context, status_item);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.retryLastNodeSwitch', async () => {
			await retry_last_failed_node_switch(context, status_item);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.openRemediationPanel', async (err?: unknown, scenario?: unknown) => {
			const msg = typeof err === 'string' ? err : '';
			const scen =
				scenario === 'n_no_active' || scenario === 'permission' || scenario === 'general' ? scenario : 'general';
			open_remediation_webview(context, msg, scen);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.runInstallerRemediation', async () => {
			open_remediation_webview(context);
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) {
				void refresh_status_bar(context, status_item, false);
			}
		})
	);

	void (async () => {
		await check_and_prompt_required_runtime(context);
		try {
			await initialize_status(context, status_item);
		} finally {
			status_item.command = switch_command_id;
		}
	})();
}

export function deactivate(): void {
	dispose_refresh_status_bar_debounce();
}
