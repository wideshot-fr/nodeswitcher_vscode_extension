import * as path from 'path';
import * as vscode from 'vscode';
import { report_nodeswitcher_failure } from './error_panel';
import {
	list_candidate_install_roots,
	node_version_display_v,
	NodeBackend,
	refresh_status_bar,
	resolve_installed_node_executable,
	uninstall_node_version,
	VersionEntry
} from './node_backends';
import { normalize_version } from './version_utils';

function install_root_from_executable(exe: string): string {
	const dir = path.dirname(exe);
	return path.basename(dir) === 'bin' ? path.dirname(dir) : dir;
}

export async function show_version_install_details(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	invalidate_sidebar_lists: () => void,
	backend: NodeBackend,
	entry: VersionEntry
): Promise<void> {
	const v = normalize_version(entry.version);
	const exe =
		entry.is_installed || entry.is_current
			? await resolve_installed_node_executable(backend, entry.version)
			: undefined;
	const roots = list_candidate_install_roots(backend, entry.version);
	const folder = exe ? install_root_from_executable(exe) : roots[0];

	const lines = [
		`Node ${node_version_display_v(entry.version)}`,
		'',
		`Executable: ${exe ?? '(not installed locally)'}`,
		`Install folder: ${folder ?? '(unknown)'}`
	];
	if (entry.is_current) {
		lines.push('', 'Switch to another version before uninstalling this one.');
	}
	if (!entry.is_installed && roots.length > 0) {
		lines.push('', `If you install this version, it will use: ${roots[0]}`);
	}

	const can_uninstall = entry.is_installed && !entry.is_current;
	const actions = ['Copy executable path', 'Copy install folder'];
	if (can_uninstall) {
		actions.push('Uninstall…');
	}
	const choice = await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, ...actions, 'Close');

	if (choice === 'Copy executable path') {
		if (exe) {
			await vscode.env.clipboard.writeText(exe);
		} else {
			vscode.window.showWarningMessage('No executable path (version not installed locally).');
		}
		return;
	}
	if (choice === 'Copy install folder') {
		if (folder) {
			await vscode.env.clipboard.writeText(folder);
		} else {
			report_nodeswitcher_failure(
				context,
				'No install folder to copy.',
				'Could not resolve an install directory for this version on this machine.'
			);
		}
		return;
	}
	if (choice === 'Uninstall…') {
		const ok = await vscode.window.showWarningMessage(
			`Remove Node ${v} from this machine?`,
			{ modal: true },
			'Uninstall'
		);
		if (ok !== 'Uninstall') {
			return;
		}
		try {
			await uninstall_node_version(backend, entry.version);
			invalidate_sidebar_lists();
			await refresh_status_bar(context, status_item, true);
			vscode.window.showInformationMessage(`Node ${v} was uninstalled.`);
		} catch (error) {
			report_nodeswitcher_failure(context, 'NodeSwitcher uninstall failed.', error);
		}
	}
}
