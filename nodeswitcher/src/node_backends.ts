import { exec } from 'child_process';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
	get_latest_stable_per_major_sorted,
	get_node_release_channels,
	sort_versions_for_display
} from './node_release_index';
import {
	active_satisfies_declared_range,
	read_declared_node_range,
	workspace_looks_like_js_project
} from './project_node_spec';
import {
	compare_versions_desc,
	get_version_color,
	normalize_version,
	parse_versions,
	resolve_version_logo_filename,
	resolve_version_release_semantics,
	sanitize_version
} from './version_utils';

const exec_async = promisify(exec);

class InstallCancelledError extends Error {
	override readonly name = 'InstallCancelledError';
	constructor() {
		super('Install cancelled');
	}
}

function exec_async_cancellable(
	command: string,
	options: { timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
	const { signal, timeout, env, maxBuffer = 50 * 1024 * 1024 } = options;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new InstallCancelledError());
			return;
		}
		const child = exec(command, { timeout, env: env ?? process.env, maxBuffer }, (err, stdout, stderr) => {
			if (signal?.aborted) {
				reject(new InstallCancelledError());
				return;
			}
			if (err) {
				const ex = err as NodeJS.ErrnoException & { killed?: boolean };
				if (ex.killed) {
					reject(new InstallCancelledError());
					return;
				}
				reject(err);
				return;
			}
			resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
		});
		const onAbort = () => {
			child.kill();
			setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					/* noop */
				}
			}, 750);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export type VersionEntry = {
	version: string;
	is_installed: boolean;
	is_current: boolean;
	manager_list_line?: string;
	install_dir_mtime?: string;
};

export type NodeBackend = 'n' | 'nvm';
type ProjectHistoryEntry = {
	backend: NodeBackend;
	selected_at: string;
	version: string;
};
type ProjectNodeState = {
	backend?: NodeBackend;
	current?: string;
	history: ProjectHistoryEntry[];
};

export const OPEN_SIDEBAR_COMMAND_ID = 'nodeswitcher.openSidebar';

export type NodePickerItem = vscode.QuickPickItem & {
	entry?: VersionEntry;
	action?: 'toggle_available' | 'toggle_installed' | 'open_settings' | 'switch_to_project' | 'skeleton';
	tooltip?: string;
};

export const BACKEND_STATE_KEY = 'nodeswitcher.backend';
const BACKEND_PROBE_AT_KEY = 'nodeswitcher.backendProbeAt';
const BACKEND_PROBE_VALUE_KEY = 'nodeswitcher.backendProbeValue';
const LOCAL_VERSIONS_AT_KEY = 'nodeswitcher.localVersionsAt';
const LOCAL_VERSIONS_KEY = 'nodeswitcher.localVersions';
export const VERSION_STATE_KEY = 'nodeswitcher.activeNodeVersion';
const LAST_APPLIED_VERSION_KEY = 'nodeswitcher.lastAppliedViaExtension';
const PROJECT_PINNED_CACHE_KEY = 'nodeswitcher.projectPinnedVersionCache';
const MISMATCH_KEEP_CURRENT_KEY = 'nodeswitcher.projectMismatchKeepCurrent';
const MISMATCH_PROMPT_FP_KEY = 'nodeswitcher.projectMismatchPromptFingerprint';
const PROBE_TTL_MS = 60_000;
const FAST_SHELL_TIMEOUT_MS = 1_800;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const PROJECT_PROMPTED_KEY = 'nodeswitcher.projectPrompted';
const PICKER_OPENED_KEY = 'nodeswitcher.pickerOpenedOnce';
const NVM_SH_PROMPT_DISMISSED_KEY = 'nodeswitcher.nvmShInstallDismissed';
const NVM_WINDOWS_PROMPT_DISMISSED_KEY = 'nodeswitcher.nvmWindowsInstallDismissed';
const N_MACOS_PROMPT_DISMISSED_KEY = 'nodeswitcher.nMacosInstallDismissed';
const NVM_SH_INSTALL_SCRIPT_URL =
	'https://raw.githubusercontent.com/nvm-sh/nvm/refs/tags/v0.40.4/install.sh';
const NVM_WINDOWS_RELEASES_URL = 'https://github.com/coreybutler/nvm-windows/releases';
const N_MACOS_DOC_URL = 'https://github.com/tj/n';
const N_PM_GLOBAL_INSTALL = 'npm install -g n';
const N_BREW_INSTALL = 'brew install n';
export const STATUS_BAR_ICON = 'nodeswitcher-logo';
export const STATUS_BAR_FOREGROUND = '#ffffff';
const VERSION_LABEL_MIN_CHARS = 18;
const ACCORDION_ICON_PAD_RATIO = 0.22;

const padded_picker_logo_uri_cache = new Map<string, vscode.Uri>();

let after_status_paint: (() => void) | undefined;

export function set_after_status_paint(handler: (() => void) | undefined): void {
	after_status_paint = handler;
}

export { get_version_color };

export function host_platform_label(): string {
	return process.platform;
}

function normalize_backend_for_platform(backend: NodeBackend): NodeBackend {
	if (process.platform === 'win32') {
		return 'nvm';
	}
	if (process.platform === 'darwin') {
		return 'n';
	}
	return backend;
}

function backend_matches_platform(backend: NodeBackend): boolean {
	return normalize_backend_for_platform(backend) === backend;
}

export function visible_backend_label(backend: NodeBackend): string | undefined {
	return backend === 'n' ? 'n' : undefined;
}

export async function resolve_backend(preferred?: NodeBackend | null, timeout_ms = DEFAULT_SHELL_TIMEOUT_MS): Promise<NodeBackend> {
	if (process.platform === 'win32') {
		if (!(await probe_nvm(timeout_ms))) {
			throw new Error('Node version manager for Windows is not on PATH. Install it from the nvm-windows releases page.');
		}
		return 'nvm';
	}
	if (process.platform === 'darwin') {
		if (!(await probe_n(timeout_ms))) {
			throw new Error(
				`On macOS, NodeSwitcher uses the npm package n. Install with \`${N_PM_GLOBAL_INSTALL}\` or \`${N_BREW_INSTALL}\`, then reload. See ${N_MACOS_DOC_URL}`
			);
		}
		return 'n';
	}
	const normalized_preferred =
		preferred === 'nvm' ? preferred : preferred === 'n' ? preferred : null;
	if (normalized_preferred === 'n' && (await probe_n(timeout_ms))) {
		return 'n';
	}
	if (normalized_preferred === 'nvm' && (await probe_nvm(timeout_ms))) {
		return 'nvm';
	}
	if (await probe_n(timeout_ms)) {
		return 'n';
	}
	if (await probe_nvm(timeout_ms)) {
		return 'nvm';
	}
	throw new Error('Neither n nor nvm-sh was found on PATH. Install one of them or use Linux/macOS with the right tool.');
}

function build_project_needs_display(
	declared_mismatch: boolean,
	declared_spec: string | undefined,
	pin_mismatch: boolean,
	pin: string | undefined
): string {
	const pin_part = pin_mismatch && pin ? node_version_display_v(pin) : '';
	const declared_part = declared_mismatch && declared_spec ? declared_spec.trim() : '';
	if (pin_part && declared_part) {
		return `${pin_part} (.nodeswitcher); project also declares ${declared_part}`;
	}
	if (pin_part) {
		return pin_part;
	}
	if (declared_part) {
		return declared_part;
	}
	return '';
}

function apply_status_tooltip(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	tag: string | undefined,
	project_pin: string | undefined,
	active_for_tooltip: string
): void {
	const suffix = tag ? ` (${tag})` : '';
	const pin_line =
		project_pin && normalize_version(active_for_tooltip) !== normalize_version(project_pin)
			? `\n\nMismatch: Current Node (${node_version_display_v(active_for_tooltip)}) doesn't match the project's Node version (${node_version_display_v(project_pin)}).\n\nClick to open version selection.`
			: '';
	if (context.workspaceState.get<boolean>(PICKER_OPENED_KEY) === true) {
		const version = context.workspaceState.get<string>(VERSION_STATE_KEY) ?? '';
		status_item.tooltip = version
			? `Node ${version}${suffix} · ${host_platform_label()}${pin_line}`
			: `${host_platform_label()}${pin_line}`;
		return;
	}
	const base = tag
		? `Click to switch Node (${tag}, OS ${host_platform_label()})`
		: `Click to switch Node (OS ${host_platform_label()})`;
	status_item.tooltip = `${base}${pin_line}`;
}

function apply_project_mismatch_bar_tooltip(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	tag: string | undefined,
	active_version: string,
	declared_mismatch: boolean,
	declared_spec: string | undefined,
	pin_mismatch: boolean,
	pin: string | undefined
): void {
	const suffix = tag ? ` (${tag})` : '';
	const needs = build_project_needs_display(declared_mismatch, declared_spec, pin_mismatch, pin);
	const current_v = node_version_display_v(active_version);
	const click_hint = 'Click to open version selection.';
	const project_v = needs.length > 0 ? needs : 'a different version';
	const mismatch_block = `Mismatch: Current Node (${current_v}) doesn't match the project's Node version (${project_v}).\n\n${click_hint}`;
	if (context.workspaceState.get<boolean>(PICKER_OPENED_KEY) === true) {
		const version = context.workspaceState.get<string>(VERSION_STATE_KEY) ?? '';
		const extra = version
			? `Node ${version}${suffix} · ${host_platform_label()}`
			: tag
				? `${tag} · ${host_platform_label()}`
				: host_platform_label();
		status_item.tooltip = `${mismatch_block}\n\n${extra}`;
		return;
	}
	status_item.tooltip = mismatch_block;
}

export type NodeswitcherStatusBarVariant =
	| 'default'
	| 'global_drift'
	| 'project_mismatch'
	| 'project_no_node_spec';

export function apply_nodeswitcher_status_bar_style(
	status_item: vscode.StatusBarItem,
	variant: NodeswitcherStatusBarVariant = 'default'
): void {
	if (variant === 'global_drift' || variant === 'project_mismatch') {
		status_item.color = STATUS_BAR_FOREGROUND;
		status_item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		return;
	}
	if (variant === 'project_no_node_spec') {
		status_item.color = STATUS_BAR_FOREGROUND;
		status_item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		return;
	}
	status_item.color = STATUS_BAR_FOREGROUND;
	status_item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
}

export function apply_nodeswitcher_status_bar_visibility(status_item: vscode.StatusBarItem): void {
	if (vscode.workspace.getConfiguration('nodeswitcher').get<boolean>('showInStatusBar', true)) {
		status_item.show();
	} else {
		status_item.hide();
	}
}

async function read_last_applied_or_baseline(context: vscode.ExtensionContext, live_version: string): Promise<string> {
	let last = context.workspaceState.get<string>(LAST_APPLIED_VERSION_KEY);
	if (last === undefined || last === '') {
		const n = normalize_version(live_version) || live_version;
		await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, n);
		return n;
	}
	return last;
}

function apply_status_bar_tooltip_global_drift(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	live: string,
	last_applied: string,
	tag: string | undefined,
	project_pin: string | undefined
): void {
	const suffix = tag ? ` (${tag})` : '';
	const pin_line =
		project_pin && normalize_version(live) !== normalize_version(project_pin)
			? `\n\nProject (.nodeswitcher) expects Node ${project_pin}.`
			: '';
	status_item.tooltip = `Global Node is ${live}${suffix}; NodeSwitcher last applied ${last_applied} in this workspace.${pin_line}\n\nOpen the version picker and choose the active version to sync this workspace and clear drift.`;
}

function format_status_bar_text(
	current: string,
	tag: string | undefined,
	project_pin: string | undefined,
	leading_icon: string
): string {
	const label_suffix = tag ? ` (${tag})` : '';
	const base = `$(${leading_icon}) Node ${current}${label_suffix}`;
	if (project_pin && normalize_version(current) !== normalize_version(project_pin)) {
		return `${base} \u2260 ${project_pin}`;
	}
	if (project_pin) {
		return `${base} \u{1F7E2}`;
	}
	return base;
}

function is_minimal_status_bar_enabled(): boolean {
	return vscode.workspace.getConfiguration('nodeswitcher').get<boolean>('minimalStatusBar', false);
}

function status_bar_text(full_text: string, tone: 'default' | 'warning' | 'loading'): string {
	if (!is_minimal_status_bar_enabled()) {
		return full_text;
	}
	if (tone === 'loading') {
		return `$(sync~spin) $(${STATUS_BAR_ICON})`;
	}
	if (tone === 'warning') {
		return `$(warning) $(${STATUS_BAR_ICON})`;
	}
	return `$(${STATUS_BAR_ICON})`;
}

function status_bar_leading_icon(project_pin: string | undefined, current: string): string {
	if (project_pin && normalize_version(current) !== normalize_version(project_pin)) {
		return 'warning';
	}
	return STATUS_BAR_ICON;
}

export async function render_cached_status(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const version = context.workspaceState.get<string>(VERSION_STATE_KEY);
	const backend = context.workspaceState.get<NodeBackend>(BACKEND_STATE_KEY);
	if (!version || !backend) {
		status_item.text = status_bar_text(`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher`, 'loading');
		status_item.tooltip = 'NodeSwitcher is initializing...';
		apply_nodeswitcher_status_bar_style(status_item);
		apply_nodeswitcher_status_bar_visibility(status_item);
		return;
	}
	const pin = await get_project_pinned_from_disk();
	const tag = visible_backend_label(backend);
	let live = version;
	try {
		const probed = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS);
		live = normalize_version(probed) || probed;
	} catch {
		live = version;
	}
	const stored_last = context.workspaceState.get<string>(LAST_APPLIED_VERSION_KEY) ?? version;
	if (
		pin &&
		stored_last &&
		normalize_version(stored_last) === normalize_version(pin) &&
		normalize_version(live) !== normalize_version(pin)
	) {
		live = normalize_version(pin) || pin;
	}
	await context.workspaceState.update(VERSION_STATE_KEY, live);
	const last_applied = await read_last_applied_or_baseline(context, live);
	let drift = normalize_version(live) !== normalize_version(last_applied);
	if (drift && pin && normalize_version(live) === normalize_version(pin)) {
		await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, live);
		drift = false;
	}
	if (drift) {
		status_item.text = status_bar_text('$(warning) Global node version changed', 'warning');
		apply_status_bar_tooltip_global_drift(context, status_item, live, last_applied, tag, pin ?? undefined);
		apply_nodeswitcher_status_bar_style(status_item, 'global_drift');
	} else {
		await paint_main_status_bar(context, status_item, live, backend);
		return;
	}
	apply_nodeswitcher_status_bar_visibility(status_item);
	after_status_paint?.();
}

export async function initialize_status(context: vscode.ExtensionContext, status_item: vscode.StatusBarItem): Promise<void> {
	status_item.text = status_bar_text(`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher - Analyzing Node.js version`, 'loading');
	status_item.tooltip = 'NodeSwitcher is analyzing your current Node version...';
	apply_nodeswitcher_status_bar_style(status_item);
	apply_nodeswitcher_status_bar_visibility(status_item);
	try {
		const backend = await resolve_backend_cached(context, true);
		const current = await get_current_version(backend, 5_000);
		const current_n = normalize_version(current) || current;
		await context.workspaceState.update(VERSION_STATE_KEY, current_n);
		await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, current_n);
		await context.workspaceState.update(BACKEND_STATE_KEY, backend);
		await apply_project_selection_if_present(context, status_item);
		void warm_local_versions_cache(context, backend);
		await ensure_project_selection_prompt(context, status_item);
	} catch {
		void render_cached_status(context, status_item);
	}
}

function get_nodeswitcher_terminal_env_collection(
	context: vscode.ExtensionContext
): vscode.EnvironmentVariableCollection {
	const wf = vscode.workspace.workspaceFolders?.[0];
	if (wf) {
		return context.environmentVariableCollection.getScoped({ workspaceFolder: wf });
	}
	return context.environmentVariableCollection;
}

export async function apply_node_environment(
	context: vscode.ExtensionContext,
	version: string,
	backend: NodeBackend,
	already_switched = false
): Promise<void> {
	const safe = sanitize_version(version);
	if (!safe) {
		throw new Error('Invalid Node version');
	}
	const node_exe = await resolve_node_executable(safe, backend, already_switched);
	const bin_dir = path.dirname(node_exe.trim());
	const sep = path.delimiter;
	context.environmentVariableCollection.delete('PATH');
	const scoped = get_nodeswitcher_terminal_env_collection(context);
	scoped.delete('PATH');
	scoped.prepend('PATH', `${bin_dir}${sep}`, { applyAtProcessCreation: true });
	await context.workspaceState.update(VERSION_STATE_KEY, safe);
	await context.workspaceState.update(BACKEND_STATE_KEY, backend);
	await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, safe);
}

async function resolve_node_executable(version: string, backend: NodeBackend, already_switched: boolean): Promise<string> {
	if (backend === 'n') {
		if (!already_switched) {
			await run_n(`${version}`);
		}
		const out = await run_n('bin');
		const bin = out
			.trim()
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.pop();
		if (!bin) {
			throw new Error('Could not resolve node path from n bin');
		}
		return bin;
	}
	if (process.platform === 'win32') {
		const use_prefix = already_switched ? '' : `nvm use ${version} | Out-Null; `;
		const ps = `${use_prefix}(Get-Command node -ErrorAction Stop).Source`;
		const { stdout } = await exec_async(`powershell -NoProfile -Command "${ps}"`, {
			timeout: 120000,
			env: process.env
		});
		const line = stdout
			.trim()
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.pop();
		if (!line) {
			throw new Error('Could not resolve node.exe after nvm use');
		}
		return line;
	}
	const shell = process.env.SHELL ?? '/bin/bash';
	const script = `source "$HOME/.nvm/nvm.sh" 2>/dev/null || true; nvm use ${version} >/dev/null || exit 1; command -v node`;
	const { stdout } = await exec_async(`${shell} -lc ${JSON.stringify(script)}`, {
		timeout: 120000,
		env: process.env
	});
	const node_path = stdout.trim().split('\n').filter(Boolean).pop();
	if (!node_path) {
		throw new Error('Could not resolve node after nvm use');
	}
	return node_path;
}

const VERSION_PICKER_SKELETON_ROW_COUNT = 6;

function build_version_picker_skeleton_items(): NodePickerItem[] {
	return Array.from({ length: VERSION_PICKER_SKELETON_ROW_COUNT }, (_, slot) => ({
		label: '$(loading~spin) Loading installed versions…',
		description: '\u2007'.repeat(12 + slot * 2),
		action: 'skeleton' as const
	}));
}

export async function open_version_picker(context: vscode.ExtensionContext, status_item: vscode.StatusBarItem): Promise<void> {
	status_item.tooltip = undefined;
	await context.workspaceState.update(PICKER_OPENED_KEY, true);

	let backend: NodeBackend | undefined;
	let current_entries: VersionEntry[] = [];
	let include_available = false;
	let include_installed = true;
	let project_pin: string | undefined;
	let loaded = false;

	const quick_pick = vscode.window.createQuickPick<NodePickerItem>();
	quick_pick.matchOnDescription = true;
	quick_pick.matchOnDetail = true;
	quick_pick.placeholder = `Select a Node version · ${host_platform_label()}`;
	quick_pick.items = build_version_picker_skeleton_items();

	const select_promise = new Promise<VersionEntry | undefined>((resolve) => {
		const disposables: vscode.Disposable[] = [];
		let picker_closed = false;
		let active_install_abort: AbortController | undefined;
		const finish = (value: VersionEntry | undefined) => {
			if (picker_closed) {
				return;
			}
			const had_pending_install = active_install_abort !== undefined;
			active_install_abort?.abort();
			active_install_abort = undefined;
			picker_closed = true;
			if (had_pending_install && value === undefined) {
				vscode.window.showInformationMessage('Install cancelled. Node version was not changed.');
			}
			for (const disposable of disposables) {
				disposable.dispose();
			}
			quick_pick.hide();
			quick_pick.dispose();
			resolve(value);
		};

		const apply_entry_from_picker = async (entry: VersionEntry) => {
			if (backend === undefined) {
				return;
			}
			const b = backend;
			const show_progress = !entry.is_installed;
			let cancel_btn_dispose: vscode.Disposable | undefined;
			const cancel_btn: vscode.QuickInputButton = {
				iconPath: new vscode.ThemeIcon('close'),
				tooltip: 'Cancel download / install'
			};
			let install_signal: AbortSignal | undefined;
			if (show_progress) {
				const ac = new AbortController();
				install_signal = ac.signal;
				active_install_abort = ac;
				quick_pick.busy = true;
				quick_pick.enabled = false;
				quick_pick.buttons = [cancel_btn];
				cancel_btn_dispose = quick_pick.onDidTriggerButton((btn) => {
					if (btn === cancel_btn || btn.tooltip === cancel_btn.tooltip) {
						ac.abort();
					}
				});
			}
			const on_phase: InstallPhaseCallback = (phase, version) => {
				const vv = node_version_display_v(version);
				const verb = phase === 'downloading' ? 'Downloading' : 'Installing';
				quick_pick.placeholder = `${verb} ${vv}...`;
				quick_pick.title = `${verb} Node ${version}`;
			};
			try {
				if (show_progress) {
					on_phase('downloading', entry.version);
					const target = normalize_version(entry.version);
					quick_pick.items = quick_pick.items.map((item) => {
						if (!item.entry || normalize_version(item.entry.version) !== target) {
							return item;
						}
						return {
							...item,
							iconPath: new vscode.ThemeIcon('sync~spin')
						};
					});
				}
				await apply_picked_version_entry(
					context,
					status_item,
					b,
					entry,
					show_progress ? on_phase : undefined,
					install_signal
				);
			} finally {
				cancel_btn_dispose?.dispose();
				active_install_abort = undefined;
				if (!picker_closed && show_progress) {
					quick_pick.buttons = [];
					quick_pick.busy = false;
					quick_pick.enabled = true;
					quick_pick.title = undefined;
					const hint = visible_backend_label(b);
					quick_pick.placeholder = hint
						? `Select a Node version · ${hint} · ${host_platform_label()}`
						: `Select a Node version · ${host_platform_label()}`;
					quick_pick.items = build_version_picker_items(
						current_entries,
						b,
						include_available,
						include_installed,
						project_pin,
						context.extensionPath,
						false,
						true
					);
				}
			}
		};

		disposables.push(
			quick_pick.onDidAccept(async () => {
				if (!loaded || backend === undefined) {
					return;
				}
				const b = backend;
				const selected = quick_pick.selectedItems[0];
				if (!selected || selected.action === 'skeleton') {
					return;
				}
				if (selected.action === 'toggle_available') {
					if (include_available) {
						include_available = false;
						quick_pick.items = build_version_picker_items(
							current_entries,
							b,
							include_available,
							include_installed,
							project_pin,
							context.extensionPath,
							false,
							true
						);
						return;
					}
					quick_pick.busy = true;
					quick_pick.enabled = false;
					try {
						current_entries = await get_versions_with_available(context, b, current_entries);
						include_available = true;
						quick_pick.items = build_version_picker_items(
							current_entries,
							b,
							include_available,
							include_installed,
							project_pin,
							context.extensionPath,
							false,
							true
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`NodeSwitcher failed to load available versions: ${message}`);
					} finally {
						quick_pick.busy = false;
						quick_pick.enabled = true;
					}
					return;
				}
				if (selected.action === 'toggle_installed') {
					include_installed = !include_installed;
					quick_pick.items = build_version_picker_items(
						current_entries,
						b,
						include_available,
						include_installed,
						project_pin,
						context.extensionPath,
						false,
						true
					);
					return;
				}
				if (selected.action === 'open_settings') {
					await vscode.commands.executeCommand('nodeswitcher.openExtensionSettings');
					finish(undefined);
					return;
				}
				if (!selected.entry) {
					return;
				}
				try {
					await apply_entry_from_picker(selected.entry);
					finish(selected.entry);
				} catch (err) {
					if (err instanceof InstallCancelledError) {
						if (!picker_closed) {
							vscode.window.showInformationMessage('Install cancelled. Node version was not changed.');
						}
						return;
					}
					finish(undefined);
				}
			}),
			quick_pick.onDidHide(() => finish(undefined))
		);
		quick_pick.show();
		void (async () => {
			let b: NodeBackend;
			try {
				b = await resolve_backend_cached(context, false);
			} catch {
				if (!picker_closed) {
					vscode.window.showErrorMessage(
						`NodeSwitcher could not use the Node version manager for this OS (${host_platform_label()}). Install the required tool and reload the window.`
					);
					finish(undefined);
				}
				return;
			}
			if (picker_closed) {
				return;
			}
			backend = b;
			let raw_entries: VersionEntry[];
			try {
				raw_entries = (await get_cached_local_versions(context)) ?? (await get_local_versions(backend));
			} catch {
				if (!picker_closed) {
					vscode.window.showErrorMessage('NodeSwitcher could not list installed Node versions.');
					finish(undefined);
				}
				return;
			}
			if (picker_closed) {
				return;
			}
			if (raw_entries.length === 0) {
				vscode.window.showErrorMessage('NodeSwitcher could not list installed Node versions.');
				finish(undefined);
				return;
			}
			const live = await resolve_live_version_for_ui(context, backend);
			if (picker_closed) {
				return;
			}
			project_pin = await get_project_pinned_from_disk();
			if (picker_closed) {
				return;
			}
			current_entries = rehydrate_entries_current(raw_entries, live);
			loaded = true;
			const tool_hint = visible_backend_label(backend);
			quick_pick.placeholder = tool_hint
				? `Select a Node version · ${tool_hint} · ${host_platform_label()}`
				: `Select a Node version · ${host_platform_label()}`;
			quick_pick.items = build_version_picker_items(
				current_entries,
				backend,
				include_available,
				include_installed,
				project_pin,
				context.extensionPath,
				false,
				true
			);
		})();
	});

	try {
		await select_promise;
	} finally {
		const pin = await get_project_pinned_from_disk();
		const v = context.workspaceState.get<string>(VERSION_STATE_KEY) ?? '';
		apply_status_tooltip(
			context,
			status_item,
			loaded && backend !== undefined ? visible_backend_label(backend) : undefined,
			pin ?? undefined,
			v
		);
	}
}

function build_installed_picker_tooltip(
	entry: VersionEntry,
	backend: NodeBackend,
	role: 'current' | 'installed' | 'available'
): string {
	const tool = backend === 'nvm' ? 'nvm' : 'n';
	const lines: string[] = [];
	lines.push(`Node ${entry.version}`);
	if (entry.manager_list_line) {
		lines.push(`${tool} list: ${entry.manager_list_line}`);
	}
	if (entry.install_dir_mtime) {
		lines.push(`Install folder last modified: ${entry.install_dir_mtime}`);
	}
	if (role === 'current') {
		lines.push('Active for this workspace (integrated terminal PATH).');
	} else if (!entry.manager_list_line && !entry.install_dir_mtime) {
		lines.push('Installed locally.');
	}
	return lines.join('\n');
}

function find_entry_for_version(entries: VersionEntry[], version: string): VersionEntry | undefined {
	const target = normalize_version(version);
	return entries.find((entry) => normalize_version(entry.version) === target);
}

function entry_for_project_pin(entries: VersionEntry[], pin: string): VersionEntry {
	return find_entry_for_version(entries, pin) ?? { version: pin, is_installed: false, is_current: false };
}

function svg_data_uri_with_left_padding(extension_path: string, file: string): vscode.Uri {
	const full = path.join(extension_path, 'media', 'picker', file);
	try {
		const raw = readFileSync(full, 'utf8');
		const m = raw.match(/<svg([^>]*)>([\s\S]*)<\/svg>/i);
		if (!m) {
			return vscode.Uri.file(full);
		}
		const vbMatch = m[1].match(/viewBox="([^"]+)"/i);
		const parts = vbMatch ? vbMatch[1].trim().split(/\s+/).map(Number) : [];
		const vw = parts[2] ?? 24;
		const vh = parts[3] ?? 24;
		const pad = Math.max(1, Math.round(vw * ACCORDION_ICON_PAD_RATIO));
		const innerBody = m[2]?.trim() ?? '';
		const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw + pad} ${vh}"><g transform="translate(${pad},0)">${innerBody}</g></svg>`;
		return vscode.Uri.parse('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(wrapped));
	} catch {
		return vscode.Uri.file(full);
	}
}

function quick_pick_version_row_icon_uri(
	extension_path: string,
	version: string,
	indent_accordion_child_icon: boolean
): vscode.Uri {
	const file = resolve_version_logo_filename(version, get_node_release_channels());
	if (!indent_accordion_child_icon) {
		return vscode.Uri.file(path.join(extension_path, 'media', 'picker', file));
	}
	const cacheKey = `${extension_path}\0${file}`;
	const hit = padded_picker_logo_uri_cache.get(cacheKey);
	if (hit) {
		return hit;
	}
	const uri = svg_data_uri_with_left_padding(extension_path, file);
	padded_picker_logo_uri_cache.set(cacheKey, uri);
	return uri;
}

function quick_pick_project_switch_uri(extension_path: string): vscode.Uri {
	return vscode.Uri.file(path.join(extension_path, 'media', 'picker', 'project-switch.svg'));
}

function picker_channel_kind_display(badge: string): string {
	const t = badge.trim().replace(/\s+/g, ' ');
	if (/^maintenance$/i.test(t)) {
		return 'Maintenance LTS';
	}
	return t;
}

function picker_version_state_label(version: string, badge: string): string {
	return `${version} (${picker_channel_kind_display(badge)})`;
}

function pad_description_symmetric_in_zone(text: string, zoneWidth: number): string {
	const pad = '\u2007';
	if (text.length >= zoneWidth) {
		return text;
	}
	const gap = zoneWidth - text.length;
	const lead = Math.floor(gap / 2);
	return pad.repeat(lead) + text + pad.repeat(gap - lead);
}

export function build_version_picker_items(
	entries: VersionEntry[],
	backend: NodeBackend,
	include_available: boolean,
	include_installed: boolean,
	project_pin: string | undefined,
	extension_path: string,
	indent_accordion_child_icon: boolean,
	align_installed_state_in_description: boolean
): NodePickerItem[] {
	const version_width = Math.max(VERSION_LABEL_MIN_CHARS, ...entries.map((entry) => entry.version.length));
	const release_channels = get_node_release_channels();
	const max_version_state_label_width = Math.max(
		VERSION_LABEL_MIN_CHARS,
		...entries.map((entry) => {
			const { badge } = resolve_version_release_semantics(entry.version, release_channels);
			return picker_version_state_label(entry.version, badge).length;
		})
	);
	const picker_primary_label_width = align_installed_state_in_description
		? Math.max(
				max_version_state_label_width,
				'Project Node version'.length,
				'Hide installed'.length,
				'Show installed'.length,
				'Hide uninstalled'.length,
				'Show uninstalled'.length,
				'Open settings'.length
			)
		: version_width;
	const status_desc_zone_width =
		Math.max('$(check) Installed'.length, '$(cloud-download) Available'.length) + 4;
	const current_entry = entries.find((entry) => entry.is_current && entry.is_installed);
	const current_version_for_pin =
		current_entry?.version ?? entries.find((entry) => entry.is_current)?.version ?? '';
	const show_project_switch =
		project_pin !== undefined &&
		project_pin.length > 0 &&
		normalize_version(current_version_for_pin) !== normalize_version(project_pin);
	const installed_entries = entries.filter((entry) => entry.is_installed && !entry.is_current);
	installed_entries.sort((a, b) => compare_versions_desc(a.version, b.version));
	const available_entries = entries.filter((entry) => !entry.is_installed);
	available_entries.sort((a, b) => compare_versions_desc(a.version, b.version));

	const group_tag_for = (role: 'current' | 'installed' | 'available') =>
		role === 'current' ? 'In Use' : role === 'installed' ? 'Installed' : 'Available To Install';

	const format_concise_row_description = (
		middle: string,
		group_tag: string,
		role: 'current' | 'installed' | 'available'
	) => {
		const tool = visible_backend_label(backend);
		if (role === 'current') {
			if (tool) {
				return `${tool} | ${middle}`;
			}
			return middle;
		}
		if (tool) {
			return `${tool} | ${middle} · ${group_tag}`;
		}
		return `${middle} · ${group_tag}`;
	};

	const row_hover_text = (entry: VersionEntry, details: string, group_tag: string) =>
		`Node ${entry.version}: ${details}. ${group_tag}.`;

	const build_item = (entry: VersionEntry, role: 'current' | 'installed' | 'available') => {
		const detailsBase =
			role === 'current' ? 'In use now' : role === 'installed' ? 'Installed' : 'Available to install';
		const { badge } = resolve_version_release_semantics(entry.version, release_channels);
		const details = badge ? `${detailsBase} · ${badge}` : detailsBase;
		const gt = group_tag_for(role);
		const tooltip = entry.is_installed
			? build_installed_picker_tooltip(entry, backend, role)
			: row_hover_text(entry, details, gt);
		const primary_label_chars = align_installed_state_in_description
			? picker_primary_label_width
			: version_width;
		const version_cell = format_version_cell(entry.version, primary_label_chars);
		const indent_icon =
			indent_accordion_child_icon && (role === 'installed' || role === 'available');
		let label: string;
		let description: string | undefined;
		if (align_installed_state_in_description) {
			label = format_version_cell(
				picker_version_state_label(entry.version, badge),
				picker_primary_label_width
			);
			description = pad_description_symmetric_in_zone(
				role === 'available' ? '$(cloud-download) Available' : '$(check) Installed',
				status_desc_zone_width
			);
		} else if (role === 'current') {
			label = `${version_cell} \u{1F7E2} In use`;
			description = format_concise_row_description(details, gt, role);
		} else if (role === 'installed') {
			label = `${version_cell} $(check) Installed`;
			description = format_concise_row_description(details, gt, role);
		} else {
			label = version_cell;
			description = format_concise_row_description(details, gt, role);
		}
		const row: NodePickerItem = {
			label,
			tooltip,
			iconPath: quick_pick_version_row_icon_uri(extension_path, entry.version, indent_icon),
			entry
		};
		if (description !== undefined) {
			row.description = description;
		}
		return row;
	};

	const section_break = (): vscode.QuickPickItem => ({ kind: vscode.QuickPickItemKind.Separator, label: '' });

	const quick_pick_items: NodePickerItem[] = [];
	if (show_project_switch && project_pin !== undefined) {
		const entry = entry_for_project_pin(entries, project_pin);
		const project_switch_label = align_installed_state_in_description
			? 'Project Node version'
			: 'Switch to Node.js project version';
		const project_label_padded = align_installed_state_in_description
			? project_switch_label +
				'\u2007'.repeat(Math.max(0, picker_primary_label_width - project_switch_label.length))
			: project_switch_label;
		quick_pick_items.push({
			label: project_label_padded,
			description: `${entry.version} · .nodeswitcher`,
			detail: 'Matches the version pinned for this workspace.',
			tooltip: `Use Node ${entry.version} as required by this workspace (.nodeswitcher).`,
			iconPath: quick_pick_project_switch_uri(extension_path),
			action: 'switch_to_project',
			alwaysShow: true,
			entry
		});
	}
	if (current_entry) {
		quick_pick_items.push(section_break());
		quick_pick_items.push(build_item(current_entry, 'current'));
	}
	const footer_label_width = Math.max(
		'Show installed'.length,
		'Hide installed'.length,
		'Show uninstalled'.length,
		'Hide uninstalled'.length,
		'Open settings'.length
	);
	const pad_footer_label = (text: string): string =>
		text + '\u2007'.repeat(footer_label_width - text.length);

	const footer_desc_zone_width = 58;
	const pad_description_center_in_zone = (text: string): string => {
		const pad = '\u2007';
		if (text.length >= footer_desc_zone_width) {
			return text;
		}
		const lead = Math.floor((footer_desc_zone_width - text.length) / 2);
		return pad.repeat(lead) + text;
	};

	const footer_primary = (text: string): string =>
		align_installed_state_in_description
			? text + '\u2007'.repeat(Math.max(0, picker_primary_label_width - text.length))
			: pad_footer_label(text);
	const footer_secondary = (text: string): string =>
		align_installed_state_in_description ? text : pad_description_center_in_zone(text);

	if (installed_entries.length > 0) {
		quick_pick_items.push(section_break());
		quick_pick_items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Installed' });
		const toggle_installed_desc = include_installed
			? format_concise_row_description('Collapse installed versions', group_tag_for('installed'), 'installed')
			: format_concise_row_description('Expand installed versions', group_tag_for('installed'), 'installed');
		quick_pick_items.push({
			label: footer_primary(include_installed ? 'Hide installed' : 'Show installed'),
			description: footer_secondary(toggle_installed_desc),
			tooltip: include_installed ? 'Hides installed local Node versions.' : 'Shows installed local Node versions.',
			iconPath: new vscode.ThemeIcon(include_installed ? 'chevron-up' : 'chevron-down'),
			action: 'toggle_installed'
		});
		if (include_installed) {
			quick_pick_items.push(section_break());
			quick_pick_items.push(...installed_entries.map((entry) => build_item(entry, 'installed')));
		}
	}

	quick_pick_items.push(section_break());
	const toggle_uninstalled_desc = include_available
		? format_concise_row_description('Collapse remote versions', group_tag_for('installed'), 'installed')
		: format_concise_row_description('Fetch remote versions', group_tag_for('available'), 'available');
	quick_pick_items.push({
		label: footer_primary(include_available ? 'Hide uninstalled' : 'Show uninstalled'),
		description: footer_secondary(toggle_uninstalled_desc),
		tooltip: include_available
			? 'Hides uninstalled remote Node versions.'
			: 'Fetches remote Node versions and lists versions not installed locally.',
		iconPath: new vscode.ThemeIcon(include_available ? 'chevron-up' : 'cloud-download'),
		action: 'toggle_available'
	});
	if (include_available && available_entries.length > 0) {
		quick_pick_items.push(section_break());
		quick_pick_items.push(...available_entries.map((entry) => build_item(entry, 'available')));
	}
	const open_settings_desc = format_concise_row_description('NodeSwitcher settings', 'Settings', 'available');
	quick_pick_items.push(section_break());
	quick_pick_items.push({
		label: footer_primary('Open settings'),
		description: footer_secondary(open_settings_desc),
		tooltip: 'Opens NodeSwitcher extension settings.',
		iconPath: new vscode.ThemeIcon('settings-gear'),
		action: 'open_settings'
	});
	return quick_pick_items;
}

function format_version_cell(version: string, width: number): string {
	const pad = '\u2007';
	if (version.length >= width) {
		return version;
	}
	return version + pad.repeat(width - version.length);
}

export type InstallPhase = 'downloading' | 'installing';

export type InstallPhaseCallback = (phase: InstallPhase, version: string) => void;

export function node_version_display_v(version: string): string {
	const t = version.trim();
	return /^v/i.test(t) ? t : `v${t}`;
}

export async function apply_picked_version_entry(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	backend: NodeBackend,
	entry: VersionEntry,
	on_install_phase?: InstallPhaseCallback,
	cancel_signal?: AbortSignal
): Promise<void> {
	await select_version_internal(context, status_item, backend, entry, on_install_phase, cancel_signal);
}

async function select_version_internal(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	backend: NodeBackend,
	entry: VersionEntry,
	on_install_phase?: InstallPhaseCallback,
	cancel_signal?: AbortSignal
): Promise<void> {
	try {
		if (backend === 'nvm') {
			if (!entry.is_installed) {
				on_install_phase?.('downloading', entry.version);
				await run_nvm(`install ${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
				on_install_phase?.('installing', entry.version);
				await run_nvm(`use ${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
			} else {
				await run_nvm(`use ${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
			}
		} else if (!entry.is_installed) {
			on_install_phase?.('downloading', entry.version);
			await run_n(`${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
			on_install_phase?.('installing', entry.version);
		} else {
			await run_n(`${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
		}
		await apply_node_environment(context, entry.version, backend, true);
		const applied_raw =
			(context.workspaceState.get<string>(VERSION_STATE_KEY) ?? sanitize_version(entry.version)) ||
			entry.version;
		const applied_n = normalize_version(applied_raw) || applied_raw;
		const backend_resolved = await resolve_backend_cached(context, true);
		await persist_project_selection(context, applied_n, backend_resolved);
		const probed = await get_current_version(backend_resolved, FAST_SHELL_TIMEOUT_MS).catch(() => '');
		const probed_n = probed ? normalize_version(probed) || probed : '';
		const display = probed_n && probed_n === applied_n ? probed_n : applied_n;
		await paint_main_status_bar(context, status_item, display, backend_resolved);
		void warm_local_versions_cache(context, backend_resolved);
		const shown = visible_backend_label(backend_resolved);
		vscode.window.showInformationMessage(
			shown
				? `NodeSwitcher (${shown}) set Node ${display} for new integrated terminals (PATH). Open a new terminal if one is already open.`
				: `NodeSwitcher set Node ${display} for new integrated terminals (PATH). Open a new terminal if one is already open.`
		);
	} catch (error) {
		if (error instanceof InstallCancelledError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`NodeSwitcher failed: ${message}`);
		throw error;
	}
}

export async function refresh_status_bar(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	force = false
): Promise<void> {
	try {
		const backend = await resolve_backend_cached(context, force);
		const current = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS);
		await paint_main_status_bar(context, status_item, current, backend);
	} catch {
		void render_cached_status(context, status_item);
	}
}

export async function repaint_status_bar_for_display_settings(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const backend = context.workspaceState.get<NodeBackend>(BACKEND_STATE_KEY);
	const version = context.workspaceState.get<string>(VERSION_STATE_KEY);
	if (backend && version && version.trim() !== '') {
		const v = normalize_version(version) || version;
		await paint_main_status_bar(context, status_item, v, backend);
		return;
	}
	await render_cached_status(context, status_item);
}

async function get_local_versions(backend: NodeBackend): Promise<VersionEntry[]> {
	const { versions: installed, raw } = await get_installed_versions_with_raw(backend);
	const current = await get_current_version(backend).catch(() => '');
	const line_map = build_version_to_list_lines(raw);
	const mtime_map = await stat_install_dirs_for_versions(backend, installed);
	const entries = await map_versions_async(installed, [], current);
	for (const entry of entries) {
		if (entry.is_installed) {
			entry.manager_list_line = line_map.get(entry.version);
			entry.install_dir_mtime = mtime_map.get(entry.version);
		}
	}
	return entries;
}

async function warm_local_versions_cache(context: vscode.ExtensionContext, backend: NodeBackend): Promise<void> {
	try {
		const local = await get_local_versions(backend);
		await context.workspaceState.update(LOCAL_VERSIONS_KEY, local);
		await context.workspaceState.update(LOCAL_VERSIONS_AT_KEY, Date.now());
	} catch {
		return;
	}
}

async function get_cached_local_versions(context: vscode.ExtensionContext): Promise<VersionEntry[] | null> {
	const cached_at = context.workspaceState.get<number>(LOCAL_VERSIONS_AT_KEY) ?? 0;
	if (Date.now() - cached_at > PROBE_TTL_MS) {
		return null;
	}
	const cached = context.workspaceState.get<VersionEntry[]>(LOCAL_VERSIONS_KEY);
	if (!cached || cached.length === 0) {
		return null;
	}
	return cached;
}

async function resolve_live_version_for_ui(
	context: vscode.ExtensionContext,
	backend: NodeBackend
): Promise<string> {
	try {
		const live = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS);
		return normalize_version(live) || live;
	} catch {
		const stored = context.workspaceState.get<string>(VERSION_STATE_KEY) ?? '';
		return normalize_version(stored) || stored;
	}
}

function rehydrate_entries_current(entries: VersionEntry[], live: string): VersionEntry[] {
	const ln = normalize_version(live) || live;
	if (!ln) {
		return entries.map((e) => ({ ...e, is_current: false }));
	}
	return entries.map((e) => ({
		...e,
		is_current: normalize_version(e.version) === ln
	}));
}

export async function load_switcher_picker_entries(
	context: vscode.ExtensionContext
): Promise<{ backend: NodeBackend; entries: VersionEntry[] } | null> {
	let backend: NodeBackend;
	try {
		backend = await resolve_backend_cached(context, false);
	} catch {
		return null;
	}
	const raw = (await get_cached_local_versions(context)) ?? (await get_local_versions(backend));
	if (raw.length === 0) {
		return null;
	}
	const live = await resolve_live_version_for_ui(context, backend);
	const entries = rehydrate_entries_current(raw, live);
	return { backend, entries };
}

export async function get_versions_with_available(
	context: vscode.ExtensionContext,
	backend: NodeBackend,
	base_entries: VersionEntry[]
): Promise<VersionEntry[]> {
	const installed = base_entries.filter((entry) => entry.is_installed).map((entry) => entry.version);
	const current = await resolve_live_version_for_ui(context, backend);
	const available = await get_available_versions(backend);
	const prior = new Map(base_entries.map((entry) => [entry.version, entry]));
	const rows = await map_versions_async(installed, available, current);
	for (const row of rows) {
		const prev = prior.get(row.version);
		if (prev) {
			row.manager_list_line = prev.manager_list_line ?? row.manager_list_line;
			row.install_dir_mtime = prev.install_dir_mtime ?? row.install_dir_mtime;
		}
	}
	return rows;
}

function version_is_active_row(version: string, current: string): boolean {
	if (!current.trim()) {
		return false;
	}
	return normalize_version(version) === normalize_version(current);
}

async function map_versions_async(installed: string[], available: string[], current: string): Promise<VersionEntry[]> {
	const map = new Map<string, VersionEntry>();
	for (const version of installed) {
		map.set(version, {
			version,
			is_installed: true,
			is_current: version_is_active_row(version, current)
		});
	}
	for (const version of available) {
		const existing = map.get(version);
		if (existing) {
			existing.is_current = existing.is_current || version_is_active_row(version, current);
			continue;
		}
		map.set(version, {
			version,
			is_installed: false,
			is_current: version_is_active_row(version, current)
		});
	}

	const rows = [...map.values()];
	const order = await sort_versions_for_display(rows.map((row) => row.version));
	const rank = new Map(order.map((version, index) => [version, index]));
	return rows.sort((left, right) => rank.get(left.version)! - rank.get(right.version)!);
}

async function get_installed_versions_with_raw(backend: NodeBackend): Promise<{ versions: string[]; raw: string }> {
	if (backend === 'n') {
		const raw = await run_n('ls', DEFAULT_SHELL_TIMEOUT_MS);
		return { versions: parse_versions(raw), raw };
	}
	const raw = await run_nvm_with_fallback(['list', 'ls'], DEFAULT_SHELL_TIMEOUT_MS);
	return { versions: parse_versions(raw), raw };
}

function build_version_to_list_lines(raw: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trimEnd();
		if (!trimmed.trim()) {
			continue;
		}
		const found = parse_versions(trimmed);
		for (const v of found) {
			const key = normalize_version(v);
			const prev = map.get(key);
			if (!prev || trimmed.length > prev.length) {
				map.set(key, trimmed);
			}
		}
	}
	return map;
}

function candidate_install_dirs(backend: NodeBackend, version: string): string[] {
	const v = normalize_version(version);
	const vn = `v${v}`;
	if (backend === 'nvm') {
		if (process.platform === 'win32') {
			const home = process.env.NVM_HOME;
			return home ? [path.join(home, vn)] : [];
		}
		const nvm_dir = process.env.NVM_DIR || path.join(homedir(), '.nvm');
		return [path.join(nvm_dir, 'versions', 'node', vn)];
	}
	if (backend === 'n') {
		const n_prefix = process.env.N_PREFIX || (process.platform === 'win32' ? homedir() : '/usr/local');
		return [path.join(n_prefix, 'n', 'versions', 'node', v), path.join(n_prefix, 'n', 'versions', 'node', vn)];
	}
	return [];
}

export async function resolve_installed_node_executable(
	backend: NodeBackend,
	version: string
): Promise<string | undefined> {
	const v = normalize_version(version);
	for (const dir of candidate_install_dirs(backend, v)) {
		const exe =
			process.platform === 'win32'
				? path.join(dir, 'node.exe')
				: path.join(dir, 'bin', 'node');
		try {
			await fs.access(exe);
			return exe;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function list_candidate_install_roots(backend: NodeBackend, version: string): string[] {
	return candidate_install_dirs(backend, normalize_version(version));
}

export async function uninstall_node_version(backend: NodeBackend, version: string): Promise<void> {
	const raw = normalize_version(version);
	const vn = `v${raw}`;
	if (backend === 'nvm') {
		try {
			await run_nvm(`uninstall ${vn}`);
		} catch {
			await run_nvm(`uninstall ${raw}`);
		}
		return;
	}
	await run_n(`rm ${raw}`);
}

async function try_stat_install_dir(dir: string): Promise<string | undefined> {
	try {
		const st = await fs.stat(dir);
		return st.mtime.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	} catch {
		return undefined;
	}
}

async function stat_install_dirs_for_versions(
	backend: NodeBackend,
	versions: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	await Promise.all(
		versions.map(async (ver) => {
			for (const dir of candidate_install_dirs(backend, ver)) {
				const label = await try_stat_install_dir(dir);
				if (label) {
					out.set(ver, label);
					return;
				}
			}
		})
	);
	return out;
}

async function get_available_versions(backend: NodeBackend): Promise<string[]> {
	try {
		const from_index = await get_latest_stable_per_major_sorted(30);
		if (from_index.length > 0) {
			return from_index;
		}
	} catch {
		// use CLI fallback
	}
	return get_available_versions_cli_fallback(backend);
}

async function get_available_versions_cli_fallback(backend: NodeBackend): Promise<string[]> {
	const raw =
		backend === 'n'
			? await run_n('ls-remote', DEFAULT_SHELL_TIMEOUT_MS)
			: await run_nvm_with_fallback(['list available', 'ls-remote'], DEFAULT_SHELL_TIMEOUT_MS);
	const lines = raw.split(/\r?\n/).filter((line) => !/\brc\.|-rc\b|-beta|-nightly|\balpha\b/i.test(line));
	const versions = parse_versions(lines.join('\n'));
	const by_major = new Map<number, string>();
	for (const version of versions) {
		const major = Number(version.split('.')[0]);
		if (Number.isNaN(major)) {
			continue;
		}
		const prev = by_major.get(major);
		if (!prev || compare_versions_desc(prev, version) > 0) {
			by_major.set(major, version);
		}
	}
	const collapsed = [...by_major.values()];
	const sorted = await sort_versions_for_display(collapsed);
	return sorted.slice(0, 30);
}

async function get_current_version(backend: NodeBackend, timeout_ms = DEFAULT_SHELL_TIMEOUT_MS): Promise<string> {
	if (backend === 'n') {
		const out = await run_n('bin', timeout_ms);
		const bin = out
			.trim()
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.pop();
		if (!bin) {
			throw new Error('Could not read n bin path');
		}
		const { stdout } = await exec_async(`${JSON.stringify(bin)} -v`, { timeout: timeout_ms, env: process.env });
		const v = stdout.trim();
		const parsed = parse_versions(v);
		if (parsed.length > 0) {
			return parsed[0];
		}
		const match = v.match(/v?\d+\.\d+\.\d+/);
		if (match) {
			return normalize_version(match[0]);
		}
		throw new Error('Could not parse node -v from n');
	}
	const output = await run_nvm_with_fallback(['current', 'version'], timeout_ms);
	const parsed = parse_versions(output);
	if (parsed.length > 0) {
		return parsed[0];
	}
	const match = output.match(/v?\d+\.\d+\.\d+/);
	if (match) {
		return normalize_version(match[0]);
	}
	throw new Error('Could not determine current Node version from nvm');
}

async function probe_nvm(timeout_ms: number): Promise<boolean> {
	try {
		await run_nvm_with_fallback(['version', '--version'], timeout_ms);
		return true;
	} catch {
		return false;
	}
}

async function probe_n(timeout_ms: number): Promise<boolean> {
	if (process.platform === 'win32') {
		return false;
	}
	try {
		await run_n('--version', timeout_ms);
		return true;
	} catch {
		try {
			await run_n('ls', timeout_ms);
			return true;
		} catch {
			return false;
		}
	}
}

async function check_and_prompt_nvm_windows(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(NVM_WINDOWS_PROMPT_DISMISSED_KEY) === true) {
		return;
	}
	if (await probe_nvm(FAST_SHELL_TIMEOUT_MS)) {
		return;
	}
	const selection = await vscode.window.showInformationMessage(
		'NodeSwitcher: nvm-windows was not found on PATH. On Windows, NodeSwitcher uses nvm-windows only (not nvm-sh). Install it, then reload the window.',
		"Don't ask again",
		'Copy releases URL',
		'Open releases'
	);
	if (selection === "Don't ask again") {
		await context.globalState.update(NVM_WINDOWS_PROMPT_DISMISSED_KEY, true);
		return;
	}
	if (selection === 'Copy releases URL') {
		await vscode.env.clipboard.writeText(NVM_WINDOWS_RELEASES_URL);
		vscode.window.showInformationMessage('Releases URL copied. After installing, reload the window.');
		return;
	}
	if (selection === 'Open releases') {
		await vscode.env.openExternal(vscode.Uri.parse(NVM_WINDOWS_RELEASES_URL));
	}
}

type NMacInstallPick = vscode.QuickPickItem & { value: 'npm' | 'brew' | 'docs' | 'dismiss' };

async function check_and_prompt_n_macos(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(N_MACOS_PROMPT_DISMISSED_KEY) === true) {
		return;
	}
	if (await probe_n(FAST_SHELL_TIMEOUT_MS)) {
		return;
	}
	const pick = await vscode.window.showQuickPick<NMacInstallPick>(
		[
			{
				label: '$(terminal) Copy npm install (global)',
				description: N_PM_GLOBAL_INSTALL,
				value: 'npm'
			},
			{
				label: '$(package) Copy Homebrew install',
				description: N_BREW_INSTALL,
				value: 'brew'
			},
			{
				label: '$(link-external) Open n (tj/n) on GitHub',
				description: N_MACOS_DOC_URL,
				value: 'docs'
			},
			{ label: "Don't ask again", description: 'Hide this until you reset global state', value: 'dismiss' }
		],
		{
			title: 'NodeSwitcher: install n (macOS)',
			placeHolder: 'On macOS, NodeSwitcher uses the npm package `n`. It was not found on PATH.'
		}
	);
	if (!pick) {
		return;
	}
	if (pick.value === 'dismiss') {
		await context.globalState.update(N_MACOS_PROMPT_DISMISSED_KEY, true);
		return;
	}
	if (pick.value === 'npm') {
		await vscode.env.clipboard.writeText(N_PM_GLOBAL_INSTALL);
		vscode.window.showInformationMessage(
			`Copied \`${N_PM_GLOBAL_INSTALL}\`. Run in a terminal, then reload the window so NodeSwitcher can find n.`
		);
		return;
	}
	if (pick.value === 'brew') {
		await vscode.env.clipboard.writeText(N_BREW_INSTALL);
		vscode.window.showInformationMessage(
			`Copied \`${N_BREW_INSTALL}\`. Run in a terminal, then reload the window so NodeSwitcher can find n.`
		);
		return;
	}
	if (pick.value === 'docs') {
		await vscode.env.openExternal(vscode.Uri.parse(N_MACOS_DOC_URL));
	}
}

export async function check_and_prompt_required_runtime(context: vscode.ExtensionContext): Promise<void> {
	if (process.platform === 'win32') {
		await check_and_prompt_nvm_windows(context);
		return;
	}
	if (process.platform === 'darwin') {
		await check_and_prompt_n_macos(context);
		return;
	}
	await check_and_prompt_nvm_sh_install(context);
}

async function check_and_prompt_nvm_sh_install(context: vscode.ExtensionContext): Promise<void> {
	if (process.platform === 'win32' || process.platform === 'darwin') {
		return;
	}
	if (context.globalState.get<boolean>(NVM_SH_PROMPT_DISMISSED_KEY) === true) {
		return;
	}
	if (await probe_n(FAST_SHELL_TIMEOUT_MS)) {
		return;
	}
	if (await probe_nvm(FAST_SHELL_TIMEOUT_MS)) {
		return;
	}
	const install_one_liner = `curl -fsSL '${NVM_SH_INSTALL_SCRIPT_URL}' | bash`;
	const selection = await vscode.window.showInformationMessage(
		'NodeSwitcher: no Node version manager found (nvm-sh or n). Install official nvm from nvm-sh?',
		'Copy install command',
		"Don't ask again",
		'Install now'
	);
	if (selection === "Don't ask again") {
		await context.globalState.update(NVM_SH_PROMPT_DISMISSED_KEY, true);
		return;
	}
	if (selection === 'Copy install command') {
		await vscode.env.clipboard.writeText(install_one_liner);
		vscode.window.showInformationMessage(
			'Install command copied. Run it in a terminal, then reload the window so your shell loads nvm.'
		);
		return;
	}
	if (selection !== 'Install now') {
		return;
	}
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Installing nvm-sh…',
				cancellable: false
			},
			async () => {
				await exec_async(`/bin/bash -lc ${JSON.stringify(`curl -fsSL '${NVM_SH_INSTALL_SCRIPT_URL}' | bash`)}`, {
					timeout: 300_000,
					env: process.env
				});
			}
		);
		vscode.window.showInformationMessage(
			'nvm-sh install finished. Reload the window or open a new integrated terminal with nvm loaded in your profile.'
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`nvm-sh install failed: ${msg}`);
	}
}

async function resolve_backend_cached(context: vscode.ExtensionContext, force: boolean): Promise<NodeBackend> {
	const cached_backend = context.workspaceState.get<NodeBackend>(BACKEND_PROBE_VALUE_KEY);
	const cached_at = context.workspaceState.get<number>(BACKEND_PROBE_AT_KEY) ?? 0;
	if (!force && cached_backend && Date.now() - cached_at < PROBE_TTL_MS && backend_matches_platform(cached_backend)) {
		return normalize_backend_for_platform(cached_backend);
	}
	const backend = await resolve_backend(null, FAST_SHELL_TIMEOUT_MS);
	const coerced = normalize_backend_for_platform(backend);
	await context.workspaceState.update(BACKEND_PROBE_VALUE_KEY, coerced);
	await context.workspaceState.update(BACKEND_PROBE_AT_KEY, Date.now());
	return coerced;
}

async function ensure_project_selection_prompt(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const workspace_folder = get_workspace_folder_path();
	if (!workspace_folder) {
		return;
	}
	if (await project_nodeswitcher_file_exists(workspace_folder)) {
		return;
	}
	const prompted = context.workspaceState.get<boolean>(PROJECT_PROMPTED_KEY) === true;
	if (prompted) {
		return;
	}
	await context.workspaceState.update(PROJECT_PROMPTED_KEY, true);
	const node_version =
		context.workspaceState.get<string>(VERSION_STATE_KEY) ?? 'unknown';
	const action = await vscode.window.showInformationMessage(
		`NodeSwitcher: You are using Node ${node_version}. No .nodeswitcher file in this project — click "Choose version" to pin a version for integrated terminals, or Dismiss.`,
		'Choose version',
		'Dismiss'
	);
	if (action === 'Choose version') {
		await open_version_picker(context, status_item);
	}
}

async function apply_project_selection_if_present(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const workspace_folder = get_workspace_folder_path();
	if (!workspace_folder) {
		await context.workspaceState.update(PROJECT_PINNED_CACHE_KEY, undefined);
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
		const backend = await resolve_backend_cached(context, false).catch(() => null);
		const stored = context.workspaceState.get<string>(VERSION_STATE_KEY);
		if (backend && stored) {
			await paint_main_status_bar(context, status_item, stored, backend);
		}
		return;
	}
	const state = await read_project_state(workspace_folder);
	if (!state || !state.current) {
		await context.workspaceState.update(PROJECT_PINNED_CACHE_KEY, undefined);
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
		const backend = await resolve_backend_cached(context, false);
		const v =
			(await get_current_version(backend, FAST_SHELL_TIMEOUT_MS).catch(() => null)) ??
			context.workspaceState.get<string>(VERSION_STATE_KEY) ??
			'';
		if (v) {
			const vn = normalize_version(v) || v;
			await paint_main_status_bar(context, status_item, vn, backend);
		}
		return;
	}
	const desired = sanitize_version(state.current);
	if (!desired) {
		return;
	}
	const prev = context.workspaceState.get<string>(PROJECT_PINNED_CACHE_KEY);
	if (prev !== undefined && prev !== desired) {
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
	}
	await context.workspaceState.update(PROJECT_PINNED_CACHE_KEY, desired);

	try {
		const backend = normalize_backend_for_platform(
			state.backend ?? (await resolve_backend_cached(context, false))
		);
		const raw_current = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS).catch(() => '');
		const current_n = raw_current ? normalize_version(raw_current) : '';
		if (!current_n) {
			await apply_node_environment(context, desired, backend, false);
		} else if (current_n === desired) {
			await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
			await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
			await apply_node_environment(context, desired, backend, true);
		} else if (context.workspaceState.get<boolean>(MISMATCH_KEEP_CURRENT_KEY) === true) {
			await apply_node_environment(context, current_n, backend, true);
		} else {
			const fp = `${desired}::${current_n}`;
			const seen = context.workspaceState.get<string>(MISMATCH_PROMPT_FP_KEY);
			if (seen !== fp) {
				const outcome = await run_project_mismatch_prompt(context, backend, desired, current_n);
				if (outcome === 'dismissed') {
					await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, fp);
				}
			}
		}
	} catch {
		// ignore
	}

	const backend_final = await resolve_backend_cached(context, false).catch(() => null);
	if (!backend_final) {
		return;
	}
	const v_final_raw =
		(await get_current_version(backend_final, FAST_SHELL_TIMEOUT_MS).catch(() => null)) ??
		context.workspaceState.get<string>(VERSION_STATE_KEY) ??
		'';
	if (!v_final_raw) {
		return;
	}
	const v_final = normalize_version(v_final_raw) || v_final_raw;
	await paint_main_status_bar(context, status_item, v_final, backend_final);
}

async function persist_project_selection(
	context: vscode.ExtensionContext,
	version: string,
	backend: NodeBackend
): Promise<void> {
	const workspace_folder = get_workspace_folder_path();
	if (!workspace_folder) {
		return;
	}
	const current_state = (await read_project_state(workspace_folder)) ?? { history: [] };
	const history: ProjectHistoryEntry[] = [
		...current_state.history,
		{
			backend,
			selected_at: new Date().toISOString(),
			version
		}
	];
	const next_state: ProjectNodeState = {
		backend,
		current: version,
		history
	};
	await write_project_state(workspace_folder, next_state);
}

function get_workspace_folder_path(): string | null {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return null;
	}
	return folder.uri.fsPath;
}

function get_project_state_path(workspace_path: string): string {
	return path.join(workspace_path, '.nodeswitcher');
}

async function project_nodeswitcher_file_exists(workspace_path: string): Promise<boolean> {
	try {
		await fs.access(get_project_state_path(workspace_path));
		return true;
	} catch {
		return false;
	}
}

async function read_project_state(workspace_path: string): Promise<ProjectNodeState | null> {
	const file_path = get_project_state_path(workspace_path);
	try {
		const raw = await fs.readFile(file_path, 'utf8');
		const parsed = JSON.parse(raw) as Partial<ProjectNodeState>;
		const history = Array.isArray(parsed.history)
			? parsed.history.filter((entry): entry is ProjectHistoryEntry => {
					return (
						typeof entry === 'object' &&
						entry !== null &&
						typeof entry.version === 'string' &&
						typeof entry.selected_at === 'string' &&
						(entry.backend === 'n' || entry.backend === 'nvm')
					);
				})
			: [];
		return {
			backend: parsed.backend === 'n' || parsed.backend === 'nvm' ? parsed.backend : undefined,
			current: typeof parsed.current === 'string' ? parsed.current : undefined,
			history
		};
	} catch {
		return null;
	}
}

export async function get_project_pinned_from_disk(): Promise<string | undefined> {
	const folder = get_workspace_folder_path();
	if (!folder) {
		return undefined;
	}
	const state = await read_project_state(folder);
	if (!state?.current) {
		return undefined;
	}
	const v = sanitize_version(state.current);
	return v || undefined;
}

export async function is_project_node_version_mismatch(context: vscode.ExtensionContext): Promise<boolean> {
	const backend = await resolve_backend_cached(context, false);
	const active_version = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS);
	const pin = await get_project_pinned_from_disk();
	const last_applied = await read_last_applied_or_baseline(context, active_version);
	const drift = normalize_version(active_version) !== normalize_version(last_applied);
	if (drift) {
		return false;
	}
	const ws = get_workspace_folder_path();
	let declared_spec: string | undefined;
	if (ws) {
		declared_spec = await read_declared_node_range(ws);
	}
	const pin_mismatch = pin !== undefined && normalize_version(active_version) !== normalize_version(pin);
	const declared_mismatch =
		declared_spec !== undefined && !active_satisfies_declared_range(active_version, declared_spec);
	return declared_mismatch || pin_mismatch;
}

async function paint_main_status_bar(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	active_version: string,
	backend: NodeBackend
): Promise<void> {
	const pin = await get_project_pinned_from_disk();
	const tag = visible_backend_label(backend);
	if (pin && normalize_version(active_version) === normalize_version(pin)) {
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
	}
	const last_applied = await read_last_applied_or_baseline(context, active_version);
	let live = active_version;
	let drift = normalize_version(live) !== normalize_version(last_applied);
	if (drift && pin && normalize_version(live) === normalize_version(pin)) {
		await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, live);
		drift = false;
	}
	if (
		drift &&
		pin &&
		normalize_version(last_applied) === normalize_version(pin) &&
		normalize_version(live) !== normalize_version(pin)
	) {
		live = normalize_version(pin) || pin;
		drift = false;
	}
	if (drift) {
		status_item.text = status_bar_text('$(warning) Global node version changed', 'warning');
		apply_status_bar_tooltip_global_drift(context, status_item, live, last_applied, tag, pin ?? undefined);
		apply_nodeswitcher_status_bar_style(status_item, 'global_drift');
	} else {
		const ws = get_workspace_folder_path();
		let declared_spec: string | undefined;
		let looks_like_js = false;
		if (ws) {
			declared_spec = await read_declared_node_range(ws);
			looks_like_js = await workspace_looks_like_js_project(ws);
		}
		const pin_mismatch = pin !== undefined && normalize_version(live) !== normalize_version(pin);
		const declared_mismatch =
			declared_spec !== undefined && !active_satisfies_declared_range(live, declared_spec);

		if (declared_mismatch || pin_mismatch) {
			const label_suffix = tag ? ` (${tag})` : '';
			if (declared_mismatch && pin_mismatch) {
				status_item.text = status_bar_text(
					`$(warning) Node ${live}${label_suffix} \u2260 ${declared_spec} & pin ${pin}`,
					'warning'
				);
			} else if (declared_mismatch) {
				status_item.text = status_bar_text(
					`$(warning) Node ${live}${label_suffix} \u2260 ${declared_spec}`,
					'warning'
				);
			} else {
				status_item.text = status_bar_text(format_status_bar_text(live, tag, pin, 'warning'), 'warning');
			}
			apply_project_mismatch_bar_tooltip(
				context,
				status_item,
				tag,
				live,
				declared_mismatch,
				declared_spec,
				pin_mismatch,
				pin
			);
			apply_nodeswitcher_status_bar_style(status_item, 'project_mismatch');
		} else if (
			looks_like_js &&
			!declared_spec &&
			ws &&
			!(await project_nodeswitcher_file_exists(ws))
		) {
			const label_suffix = tag ? ` (${tag})` : '';
			status_item.text = status_bar_text(`$(warning) Specify Node for project${label_suffix}`, 'warning');
			status_item.tooltip = `No .nodeswitcher file and no engines.node / .nvmrc / .node-version (optional: node-version= in .npmrc at project root). Active: ${live}.`;
			apply_nodeswitcher_status_bar_style(status_item, 'project_no_node_spec');
		} else {
			const lead = status_bar_leading_icon(pin, live);
			status_item.text = status_bar_text(format_status_bar_text(live, tag, pin, lead), 'default');
			apply_status_tooltip(context, status_item, tag, pin ?? undefined, live);
			apply_nodeswitcher_status_bar_style(status_item, 'default');
		}
	}
	apply_nodeswitcher_status_bar_visibility(status_item);
	await context.workspaceState.update(VERSION_STATE_KEY, live);
	await context.workspaceState.update(BACKEND_STATE_KEY, backend);
	after_status_paint?.();
}

async function run_project_mismatch_prompt(
	context: vscode.ExtensionContext,
	backend: NodeBackend,
	desired: string,
	current_n: string
): Promise<'resolved' | 'dismissed'> {
	const choice = await vscode.window.showInformationMessage(
		`NodeSwitcher: This project expects Node ${desired} (.nodeswitcher). The active version is ${current_n}.`,
		'Use project version',
		'Keep current'
	);
	if (choice === 'Use project version') {
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, false);
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
		try {
			await apply_node_environment(context, desired, backend, false);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`NodeSwitcher could not switch to Node ${desired}: ${msg}`);
			return 'dismissed';
		}
		return 'resolved';
	}
	if (choice === 'Keep current') {
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, true);
		try {
			await apply_node_environment(context, current_n, backend, true);
			await persist_project_selection(context, current_n, backend);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`NodeSwitcher: ${msg}`);
			return 'dismissed';
		}
		return 'resolved';
	}
	return 'dismissed';
}

export async function run_resolve_project_node_mismatch_command(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const pin = await get_project_pinned_from_disk();
	if (!pin) {
		vscode.window.showInformationMessage('NodeSwitcher: No pinned Node version in .nodeswitcher for this workspace.');
		return;
	}
	const backend = await resolve_backend_cached(context, false);
	const raw = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS).catch(() => '');
	const cur = raw ? normalize_version(raw) : '';
	if (!cur) {
		vscode.window.showErrorMessage('NodeSwitcher: Could not read the active Node version.');
		return;
	}
	if (cur === pin) {
		vscode.window.showInformationMessage(`NodeSwitcher: Active Node ${cur} already matches the project (${pin}).`);
		await paint_main_status_bar(context, status_item, cur, backend);
		return;
	}
	const outcome = await run_project_mismatch_prompt(context, backend, pin, cur);
	if (outcome === 'dismissed') {
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, `${pin}::${cur}`);
	} else {
		await context.workspaceState.update(MISMATCH_PROMPT_FP_KEY, undefined);
	}
	const v_final_raw =
		(await get_current_version(backend, FAST_SHELL_TIMEOUT_MS).catch(() => null)) ??
		context.workspaceState.get<string>(VERSION_STATE_KEY) ??
		cur;
	const v_final = v_final_raw ? normalize_version(v_final_raw) || v_final_raw : cur;
	await paint_main_status_bar(context, status_item, v_final, backend);
}

async function write_project_state(workspace_path: string, state: ProjectNodeState): Promise<void> {
	const file_path = get_project_state_path(workspace_path);
	const serialized = `${JSON.stringify(state, null, 2)}\n`;
	await fs.writeFile(file_path, serialized, 'utf8');
}

async function run_nvm_with_fallback(commands: string[], timeout_ms: number): Promise<string> {
	let last_error: unknown;
	for (const command of commands) {
		try {
			return await run_nvm(command, timeout_ms);
		} catch (error) {
			last_error = error;
		}
	}
	throw last_error instanceof Error ? last_error : new Error('nvm command failed');
}

async function run_nvm(
	args: string,
	timeout_ms = DEFAULT_SHELL_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<string> {
	const command = `nvm ${args}`;
	if (process.platform === 'win32') {
		const ps = `powershell -NoProfile -Command "${command}"`;
		const { stdout, stderr } = signal
			? await exec_async_cancellable(ps, { timeout: timeout_ms, signal })
			: await exec_async(ps, { timeout: timeout_ms });
		return `${stdout}\n${stderr}`;
	}
	const shell = process.env.SHELL ?? '/bin/bash';
	const escaped = command.replace(/"/g, '\\"');
	const sh = `${shell} -lc "${escaped}"`;
	const { stdout, stderr } = signal
		? await exec_async_cancellable(sh, { timeout: timeout_ms, signal })
		: await exec_async(sh, { timeout: timeout_ms });
	return `${stdout}\n${stderr}`;
}

async function run_n(args: string, timeout_ms = DEFAULT_SHELL_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
	if (process.platform === 'win32') {
		throw new Error('n is not supported on Windows');
	}
	const shell = process.env.SHELL ?? '/bin/bash';
	const cmd = `n ${args}`.trim();
	const full = `${shell} -lc ${JSON.stringify(cmd)}`;
	const { stdout, stderr } = signal
		? await exec_async_cancellable(full, { timeout: timeout_ms, env: process.env, signal })
		: await exec_async(full, { timeout: timeout_ms, env: process.env });
	return `${stdout}\n${stderr}`;
}
