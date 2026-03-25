import * as vscode from 'vscode';
import {
	apply_nodeswitcher_status_bar_style,
	apply_nodeswitcher_status_bar_visibility,
	check_and_prompt_required_runtime,
	initialize_status,
	is_project_node_version_mismatch,
	open_version_picker,
	refresh_status_bar,
	run_resolve_project_node_mismatch_command,
	STATUS_BAR_ICON
} from './node_backends';
import { registerNodeSidebar } from './node_sidebar';

const switch_command_id = 'nodeswitcher.switchNodeVersion';
const refresh_command_id = 'nodeswitcher.refreshNodeVersions';

let status_item: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
	const priority = vscode.workspace.getConfiguration('nodeswitcher').get<number>('statusBarPriority', 1000);
	status_item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
	status_item.command = undefined;
	status_item.text = `$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher - Analyzing Node.js version`;
	status_item.tooltip = 'NodeSwitcher is analyzing your current Node version...';
	apply_nodeswitcher_status_bar_style(status_item);
	apply_nodeswitcher_status_bar_visibility(status_item);
	context.subscriptions.push(status_item);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('nodeswitcher')) {
				return;
			}
			apply_nodeswitcher_status_bar_visibility(status_item);
			if (e.affectsConfiguration('nodeswitcher.backendPreference')) {
				void refresh_status_bar(context, status_item, true);
			}
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
			let mismatch = false;
			try {
				mismatch = await is_project_node_version_mismatch(context);
			} catch {
				mismatch = false;
			}
			if (mismatch) {
				await open_version_picker(context, status_item);
				return;
			}
			await vscode.commands.executeCommand('workbench.view.extension.nodeswitcher-sidebar');
			node_sidebar.on_status_bar_clicked();
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
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) {
				void refresh_status_bar(context, status_item, false);
			}
		})
	);

	void (async () => {
		try {
			await initialize_status(context, status_item);
		} finally {
			status_item.command = switch_command_id;
		}
		await check_and_prompt_required_runtime(context);
	})();
}

export function deactivate() {}
