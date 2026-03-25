import * as path from 'path';
import * as vscode from 'vscode';
import {
	apply_picked_version_entry,
	BACKEND_STATE_KEY,
	build_version_picker_items,
	get_project_pinned_from_disk,
	get_versions_with_available,
	InstallPhase,
	load_switcher_picker_entries,
	node_version_display_v,
	NodeBackend,
	NodePickerItem,
	OPEN_SIDEBAR_COMMAND_ID,
	set_after_status_paint,
	VERSION_STATE_KEY,
	VersionEntry
} from './node_backends';
import { show_version_install_details } from './sidebar_version_details';
import { get_node_release_channels } from './node_release_index';
import { normalize_version, resolve_version_logo_filename } from './version_utils';

function strip_footer_quickpick_padding(text: string): string {
	return text.replace(/\u2007/g, '');
}

export type SidebarElement =
	| { kind: 'switch_parent' }
	| { kind: 'refresh' }
	| { kind: 'resolve'; pin: string; active_version: string }
	| {
			kind: 'version';
			backend: NodeBackend;
			entry: VersionEntry;
			role: 'current' | 'installed' | 'available';
			label: string;
			description?: string;
			tooltip?: string;
	  }
	| { kind: 'toggle_available'; backend: NodeBackend; label: string; description?: string; tooltip?: string }
	| { kind: 'open_settings'; label: string; description?: string; tooltip?: string }
	| {
			kind: 'switch_to_project';
			backend: NodeBackend;
			entry: VersionEntry;
			label: string;
			description?: string;
			tooltip?: string;
	  }
	| { kind: 'load_error'; message: string }
	| { kind: 'skeleton'; slot: number };

const SWITCH_LIST_SKELETON_COUNT = 6;

export class NodeSidebarProvider implements vscode.TreeDataProvider<SidebarElement> {
	private readonly el_switch_parent: SidebarElement = { kind: 'switch_parent' };
	private readonly el_refresh: SidebarElement = { kind: 'refresh' };
	private readonly el_skeleton_rows: SidebarElement[] = Array.from({ length: SWITCH_LIST_SKELETON_COUNT }, (_, slot) => ({
		kind: 'skeleton' as const,
		slot
	}));

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarElement | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private switchChildrenCache: VersionEntry[] | null = null;
	private switchBackend: NodeBackend | null = null;
	private switchIncludeAvailable = false;
	private switch_list_load_generation = 0;
	private switch_list_load_in_flight = false;
	private switch_list_load_error: string | undefined;

	private view: vscode.TreeView<SidebarElement> | undefined;

	private install_progress: { version: string; phase: InstallPhase } | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	setInstallProgress(version: string, phase: InstallPhase): void {
		this.install_progress = { version: normalize_version(version) || version, phase };
		this.refresh();
	}

	clearInstallProgress(): void {
		this.install_progress = undefined;
		this.invalidateVersionCache();
		this.refresh();
	}

	setTreeView(view: vscode.TreeView<SidebarElement>): void {
		this.view = view;
		this.updateViewTitle();
		if (view.visible) {
			this.schedule_reveal_switch_parent_expanded(view);
		}
	}

	schedule_reveal_switch_parent_expanded(view: vscode.TreeView<SidebarElement>): void {
		queueMicrotask(() => {
			void view.reveal(this.el_switch_parent, { expand: true, focus: false });
		});
	}

	getParent(element: SidebarElement): vscode.ProviderResult<SidebarElement> {
		if (
			element.kind === 'switch_parent' ||
			element.kind === 'refresh' ||
			element.kind === 'resolve'
		) {
			return undefined;
		}
		return this.el_switch_parent;
	}

	invalidateVersionCache(): void {
		this.switch_list_load_generation++;
		this.switchChildrenCache = null;
		this.switchBackend = null;
		this.switchIncludeAvailable = false;
		this.switch_list_load_error = undefined;
		this.switch_list_load_in_flight = false;
	}

	on_status_bar_clicked(): void {
		this.invalidateVersionCache();
		this.refresh();
		if (this.view) {
			this.schedule_reveal_switch_parent_expanded(this.view);
		}
	}

	refresh(): void {
		this.updateViewTitle();
		this._onDidChangeTreeData.fire();
	}

	private updateViewTitle(): void {
		if (!this.view) {
			return;
		}
		const version = this.context.workspaceState.get<string>(VERSION_STATE_KEY);
		const backend = this.context.workspaceState.get<NodeBackend>(BACKEND_STATE_KEY);
		this.view.title = 'NODESWITCHER';
		if (version && backend) {
			const trimmed = version.trim();
			this.view.description = /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
		} else {
			this.view.description = '…';
		}
	}

	getTreeItem(element: SidebarElement): vscode.TreeItem {
		switch (element.kind) {
			case 'switch_parent': {
				const item = new vscode.TreeItem('Switch Node version', vscode.TreeItemCollapsibleState.Collapsed);
				item.iconPath = new vscode.ThemeIcon('list-flat');
				return item;
			}
			case 'refresh': {
				const item = new vscode.TreeItem('Refresh version list', vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('refresh');
				item.command = { command: 'nodeswitcher.refreshNodeVersions', title: 'Refresh version list' };
				return item;
			}
			case 'resolve': {
				const item = new vscode.TreeItem('Resolve project mismatch', vscode.TreeItemCollapsibleState.None);
				item.description = element.pin;
				item.iconPath = new vscode.ThemeIcon('warning');
				item.command = { command: 'nodeswitcher.chooseProjectNodeMismatch', title: 'Resolve project mismatch' };
				const active_v = node_version_display_v(element.active_version);
				const pin_v = node_version_display_v(element.pin);
				const tip = new vscode.MarkdownString(
					`Project needs: ${pin_v}\n\n` +
						`Current version is: ${active_v}\n\n` +
						`Click on the red status bar item to open version selection.`
				);
				tip.isTrusted = false;
				item.tooltip = tip;
				return item;
			}
			case 'version': {
				const tree_label =
					element.role === 'current' ? `${element.entry.version} - In use` : element.label;
				const item = new vscode.TreeItem(tree_label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.tooltip = element.tooltip;
				const installing =
					this.install_progress !== undefined &&
					normalize_version(element.entry.version) === normalize_version(this.install_progress.version);
				if (installing) {
					const vv = node_version_display_v(element.entry.version);
					const verb = this.install_progress!.phase === 'downloading' ? 'Downloading' : 'Installing';
					item.label = `${verb} ${vv}`;
					item.description = undefined;
					item.tooltip = `${verb} Node ${element.entry.version}…`;
					item.iconPath = new vscode.ThemeIcon('sync~spin');
					item.command = undefined;
					item.contextValue = undefined;
					return item;
				}
				const logo_file = resolve_version_logo_filename(element.entry.version, get_node_release_channels());
				item.iconPath = vscode.Uri.file(
					path.join(this.context.extensionPath, 'media', 'picker', logo_file)
				);
				item.contextValue =
					element.role === 'current'
						? 'nodeswitcher.version.current'
						: element.role === 'installed'
							? 'nodeswitcher.version.installed'
							: 'nodeswitcher.version.available';
				item.command = {
					command: 'nodeswitcher.sidebarApplyVersion',
					title: 'Switch to this version',
					arguments: [element.backend, element.entry]
				};
				return item;
			}
			case 'toggle_available': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.tooltip = element.tooltip;
				item.iconPath = new vscode.ThemeIcon('list-flat');
				item.command = {
					command: 'nodeswitcher.sidebarToggleAvailable',
					title: 'Toggle uninstalled versions',
					arguments: [element.backend]
				};
				return item;
			}
			case 'open_settings': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.tooltip = element.tooltip;
				item.iconPath = new vscode.ThemeIcon('settings-gear');
				item.command = {
					command: 'nodeswitcher.openExtensionSettings',
					title: 'Open NodeSwitcher settings'
				};
				return item;
			}
			case 'switch_to_project': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.tooltip = element.tooltip;
				item.iconPath = vscode.Uri.file(
					path.join(this.context.extensionPath, 'media', 'picker', 'project-switch.svg')
				);
				item.contextValue = 'nodeswitcher.switchToProject';
				item.command = {
					command: 'nodeswitcher.sidebarApplyVersion',
					title: 'Switch to project Node version',
					arguments: [element.backend, element.entry]
				};
				return item;
			}
			case 'load_error': {
				const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('error');
				return item;
			}
			case 'skeleton': {
				const item = new vscode.TreeItem('Loading versions…', vscode.TreeItemCollapsibleState.None);
				item.description = '\u2003';
				item.iconPath = new vscode.ThemeIcon('loading~spin');
				return item;
			}
		}
	}

	async getChildren(element?: SidebarElement): Promise<SidebarElement[]> {
		if (!element) {
			return this.buildRootItems();
		}
		if (element === this.el_switch_parent || element.kind === 'switch_parent') {
			return this.loadSwitchChildren();
		}
		return [];
	}

	private async buildRootItems(): Promise<SidebarElement[]> {
		const version = this.context.workspaceState.get<string>(VERSION_STATE_KEY);
		const pin = await get_project_pinned_from_disk();
		const items: SidebarElement[] = [this.el_switch_parent, this.el_refresh];
		const mismatch =
			version !== undefined &&
			pin !== undefined &&
			normalize_version(version) !== normalize_version(pin);
		if (mismatch) {
			items.push({ kind: 'resolve', pin, active_version: version });
		}
		return items;
	}

	private async loadSwitchChildren(): Promise<SidebarElement[]> {
		if (this.switch_list_load_error !== undefined && !this.switch_list_load_in_flight) {
			return [{ kind: 'load_error', message: this.switch_list_load_error }];
		}
		if (this.switchChildrenCache !== null && this.switchBackend !== null) {
			return this.buildPickerRowsFromCache();
		}
		const gen = this.switch_list_load_generation;
		if (!this.switch_list_load_in_flight) {
			this.switch_list_load_in_flight = true;
			void this.fillSwitchCacheAsync(gen);
		}
		return this.el_skeleton_rows;
	}

	private async buildPickerRowsFromCache(): Promise<SidebarElement[]> {
		const project_pin = await get_project_pinned_from_disk();
		const items = build_version_picker_items(
			this.switchChildrenCache!,
			this.switchBackend!,
			this.switchIncludeAvailable,
			true,
			project_pin,
			this.context.extensionPath,
			false,
			false
		);
		return this.pickerItemsToElements(items, this.switchBackend!);
	}

	private async fillSwitchCacheAsync(gen: number): Promise<void> {
		try {
			const loaded = await load_switcher_picker_entries(this.context);
			if (gen !== this.switch_list_load_generation) {
				return;
			}
			if (!loaded) {
				this.switch_list_load_error = 'Could not list installed Node versions.';
				this.switchChildrenCache = null;
				this.switchBackend = null;
			} else {
				this.switch_list_load_error = undefined;
				this.switchBackend = loaded.backend;
				this.switchChildrenCache = loaded.entries;
			}
		} catch {
			if (gen !== this.switch_list_load_generation) {
				return;
			}
			this.switch_list_load_error = 'Could not list installed Node versions.';
			this.switchChildrenCache = null;
			this.switchBackend = null;
		} finally {
			if (gen === this.switch_list_load_generation) {
				this.switch_list_load_in_flight = false;
				this._onDidChangeTreeData.fire(this.el_switch_parent);
			}
		}
	}

	private pickerItemsToElements(items: NodePickerItem[], backend: NodeBackend): SidebarElement[] {
		const rows: SidebarElement[] = [];
		for (const it of items) {
			if (it.kind === vscode.QuickPickItemKind.Separator) {
				continue;
			}
			if (it.action === 'toggle_available') {
				rows.push({
					kind: 'toggle_available',
					backend,
					label: strip_footer_quickpick_padding(it.label),
					description:
						it.description !== undefined ? strip_footer_quickpick_padding(it.description) : undefined,
					tooltip: typeof it.tooltip === 'string' ? it.tooltip : undefined
				});
				continue;
			}
			if (it.action === 'open_settings') {
				rows.push({
					kind: 'open_settings',
					label: strip_footer_quickpick_padding(it.label),
					description:
						it.description !== undefined ? strip_footer_quickpick_padding(it.description) : undefined,
					tooltip: typeof it.tooltip === 'string' ? it.tooltip : undefined
				});
				continue;
			}
			if (it.action === 'switch_to_project' && it.entry) {
				rows.push({
					kind: 'switch_to_project',
					backend,
					entry: it.entry,
					label: it.label,
					description: it.description,
					tooltip: typeof it.tooltip === 'string' ? it.tooltip : undefined
				});
				continue;
			}
			if (it.entry) {
				const role =
					it.entry.is_current && it.entry.is_installed
						? 'current'
						: it.entry.is_installed
							? 'installed'
							: 'available';
				rows.push({
					kind: 'version',
					backend,
					entry: it.entry,
					role,
					label: it.label,
					description: it.description,
					tooltip: typeof it.tooltip === 'string' ? it.tooltip : undefined
				});
			}
		}
		return rows;
	}

	async loadAvailableVersions(backend: NodeBackend): Promise<void> {
		if (!this.switchBackend || !this.switchChildrenCache || backend !== this.switchBackend) {
			return;
		}
		try {
			this.switchChildrenCache = await get_versions_with_available(
				this.context,
				backend,
				this.switchChildrenCache
			);
			this.switchIncludeAvailable = true;
			this.refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`NodeSwitcher failed to load available versions: ${message}`);
		}
	}

	async toggleAvailableVersions(backend: NodeBackend): Promise<void> {
		if (!this.switchBackend || !this.switchChildrenCache || backend !== this.switchBackend) {
			return;
		}
		if (this.switchIncludeAvailable) {
			this.switchIncludeAvailable = false;
			this.refresh();
			return;
		}
		await this.loadAvailableVersions(backend);
	}
}

function is_sidebar_version_action_element(
	el: unknown
): el is SidebarElement & { kind: 'version' | 'switch_to_project' } {
	return (
		typeof el === 'object' &&
		el !== null &&
		'kind' in el &&
		((el as SidebarElement).kind === 'version' || (el as SidebarElement).kind === 'switch_to_project')
	);
}

export function registerNodeSidebar(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): NodeSidebarProvider {
	const provider = new NodeSidebarProvider(context);
	const view = vscode.window.createTreeView<SidebarElement>('nodeswitcher.mainView', {
		treeDataProvider: provider
	});
	provider.setTreeView(view);
	context.subscriptions.push(
		view.onDidChangeVisibility((e) => {
			if (e.visible) {
				provider.schedule_reveal_switch_parent_expanded(view);
			}
		})
	);
	context.subscriptions.push(view);
	set_after_status_paint(() => {
		provider.refresh();
	});
	context.subscriptions.push({
		dispose: () => {
			set_after_status_paint(undefined);
		}
	});
	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.sidebarApplyVersion', async (backend: NodeBackend, entry: VersionEntry) => {
			try {
				await apply_picked_version_entry(context, status_item, backend, entry, (phase, v) => {
					provider.setInstallProgress(v, phase);
				});
			} finally {
				provider.clearInstallProgress();
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.sidebarToggleAvailable', async (backend: NodeBackend) => {
			await provider.toggleAvailableVersions(backend);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(OPEN_SIDEBAR_COMMAND_ID, async () => {
			await vscode.commands.executeCommand('workbench.view.extension.nodeswitcher-sidebar');
		})
	);
	const resolve_version_element = (
		first: unknown
	): (SidebarElement & { kind: 'version' | 'switch_to_project' }) | undefined => {
		if (is_sidebar_version_action_element(first)) {
			return first;
		}
		const sel = view.selection[0];
		return is_sidebar_version_action_element(sel) ? sel : undefined;
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.sidebarInlineActivate', async (first: unknown) => {
			const el = resolve_version_element(first);
			if (!el) {
				return;
			}
			try {
				await apply_picked_version_entry(context, status_item, el.backend, el.entry, (phase, v) => {
					provider.setInstallProgress(v, phase);
				});
			} finally {
				provider.clearInstallProgress();
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('nodeswitcher.sidebarVersionDetails', async (first: unknown) => {
			const el = resolve_version_element(first);
			if (!el) {
				return;
			}
			await show_version_install_details(context, status_item, () => {
				provider.invalidateVersionCache();
				provider.refresh();
			}, el.backend, el.entry);
		})
	);
	return provider;
}
