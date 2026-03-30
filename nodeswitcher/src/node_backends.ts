import { exec } from 'child_process';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { report_nodeswitcher_failure, truncate_cli_output } from './error_panel';
import {
	ensure_node_release_channels_loaded,
	get_latest_stable_per_major_sorted,
	get_node_release_channels
} from './node_release_index';
import {
	active_satisfies_declared_range,
	declaration_scan_step_count,
	declaration_scan_step_label,
	read_declared_node_range,
	workspace_looks_like_js_project
} from './project_node_spec';
import {
	collect_stable_semver_versions_from_text,
	compare_versions_desc,
	get_version_color,
	normalize_version,
	parse_versions,
	resolve_version_logo_filename,
	resolve_version_release_semantics,
	sanitize_version,
	sort_versions_semver_desc
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
export const SWITCH_NODE_VERSION_COMMAND_ID = 'nodeswitcher.switchNodeVersion';

function bind_status_bar_opens_picker(status_item: vscode.StatusBarItem): void {
	status_item.command = SWITCH_NODE_VERSION_COMMAND_ID;
}

export type NodePickerItem = vscode.QuickPickItem & {
	entry?: VersionEntry;
	action?: 'toggle_available' | 'toggle_installed' | 'open_settings' | 'switch_to_project' | 'skeleton';
};

export const BACKEND_STATE_KEY = 'nodeswitcher.backend';
const BACKEND_PROBE_AT_KEY = 'nodeswitcher.backendProbeAt';
const BACKEND_PROBE_VALUE_KEY = 'nodeswitcher.backendProbeValue';
const BACKEND_RECONCILE_OFFER_AT_KEY = 'nodeswitcher.backendReconcileOfferAt';
const RUNTIME_SNAPSHOT_JSON_KEY = 'nodeswitcher.runtimeSnapshotJson';
const RUNTIME_SNAPSHOT_AT_KEY = 'nodeswitcher.runtimeSnapshotAt';
const N_READY_NO_VERSIONS_HINT_KEY = 'nodeswitcher.nReadyNoVersionsHintShown';
const RUNTIME_SNAPSHOT_TTL_MS = 60_000;
const RUNTIME_PROBE_TIMEOUT_MS = 800;
export const VERSION_STATE_KEY = 'nodeswitcher.activeNodeVersion';
const LAST_APPLIED_VERSION_KEY = 'nodeswitcher.lastAppliedViaExtension';
const PROJECT_PINNED_CACHE_KEY = 'nodeswitcher.projectPinnedVersionCache';
const MISMATCH_KEEP_CURRENT_KEY = 'nodeswitcher.projectMismatchKeepCurrent';
const MISMATCH_PROMPT_FP_KEY = 'nodeswitcher.projectMismatchPromptFingerprint';
const MISMATCH_NOTICE_FP_KEY = 'nodeswitcher.projectMismatchNoticeFingerprint';
const PROBE_TTL_MS = 60_000;
const PROBE_CACHE_VERIFY_AFTER_MS = 25_000;
const FAST_SHELL_TIMEOUT_MS = 1_800;
const LIST_SHELL_TIMEOUT_MS = 15_000;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const BACKEND_RECONCILE_OFFER_COOLDOWN_MS = 120_000;
const PROJECT_PROMPTED_KEY = 'nodeswitcher.projectPrompted';
const PICKER_OPENED_KEY = 'nodeswitcher.pickerOpenedOnce';
const NODE_SWITCHER_TERMINAL_ENV_OPTIONS: vscode.EnvironmentVariableMutatorOptions = {
	applyAtProcessCreation: true,
	applyAtShellIntegration: true
};
const NVM_SH_PROMPT_DISMISSED_KEY = 'nodeswitcher.nvmShInstallDismissed';
const NVM_WINDOWS_PROMPT_DISMISSED_KEY = 'nodeswitcher.nvmWindowsInstallDismissed';
const N_MACOS_PROMPT_DISMISSED_KEY = 'nodeswitcher.nMacosInstallDismissed';
const NVM_SH_INSTALL_SCRIPT_URL =
	'https://raw.githubusercontent.com/nvm-sh/nvm/refs/tags/v0.40.4/install.sh';
const NVM_SH_DOC_URL = 'https://github.com/nvm-sh/nvm';
const NVM_WINDOWS_RELEASES_URL = 'https://github.com/coreybutler/nvm-windows/releases';
const N_MACOS_DOC_URL = 'https://github.com/tj/n';
const N_PM_GLOBAL_INSTALL = 'npm install -g n';
const N_BREW_INSTALL = 'brew install n';
const N_PM_GLOBAL_INSTALL_SUDO = 'sudo npm install -g n';
const N_FIX_USR_LOCAL_N_OWNERSHIP = 'sudo mkdir -p /usr/local/n && sudo chown -R "$(whoami)" /usr/local/n';
const LAST_FAILED_SWITCH_JSON_KEY = 'nodeswitcher.lastFailedSwitchJson';
const INSTALLER_REMEDIATION_DARWIN_KEY = 'nodeswitcher.installerRemediationDarwin';
const INSTALLER_REMEDIATION_UNIX_KEY = 'nodeswitcher.installerRemediationUnix';
const NODESWITCHER_INSTALL_TERMINAL_NAME = 'NodeSwitcher install';
const MANAGER_DETECT_POLL_MS = 2_000;
const MANAGER_DETECT_MAX_MS = 300_000;
export const STATUS_BAR_ICON = 'nodeswitcher-logo';
export const STATUS_BAR_FOREGROUND = '#ffffff';
const VERSION_LABEL_MIN_CHARS = 18;
const ACCORDION_ICON_PAD_RATIO = 0.22;

const PICKER_LOGO_URI_CACHE_MAX = 120;
const padded_picker_logo_uri_cache = new Map<string, vscode.Uri>();

function trim_picker_logo_cache(): void {
	while (padded_picker_logo_uri_cache.size > PICKER_LOGO_URI_CACHE_MAX) {
		const first = padded_picker_logo_uri_cache.keys().next().value;
		if (first === undefined) {
			break;
		}
		padded_picker_logo_uri_cache.delete(first);
	}
}

type LastFailedSwitchPayload = {
	version: string;
	backend: NodeBackend;
	is_installed: boolean;
};

type NPermissionClass = 'usr_local_n' | 'generic';

export type InstallerRemediationMethod = 'user_prefix' | 'chown_usr_local' | 'brew' | 'nvm' | 'npm_sudo';

export type RemediationProgressReporter = {
	onStep?: (index: number, total: number, step: InstallerRemediationMethod, label: string) => void;
	onStepEnd?: (step: InstallerRemediationMethod, ok: boolean) => void;
	onDone?: (outcome: 'success' | 'failed' | 'cancelled', savedMethod?: InstallerRemediationMethod) => void;
};

function installer_remediation_storage_key(): string {
	return process.platform === 'darwin' ? INSTALLER_REMEDIATION_DARWIN_KEY : INSTALLER_REMEDIATION_UNIX_KEY;
}

function is_installer_remediation_method(value: string | undefined): value is InstallerRemediationMethod {
	return (
		value === 'user_prefix' ||
		value === 'chown_usr_local' ||
		value === 'brew' ||
		value === 'nvm' ||
		value === 'npm_sudo'
	);
}

export function get_saved_installer_remediation_method(
	context: vscode.ExtensionContext
): InstallerRemediationMethod | undefined {
	const raw = context.globalState.get<string>(installer_remediation_storage_key());
	return is_installer_remediation_method(raw) ? raw : undefined;
}

async function save_installer_remediation_method(
	context: vscode.ExtensionContext,
	method: InstallerRemediationMethod
): Promise<void> {
	await context.globalState.update(installer_remediation_storage_key(), method);
}

export function get_ordered_installer_remediation_steps(
	saved: InstallerRemediationMethod | undefined,
	platform_has_brew: boolean
): InstallerRemediationMethod[] {
	let all: InstallerRemediationMethod[] = ['user_prefix', 'chown_usr_local', 'brew', 'nvm', 'npm_sudo'];
	if (!platform_has_brew) {
		all = all.filter((s) => s !== 'brew');
	}
	if (!saved || !all.includes(saved)) {
		return all;
	}
	return [saved, ...all.filter((s) => s !== saved)];
}

async function test_n_can_list_versions(): Promise<boolean> {
	if (process.platform === 'win32') {
		return false;
	}
	try {
		await run_n('ls', FAST_SHELL_TIMEOUT_MS);
		return true;
	} catch {
		return false;
	}
}

async function poll_until_remediation(
	token: vscode.CancellationToken,
	predicate: () => Promise<boolean>
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < MANAGER_DETECT_MAX_MS && !token.isCancellationRequested) {
		if (await predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, MANAGER_DETECT_POLL_MS));
	}
	return false;
}

async function try_user_prefix_remediation(context: vscode.ExtensionContext): Promise<boolean> {
	const dir = path.join(homedir(), '.n');
	await fs.mkdir(dir, { recursive: true });
	await vscode.workspace
		.getConfiguration('nodeswitcher')
		.update('nPrefix', dir, vscode.ConfigurationTarget.Global);
	void get_runtime_snapshot_cached(context, true).catch(() => undefined);
	return test_n_can_list_versions();
}

async function offer_retry_after_remediation(context: vscode.ExtensionContext, headline: string): Promise<void> {
	const pending = context.workspaceState.get<string>(LAST_FAILED_SWITCH_JSON_KEY);
	await resolve_backend_cached(context, true).catch(() => undefined);
	void get_runtime_snapshot_cached(context, true).catch(() => undefined);
	if (pending) {
		const choice = await vscode.window.showInformationMessage(
			headline,
			'Retry last Node switch',
			'Open version picker',
			'Dismiss'
		);
		if (choice === 'Retry last Node switch') {
			await vscode.commands.executeCommand('nodeswitcher.retryLastNodeSwitch');
		} else if (choice === 'Open version picker') {
			await vscode.commands.executeCommand('nodeswitcher.openVersionPickerQuickPick');
		}
	} else {
		void vscode.window.showInformationMessage(`${headline} Open the version picker when ready.`);
	}
}

export function installer_remediation_step_label(step: InstallerRemediationMethod): string {
	switch (step) {
		case 'user_prefix':
			return 'user N_PREFIX (~/.n) + settings';
		case 'chown_usr_local':
			return 'fix /usr/local/n ownership (sudo in terminal)';
		case 'brew':
			return 'brew install n';
		case 'nvm':
			return 'install nvm-sh';
		case 'npm_sudo':
			return 'sudo npm install -g n';
		default:
			return step;
	}
}

async function execute_installer_remediation_step(
	context: vscode.ExtensionContext,
	step: InstallerRemediationMethod,
	terminal: vscode.Terminal,
	token: vscode.CancellationToken
): Promise<boolean> {
	switch (step) {
		case 'user_prefix':
			return try_user_prefix_remediation(context);
		case 'chown_usr_local':
			terminal.show(true);
			terminal.sendText(N_FIX_USR_LOCAL_N_OWNERSHIP, true);
			return poll_until_remediation(token, () => test_n_can_list_versions());
		case 'brew':
			terminal.show(true);
			terminal.sendText(N_BREW_INSTALL, true);
			return poll_until_remediation(token, () => test_n_can_list_versions());
		case 'nvm':
			terminal.show(true);
			terminal.sendText(`curl -fsSL '${NVM_SH_INSTALL_SCRIPT_URL}' | bash`, true);
			return poll_until_remediation(token, () => probe_nvm(FAST_SHELL_TIMEOUT_MS));
		case 'npm_sudo':
			terminal.show(true);
			terminal.sendText(N_PM_GLOBAL_INSTALL_SUDO, true);
			return poll_until_remediation(token, () => test_n_can_list_versions());
		default:
			return false;
	}
}

async function run_chained_installer_remediation_loop(
	context: vscode.ExtensionContext,
	steps: InstallerRemediationMethod[],
	terminal: vscode.Terminal,
	token: vscode.CancellationToken,
	reporter: RemediationProgressReporter | undefined,
	notification_report: ((message: string) => void) | undefined
): Promise<'success' | 'failed' | 'cancelled'> {
	for (let i = 0; i < steps.length; i++) {
		if (token.isCancellationRequested) {
			reporter?.onDone?.('cancelled');
			void vscode.window.showInformationMessage('NodeSwitcher: Repair cancelled.');
			return 'cancelled';
		}
		const step = steps[i]!;
		const label = installer_remediation_step_label(step);
		const line = `${i + 1}/${steps.length}: ${label}`;
		notification_report?.(line);
		reporter?.onStep?.(i + 1, steps.length, step, label);
		const ok = await execute_installer_remediation_step(context, step, terminal, token);
		reporter?.onStepEnd?.(step, ok);
		if (ok) {
			await save_installer_remediation_method(context, step);
			reporter?.onDone?.('success', step);
			await offer_retry_after_remediation(
				context,
				`NodeSwitcher: repair step "${label}" worked. Saved as preferred installer fix for this OS.`
			);
			return 'success';
		}
	}
	reporter?.onDone?.('failed');
	void vscode.window.showWarningMessage(
		'NodeSwitcher: Automatic repair did not fix n/nvm. Reload the window or install tools outside VS Code.'
	);
	return 'failed';
}

export async function run_single_installer_remediation_step(
	context: vscode.ExtensionContext,
	step: InstallerRemediationMethod,
	token: vscode.CancellationToken
): Promise<boolean> {
	if (process.platform === 'win32') {
		return false;
	}
	const terminal = get_or_create_install_terminal();
	const ok = await execute_installer_remediation_step(context, step, terminal, token);
	if (ok) {
		await save_installer_remediation_method(context, step);
		await offer_retry_after_remediation(
			context,
			`NodeSwitcher: step "${installer_remediation_step_label(step)}" worked. Saved as preferred fix.`
		);
	}
	return ok;
}

export async function run_chained_installer_remediation(
	context: vscode.ExtensionContext,
	options?: { reporter?: RemediationProgressReporter; token?: vscode.CancellationToken }
): Promise<'success' | 'failed' | 'cancelled'> {
	if (process.platform === 'win32') {
		void vscode.window.showInformationMessage('NodeSwitcher: Automatic installer repair is for macOS/Linux only.');
		return 'failed';
	}
	const snap = await get_runtime_snapshot_cached(context, false).catch(() => null);
	const platform_has_brew = process.platform === 'darwin' || snap?.has_brew === true;
	const saved = get_saved_installer_remediation_method(context);
	const steps = get_ordered_installer_remediation_steps(saved, platform_has_brew);
	const terminal = get_or_create_install_terminal();
	const reporter = options?.reporter;
	const token = options?.token;
	if (token !== undefined) {
		return run_chained_installer_remediation_loop(context, steps, terminal, token, reporter, undefined);
	}
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'NodeSwitcher: installer repair',
			cancellable: true
		},
		async (progress, progress_token) =>
			run_chained_installer_remediation_loop(
				context,
				steps,
				terminal,
				progress_token,
				reporter,
				(message) => progress.report({ message })
			)
	);
}

function get_resolved_n_prefix_from_config(): string | undefined {
	const raw = vscode.workspace.getConfiguration('nodeswitcher').get<string>('nPrefix', '').trim();
	if (!raw) {
		return undefined;
	}
	if (raw.startsWith('~')) {
		const rest = raw.slice(1).replace(/^\//, '');
		return path.join(homedir(), rest);
	}
	return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

function n_process_env(): NodeJS.ProcessEnv {
	const np = get_resolved_n_prefix_from_config();
	if (!np) {
		return process.env;
	}
	return { ...process.env, N_PREFIX: np };
}

function n_install_prefix_for_paths(): string {
	const cfg = get_resolved_n_prefix_from_config();
	if (cfg) {
		return cfg;
	}
	if (process.env.N_PREFIX) {
		return process.env.N_PREFIX;
	}
	return process.platform === 'win32' ? homedir() : '/usr/local';
}

function classify_n_permission_error(error: unknown): NPermissionClass {
	const t = error_text(error);
	if (/\/usr\/local\/n\b/i.test(t)) {
		return 'usr_local_n';
	}
	if (/sudo required/i.test(t) && /N_PREFIX|\/usr\/local/i.test(t)) {
		return 'usr_local_n';
	}
	if (/N_PREFIX/i.test(t) && /permission denied|mkdir/i.test(t)) {
		return 'usr_local_n';
	}
	return 'generic';
}

function n_permission_reconciliation_hint(error: unknown): string {
	if (classify_n_permission_error(error) !== 'usr_local_n') {
		return 'After fixing permissions or setting nodeswitcher.nPrefix, use Command Palette: NodeSwitcher: Retry Last Node Version Switch.';
	}
	return `n needs a writable install prefix. Set nodeswitcher.nPrefix to e.g. ${path.join(
		homedir(),
		'.n'
	)}, reload the window, or fix /usr/local/n ownership. Then: NodeSwitcher: Retry Last Node Version Switch.`;
}

async function persist_last_failed_switch(
	context: vscode.ExtensionContext,
	backend: NodeBackend,
	entry: VersionEntry
): Promise<void> {
	const payload: LastFailedSwitchPayload = {
		version: entry.version,
		backend,
		is_installed: entry.is_installed
	};
	await context.workspaceState.update(LAST_FAILED_SWITCH_JSON_KEY, JSON.stringify(payload));
}

async function clear_last_failed_switch(context: vscode.ExtensionContext): Promise<void> {
	await context.workspaceState.update(LAST_FAILED_SWITCH_JSON_KEY, undefined);
}

export async function retry_last_failed_node_switch(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem
): Promise<void> {
	const raw = context.workspaceState.get<string>(LAST_FAILED_SWITCH_JSON_KEY);
	if (!raw) {
		vscode.window.showInformationMessage('NodeSwitcher: No failed switch to retry.');
		return;
	}
	let parsed: LastFailedSwitchPayload;
	try {
		parsed = JSON.parse(raw) as LastFailedSwitchPayload;
	} catch {
		await clear_last_failed_switch(context);
		vscode.window.showInformationMessage('NodeSwitcher: Retry state was invalid; cleared.');
		return;
	}
	if (!parsed.version || (parsed.backend !== 'n' && parsed.backend !== 'nvm')) {
		await clear_last_failed_switch(context);
		return;
	}
	const entry: VersionEntry = {
		version: parsed.version,
		is_installed: parsed.is_installed,
		is_current: false
	};
	await apply_picked_version_entry(context, status_item, parsed.backend, entry);
}

function get_max_other_available_versions(): number {
	const n = vscode.workspace.getConfiguration('nodeswitcher').get<number>('maxOtherAvailableVersions', 200);
	if (!Number.isFinite(n) || n < 10) {
		return 200;
	}
	return Math.min(2000, Math.floor(n));
}

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
		if (await probe_n(timeout_ms)) {
			return 'n';
		}
		if (await probe_nvm(timeout_ms)) {
			return 'nvm';
		}
		throw new Error(
			`On macOS, NodeSwitcher prefers n and falls back to nvm. Install \`n\` with \`${N_PM_GLOBAL_INSTALL}\` or \`${N_BREW_INSTALL}\`, or install nvm from ${NVM_SH_DOC_URL}, then reload.`
		);
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
	throw new Error(
		`Neither n nor nvm-sh was found on PATH. On Linux/Unix install n (e.g. \`${N_PM_GLOBAL_INSTALL}\` or your distribution's package) or nvm from ${NVM_SH_DOC_URL}, then reload.`
	);
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
	| 'project_no_node_spec'
	| 'project_match'
	| 'probe_error';

export function apply_nodeswitcher_status_bar_style(
	status_item: vscode.StatusBarItem,
	variant: NodeswitcherStatusBarVariant = 'default'
): void {
	if (variant === 'probe_error') {
		status_item.color = STATUS_BAR_FOREGROUND;
		status_item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		return;
	}
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
	if (variant === 'project_match') {
		status_item.color = new vscode.ThemeColor('nodeswitcher.statusBarMatchForeground');
		status_item.backgroundColor = new vscode.ThemeColor('nodeswitcher.statusBarMatchBackground');
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

function set_initializer_loading_phase(status_item: vscode.StatusBarItem, title: string, tooltip?: string): void {
	status_item.text = status_bar_text(`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — ${title}`, 'loading');
	status_item.tooltip = tooltip ?? `NodeSwitcher — ${title}`;
	apply_nodeswitcher_status_bar_style(status_item);
	apply_nodeswitcher_status_bar_visibility(status_item);
	bind_status_bar_opens_picker(status_item);
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
		bind_status_bar_opens_picker(status_item);
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
	bind_status_bar_opens_picker(status_item);
	after_status_paint?.();
}

export async function initialize_status(context: vscode.ExtensionContext, status_item: vscode.StatusBarItem): Promise<void> {
	status_item.text = status_bar_text(`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — scanning project…`, 'loading');
	status_item.tooltip =
		'NodeSwitcher is scanning project Node declarations (.nodeswitcher, package.json, project .npmrc, …)…';
	apply_nodeswitcher_status_bar_style(status_item);
	apply_nodeswitcher_status_bar_visibility(status_item);
	bind_status_bar_opens_picker(status_item);
	const ws = get_workspace_folder_path();
	const scan_lines: string[] = [];
	const total = declaration_scan_step_count();
	if (ws) {
		try {
			await read_declared_node_range(ws, {
				onProgress: async (ev) => {
					const label = declaration_scan_step_label(ev.step);
					const line = ev.found
						? `$(pass) ${label} — ${(ev.value ?? '').trim()}`
						: `$(check) ${label} — not set`;
					scan_lines.push(line);
					const n = scan_lines.length;
					const header = 'NodeSwitcher — project declaration (in order; stops at first match):';
					status_item.tooltip = [header, ...scan_lines].join('\n');
					if (ev.found) {
						status_item.tooltip += `\n\nUsing declaration from ${label}.`;
						status_item.text = status_bar_text(
							`$(pass) $(${STATUS_BAR_ICON}) NodeSwitcher — ${label}`,
							'loading'
						);
					} else {
						status_item.text = status_bar_text(
							`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — scan ${n}/${total}`,
							'loading'
						);
					}
					bind_status_bar_opens_picker(status_item);
				}
			});
			const found_decl = scan_lines.some((l) => l.startsWith('$(pass)'));
			if (scan_lines.length > 0 && !found_decl) {
				status_item.tooltip = [
					'NodeSwitcher — project declaration (in order; stops at first match):',
					...scan_lines,
					'',
					'No declaration found in any step; active Node comes from your version manager only.'
				].join('\n');
			}
		} catch {
			// ignore scan errors; read_declared_node_range is re-run when painting status
		}
	}

	let runtime_snap: RuntimeSnapshot | undefined;
	if (process.platform !== 'win32') {
		set_initializer_loading_phase(status_item, 'Checking Node tools…', 'Probing PATH for node, n, nvm, brew…');
		runtime_snap = await get_runtime_snapshot_cached(context, false);
		set_initializer_loading_phase(
			status_item,
			'Resolving version manager…',
			runtime_snapshot_tooltip_detail(runtime_snap)
		);
	} else {
		status_item.text = status_bar_text(
			`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — resolving version manager…`,
			'loading'
		);
		status_item.tooltip = 'NodeSwitcher — resolving Node version manager (n / nvm)…';
		apply_nodeswitcher_status_bar_style(status_item);
		apply_nodeswitcher_status_bar_visibility(status_item);
		bind_status_bar_opens_picker(status_item);
	}

	try {
		const backend = await resolve_backend_cached(context, true);
		if (process.platform !== 'win32' && runtime_snap) {
			set_initializer_loading_phase(
				status_item,
				'Reading active Node version…',
				runtime_snapshot_tooltip_detail(runtime_snap)
			);
		} else {
			status_item.text = status_bar_text(
				`$(sync~spin) $(${STATUS_BAR_ICON}) NodeSwitcher — reading Node version…`,
				'loading'
			);
			status_item.tooltip = 'NodeSwitcher — reading active Node version…';
			apply_nodeswitcher_status_bar_style(status_item);
			apply_nodeswitcher_status_bar_visibility(status_item);
			bind_status_bar_opens_picker(status_item);
		}
		const current = await get_current_version(backend, 5_000);
		const current_n = normalize_version(current) || current;
		await context.workspaceState.update(VERSION_STATE_KEY, current_n);
		await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, current_n);
		await context.workspaceState.update(BACKEND_STATE_KEY, backend);
		await apply_project_selection_if_present(context, status_item);
		await ensure_project_selection_prompt(context, status_item);
	} catch (e) {
		await handle_status_bar_backend_failure(context, status_item, e);
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

export function register_new_terminal_applied_node_banner(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal((terminal) => {
			if (terminal.name === NODESWITCHER_INSTALL_TERMINAL_NAME) {
				return;
			}
			const raw = context.workspaceState.get<string>(VERSION_STATE_KEY);
			const n = raw ? normalize_version(raw) || raw.trim() : '';
			if (!n) {
				return;
			}
			const line = `nodeswitcher: node.js ${node_version_display_v(n)}`;
			if (process.platform === 'win32') {
				terminal.sendText(`Write-Host ${JSON.stringify(line)} -ForegroundColor DarkCyan`, true);
			} else {
				terminal.sendText(`echo "${line}"`, true);
			}
		})
	);
}

export async function apply_node_environment(
	context: vscode.ExtensionContext,
	version: string,
	backend: NodeBackend,
	already_switched = false
): Promise<{ bin_dir: string }> {
	const safe = sanitize_version(version);
	if (!safe) {
		throw new Error('Invalid Node version');
	}
	const node_exe = await resolve_node_executable(safe, backend, already_switched);
	const bin_dir = path.dirname(node_exe.trim());
	const sep = path.delimiter;
	const scoped = get_nodeswitcher_terminal_env_collection(context);
	scoped.delete('PATH');
	scoped.prepend('PATH', `${bin_dir}${sep}`, NODE_SWITCHER_TERMINAL_ENV_OPTIONS);
	if (backend === 'n') {
		const np = get_resolved_n_prefix_from_config();
		if (np) {
			scoped.replace('N_PREFIX', np, NODE_SWITCHER_TERMINAL_ENV_OPTIONS);
		} else {
			scoped.delete('N_PREFIX');
		}
	} else {
		scoped.delete('N_PREFIX');
	}
	await context.workspaceState.update(VERSION_STATE_KEY, safe);
	await context.workspaceState.update(BACKEND_STATE_KEY, backend);
	await context.workspaceState.update(LAST_APPLIED_VERSION_KEY, safe);
	return { bin_dir };
}

type Windows_terminal_shell_kind = 'cmd' | 'powershell' | 'posix';

function integrated_terminal_shell_kind_win32(terminal: vscode.Terminal): Windows_terminal_shell_kind {
	const o = terminal.creationOptions;
	if ('shellPath' in o && typeof o.shellPath === 'string') {
		const sp = o.shellPath.toLowerCase().replace(/\\/g, '/');
		if (sp.includes('cmd.exe')) {
			return 'cmd';
		}
		if (sp.includes('wsl.exe') || sp.includes('wslhost') || sp.endsWith('/wsl')) {
			return 'posix';
		}
		if (
			sp.includes('bash.exe') ||
			sp.includes('/bash') ||
			sp.includes('git\\bin\\bash') ||
			sp.includes('git/bin/bash')
		) {
			return 'posix';
		}
	}
	return 'powershell';
}

function bash_escape_double(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

function post_switch_active_integrated_terminal(
	terminal: vscode.Terminal | undefined,
	bin_dir: string,
	backend: NodeBackend,
	from_version_raw: string | undefined,
	to_version_raw: string
): void {
	if (!terminal || terminal.name === NODESWITCHER_INSTALL_TERMINAL_NAME) {
		return;
	}
	const from_label = from_version_raw?.trim()
		? node_version_display_v(from_version_raw.trim())
		: 'unknown';
	const to_label = node_version_display_v(to_version_raw.trim());
	const notice = `NodeSwitcher: node version change from ${from_label} to ${to_label}`;
	const np = backend === 'n' ? get_resolved_n_prefix_from_config() : undefined;

	if (process.platform === 'win32') {
		const kind = integrated_terminal_shell_kind_win32(terminal);
		if (kind === 'cmd') {
			terminal.sendText(`set "PATH=${bin_dir};%PATH%"`, true);
			if (np) {
				terminal.sendText(`set "N_PREFIX=${np}"`, true);
			}
			terminal.sendText(`echo ${notice}`, true);
			return;
		}
		if (kind === 'posix') {
			terminal.sendText(`export PATH="${bash_escape_double(bin_dir)}:$PATH"`, true);
			if (np) {
				terminal.sendText(`export N_PREFIX="${bash_escape_double(np)}"`, true);
			}
			terminal.sendText(`echo "${bash_escape_double(notice)}"`, true);
			return;
		}
		const ps_bin = bin_dir.replace(/'/g, "''");
		terminal.sendText(`$env:Path = '${ps_bin};' + $env:Path`, true);
		if (np) {
			const ps_np = np.replace(/'/g, "''");
			terminal.sendText(`$env:N_PREFIX = '${ps_np}'`, true);
		}
		terminal.sendText(`Write-Host ${JSON.stringify(notice)} -ForegroundColor Cyan`, true);
		return;
	}

	terminal.sendText(`export PATH="${bash_escape_double(bin_dir)}:$PATH"`, true);
	if (np) {
		terminal.sendText(`export N_PREFIX="${bash_escape_double(np)}"`, true);
	}
	terminal.sendText(`echo "${bash_escape_double(notice)}"`, true);
}

function parse_n_bin_output_line(out: string): string | undefined {
	const bin = out
		.trim()
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
		.pop();
	return bin || undefined;
}

function n_output_indicates_version_required(text: string): boolean {
	return /version required/i.test(text);
}

async function try_n_which_node_path(version: string): Promise<string | undefined> {
	try {
		const raw = await run_n(`which ${version}`);
		if (n_output_indicates_version_required(raw)) {
			return undefined;
		}
		const p = parse_n_bin_output_line(raw);
		if (!p) {
			return undefined;
		}
		try {
			await fs.access(p);
			return p;
		} catch {
			return undefined;
		}
	} catch (err) {
		const raw = combined_exec_error_text(err);
		if (n_output_indicates_version_required(raw)) {
			return undefined;
		}
		return undefined;
	}
}

async function resolve_node_executable(version: string, backend: NodeBackend, already_switched: boolean): Promise<string> {
	if (backend === 'n') {
		if (!already_switched) {
			await run_n(`${version}`);
		}
		const read_n_bin_path = async (): Promise<{ path: string | undefined; raw: string }> => {
			try {
				const raw = await run_n('bin');
				if (n_output_indicates_version_required(raw)) {
					return { path: undefined, raw };
				}
				return { path: parse_n_bin_output_line(raw), raw };
			} catch (err) {
				const raw = combined_exec_error_text(err);
				if (n_output_indicates_version_required(raw)) {
					return { path: undefined, raw };
				}
				throw err;
			}
		};
		let { path: bin, raw } = await read_n_bin_path();
		const needs_retry = !bin || n_output_indicates_version_required(raw);
		if (needs_retry) {
			await run_n(`${version}`);
			({ path: bin, raw } = await read_n_bin_path());
		}
		if (!bin || n_output_indicates_version_required(raw)) {
			const which_path = await try_n_which_node_path(version);
			if (which_path) {
				return which_path;
			}
			const disk_path = await resolve_installed_node_executable('n', version);
			if (disk_path) {
				return disk_path;
			}
			throw new Error(
				'n is installed but has no active Node version yet. In a terminal run `n lts` or pick a version in NodeSwitcher, then reload if needed.'
			);
		}
		return bin;
	}
	if (backend === 'nvm') {
		const disk_path = await resolve_installed_node_executable('nvm', version);
		if (disk_path) {
			return disk_path;
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
		const script = `${unix_nvm_init_bash()}; nvm use ${version} >/dev/null || exit 1; command -v node`;
		const { stdout } = await exec_async(`/bin/bash -lc ${JSON.stringify(script)}`, {
			timeout: 120000,
			env: process.env
		});
		const node_path = stdout.trim().split('\n').filter(Boolean).pop();
		if (!node_path) {
			throw new Error('Could not resolve node after nvm use');
		}
		return node_path;
	}
	throw new Error('Could not resolve Node executable');
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
	status_item.tooltip = 'NodeSwitcher — choose a Node version…';
	bind_status_bar_opens_picker(status_item);
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

		const apply_entry_from_picker = async (entry: VersionEntry, prefer_switch_feedback = false) => {
			if (backend === undefined) {
				return;
			}
			const b = backend;
			const show_progress = prefer_switch_feedback || !entry.is_installed;
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
				const verb =
					phase === 'downloading'
						? 'Downloading'
						: prefer_switch_feedback
							? 'Switching'
							: 'Installing';
				quick_pick.placeholder = `${verb} ${vv}...`;
				quick_pick.title = `${verb} Node ${version}`;
			};
			try {
				if (show_progress) {
					on_phase(prefer_switch_feedback && entry.is_installed ? 'installing' : 'downloading', entry.version);
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
						true,
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
							true,
							true
						);
						return;
					}
					quick_pick.busy = true;
					quick_pick.enabled = false;
					try {
						current_entries = await get_versions_with_available(context, b, current_entries);
						include_available = true;
						include_installed = false;
						quick_pick.items = build_version_picker_items(
							current_entries,
							b,
							include_available,
							include_installed,
							project_pin,
							context.extensionPath,
							false,
							true,
							true
						);
					} catch (error) {
						report_nodeswitcher_failure(
							context,
							'NodeSwitcher failed to load other available Node versions.',
							error
						);
					} finally {
						quick_pick.busy = false;
						quick_pick.enabled = true;
					}
					return;
				}
				if (selected.action === 'toggle_installed') {
					include_installed = !include_installed;
					if (include_installed) {
						include_available = false;
					}
					quick_pick.items = build_version_picker_items(
						current_entries,
						b,
						include_available,
						include_installed,
						project_pin,
						context.extensionPath,
						false,
						true,
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
					await apply_entry_from_picker(selected.entry, selected.action === 'switch_to_project');
					finish(selected.entry);
				} catch (err) {
					if (err instanceof InstallCancelledError) {
						if (!picker_closed) {
							vscode.window.showInformationMessage('Install cancelled. Node version was not changed.');
						}
						return;
					}
					const detail = error_text(err);
					const hint = n_permission_reconciliation_hint(err);
					const target = normalize_version(selected.entry.version);
					quick_pick.title = 'Node switch failed';
					quick_pick.placeholder = `Failed to apply ${node_version_display_v(selected.entry.version)}.`;
					quick_pick.items = quick_pick.items.map((item) => {
						if (!item.entry || normalize_version(item.entry.version) !== target) {
							return item;
						}
						return {
							...item,
							label: `$(warning) ${item.label}`,
							description: 'Switch failed. Press Enter to retry.',
							detail: `${detail}\n\n${hint}\n\nPress Enter to retry.`,
							iconPath: new vscode.ThemeIcon('warning')
						};
					});
					quick_pick.activeItems = [selected];
					quick_pick.selectedItems = [selected];
				}
			}),
			quick_pick.onDidHide(() => {
				if (active_install_abort !== undefined) {
					return;
				}
				finish(undefined);
			})
		);
		quick_pick.show();
		void (async () => {
			quick_pick.busy = true;
			try {
				let b: NodeBackend;
				try {
					b = await resolve_backend_cached(context, false);
				} catch (e) {
					if (!picker_closed) {
						const text = `NodeSwitcher could not use the Node version manager for this OS (${host_platform_label()}). Install the required tool and reload the window.`;
						report_nodeswitcher_failure(context, text, e);
						void offer_backend_install_recovery(context);
						finish(undefined);
					}
					return;
				}
				if (picker_closed) {
					return;
				}
				backend = b;
				let raw_entries: VersionEntry[];
				let live: string;
				let pin: string | undefined;
				try {
					[raw_entries, live, pin] = await Promise.all([
						get_local_versions(b, { omitCurrentProbe: true }),
						resolve_live_version_for_ui(context, b),
						get_project_pinned_from_disk()
					]);
				} catch (e) {
					if (!picker_closed) {
						report_nodeswitcher_failure(
							context,
							'NodeSwitcher could not list installed Node versions.',
							e
						);
						finish(undefined);
					}
					return;
				}
				if (picker_closed) {
					return;
				}
				if (raw_entries.length === 0) {
					try {
						raw_entries = await get_versions_with_available(context, b, []);
						if (raw_entries.length > 0) {
							include_available = true;
							include_installed = false;
						}
					} catch {
						/* fall through to probe error handling */
					}
				}
				if (raw_entries.length === 0) {
					try {
						const probe = await get_installed_versions_with_raw(b);
						if (probe.versions.length === 0 && probe.raw.trim().length > 0) {
							report_nodeswitcher_failure(
								context,
								'NodeSwitcher could not parse installed versions from your version manager.',
								`Output (truncated):\n${truncate_cli_output(probe.raw, 4000)}`
							);
						} else {
							report_nodeswitcher_failure(
								context,
								'NodeSwitcher could not list installed Node versions.',
								'No installed versions were returned or parsed.'
							);
						}
					} catch (probeErr) {
						report_nodeswitcher_failure(
							context,
							'NodeSwitcher could not read installed Node versions.',
							probeErr
						);
					}
					finish(undefined);
					return;
				}
				project_pin = pin;
				current_entries = rehydrate_entries_current(raw_entries, live);
				loaded = true;
				const tool_hint = visible_backend_label(backend);
				quick_pick.placeholder = tool_hint
					? `Select a Node version · ${tool_hint} · ${host_platform_label()}`
					: `Select a Node version · ${host_platform_label()}`;
				if (!picker_closed) {
					quick_pick.busy = false;
				}
				if (!picker_closed) {
					quick_pick.items = build_version_picker_items(
						current_entries,
						backend,
						include_available,
						include_installed,
						project_pin,
						context.extensionPath,
						false,
						true,
						true
					);
				}
				void ensure_node_release_channels_loaded().then(() => {
					if (picker_closed || backend === undefined || !loaded) {
						return;
					}
					quick_pick.items = build_version_picker_items(
						current_entries,
						backend,
						include_available,
						include_installed,
						project_pin,
						context.extensionPath,
						false,
						true,
						true
					);
				});
			} finally {
				if (!picker_closed && quick_pick.busy) {
					quick_pick.busy = false;
				}
			}
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
		bind_status_bar_opens_picker(status_item);
	}
}

function build_installed_picker_tooltip(
	entry: VersionEntry,
	backend: NodeBackend,
	role: 'current' | 'installed' | 'available',
	channel: string
): string {
	const tool = backend === 'nvm' ? 'nvm' : 'n';
	const lines: string[] = [];
	lines.push(`Node ${entry.version}`);
	if (channel) {
		lines.push(`Release: ${channel}`);
	}
	if (entry.manager_list_line) {
		lines.push(`${tool} list: ${entry.manager_list_line}`);
	} else if (entry.install_dir_mtime) {
		lines.push(`Install folder last modified: ${entry.install_dir_mtime}`);
	}
	if (role === 'current') {
		lines.push('Active for this workspace.');
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
	trim_picker_logo_cache();
	return uri;
}

function quick_pick_project_switch_uri(extension_path: string): vscode.Uri {
	return vscode.Uri.file(path.join(extension_path, 'media', 'picker', 'project-switch.svg'));
}

function picker_channel_kind_display(badge: string): string {
	const t = badge.trim().replace(/\s+/g, ' ');
	return t;
}

function picker_version_state_label(version: string, badge: string): string {
	const channel = picker_channel_kind_display(badge).trim();
	return channel ? `${version} (${channel})` : version;
}

function pad_icon_status_column_right(icon: string, columnCharWidth: number): string {
	const pad = '\u2007';
	if (icon.length >= columnCharWidth) {
		return icon;
	}
	return pad.repeat(columnCharWidth - icon.length) + icon;
}

export function build_version_picker_items(
	entries: VersionEntry[],
	backend: NodeBackend,
	include_available: boolean,
	include_installed: boolean,
	project_pin: string | undefined,
	extension_path: string,
	indent_accordion_child_icon: boolean,
	align_installed_state_in_description: boolean,
	concise_row_detail = false
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
				'Hide installed local node.js versions'.length,
				'Show installed local node.js versions'.length,
				'Hide other available versions'.length,
				'Show other available versions'.length,
				'Open settings'.length
			)
		: version_width;
	const status_icon_slot_chars = Math.max('$(vm-running)'.length, '$(cloud-download)'.length);
	const status_desc_zone_width = status_icon_slot_chars + 10;
	const current_entry = entries.find((entry) => entry.is_current && entry.is_installed);
	const current_version_for_pin =
		current_entry?.version ?? entries.find((entry) => entry.is_current)?.version ?? '';
	const show_project_switch =
		project_pin !== undefined &&
		project_pin.length > 0 &&
		normalize_version(current_version_for_pin) !== normalize_version(project_pin);
	const installed_entries = entries.filter((entry) => entry.is_installed && !entry.is_current);
	installed_entries.sort((a, b) => compare_versions_desc(a.version, b.version));
	let available_entries = entries.filter((entry) => !entry.is_installed);
	available_entries.sort((a, b) => compare_versions_desc(a.version, b.version));
	if (process.platform === 'darwin' && backend === 'n') {
		const kept_versions = new Set(
			keep_latest_per_major(available_entries.map((entry) => entry.version)).map(
				(version) => normalize_version(version) || version
			)
		);
		available_entries = available_entries.filter((entry) =>
			kept_versions.has(normalize_version(entry.version) || entry.version)
		);
	}

	const group_tag_for = (role: 'current' | 'installed' | 'available') =>
		role === 'current' ? 'In Use' : role === 'installed' ? 'Local' : 'Other available versions';

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
		const tail = middle ? `${middle} · ${group_tag}` : group_tag;
		if (tool) {
			return `${tool} | ${tail}`;
		}
		return tail;
	};

	const row_hover_text = (
		entry: VersionEntry,
		channel: string,
		role: 'current' | 'installed' | 'available'
	): string => {
		const lines: string[] = [`Node ${entry.version}`];
		if (channel) {
			lines.push(`Release: ${channel}`);
		}
		if (role === 'available') {
			lines.push('Source: Other available versions.');
		}
		return lines.join('\n');
	};

	const build_item = (entry: VersionEntry, role: 'current' | 'installed' | 'available') => {
		const detailsBase =
			role === 'current' ? 'In use now' : role === 'installed' ? '' : 'Other available version';
		const { badge } = resolve_version_release_semantics(entry.version, release_channels);
		const badge_for_display = role === 'available' ? '' : badge;
		const badge_for_tooltip = badge;
		const channel = badge_for_display ? picker_channel_kind_display(badge_for_display) : '';
		const tooltip_channel = badge_for_tooltip ? picker_channel_kind_display(badge_for_tooltip) : '';
		const details =
			role === 'installed'
				? channel
				: channel
					? `${detailsBase} · ${channel}`
					: detailsBase;
		const gt = group_tag_for(role);
		const full_row_detail = entry.is_installed
			? build_installed_picker_tooltip(entry, backend, role, tooltip_channel)
			: row_hover_text(entry, tooltip_channel, role);
		const use_concise = concise_row_detail && align_installed_state_in_description;
		const row_detail = use_concise ? undefined : full_row_detail;
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
				picker_version_state_label(entry.version, badge_for_display),
				picker_primary_label_width
			);
			const status_icon =
				role === 'available' ? '$(cloud-download)' : role === 'current' ? '$(vm-running)' : '';
			description = pad_icon_status_column_right(status_icon, status_desc_zone_width);
		} else if (role === 'current') {
			label = `${version_cell} \u{1F7E2} In use`;
			description = format_concise_row_description(details, gt, role);
		} else if (role === 'installed') {
			label = version_cell;
			description = format_concise_row_description(details, gt, role);
		} else {
			label = version_cell;
			description = format_concise_row_description(details, gt, role);
		}
		const row: NodePickerItem = {
			label,
			iconPath: quick_pick_version_row_icon_uri(extension_path, entry.version, indent_icon),
			entry
		};
		if (row_detail !== undefined) {
			row.detail = row_detail;
		}
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
			? 'Click to switch to project node version'
			: 'Switch to Node.js project version';
		const project_label_padded = align_installed_state_in_description
			? project_switch_label +
				'\u2007'.repeat(Math.max(0, picker_primary_label_width - project_switch_label.length))
			: project_switch_label;
		quick_pick_items.push({
			label: project_label_padded,
			description: `${entry.version} · .nodeswitcher`,
			detail:
				concise_row_detail && align_installed_state_in_description
					? `Workspace pin · ${entry.version}`
					: `Use Node ${entry.version} as required by this workspace (.nodeswitcher). Matches the version pinned for this workspace.`,
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
		'Show installed local node.js versions'.length,
		'Hide installed local node.js versions'.length,
		'Show other available versions'.length,
		'Hide other available versions'.length,
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
		quick_pick_items.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Local' });
		const toggle_installed_caption = include_installed
			? 'Collapse installed versions'
			: 'Expand installed versions';
		const toggle_installed_desc = pad_description_center_in_zone(toggle_installed_caption);
		quick_pick_items.push({
			label: footer_primary(
				include_installed ? 'Hide installed local node.js versions' : 'Show installed local node.js versions'
			),
			description: toggle_installed_desc,
			detail:
				concise_row_detail && align_installed_state_in_description
					? include_installed
						? 'Hide local installs.'
						: 'Show local installs.'
					: include_installed
						? 'Hides installed local Node.js versions listed below.'
						: 'Shows installed local Node.js versions.',
			iconPath: new vscode.ThemeIcon(include_installed ? 'chevron-up' : 'chevron-down'),
			action: 'toggle_installed'
		});
		if (include_installed) {
			quick_pick_items.push(section_break());
			quick_pick_items.push(...installed_entries.map((entry) => build_item(entry, 'installed')));
		}
	}

	quick_pick_items.push(section_break());
	const toggle_available_caption = include_available
		? 'Collapse other available versions'
		: 'Expand other available versions';
	const toggle_available_desc = pad_description_center_in_zone(toggle_available_caption);
	quick_pick_items.push({
		label: footer_primary(
			include_available ? 'Hide other available versions' : 'Show other available versions'
		),
		description: toggle_available_desc,
		detail:
			concise_row_detail && align_installed_state_in_description
				? include_available
					? 'Hide installable list.'
					: 'Show versions to install.'
				: include_available
					? 'Hides the list of other Node.js versions available to install (from your version manager).'
					: 'Loads and lists Node.js versions available to install (newest first), excluding already installed.',
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
		detail:
			concise_row_detail && align_installed_state_in_description
				? 'NodeSwitcher settings.'
				: 'Opens NodeSwitcher extension settings.',
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

function error_text(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function combined_exec_error_text(err: unknown): string {
	if (typeof err === 'object' && err !== null) {
		const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
		const bits = [e.message, e.stderr, e.stdout]
			.map((part) => (typeof part === 'string' ? part : ''))
			.filter((s) => s.length > 0);
		if (bits.length > 0) {
			return bits.join('\n');
		}
	}
	return error_text(err);
}

export function is_n_version_required_error(error: unknown): boolean {
	const text = combined_exec_error_text(error).toLowerCase();
	return (
		/version required/.test(text) ||
		/no active node version yet/.test(text) ||
		(/\bn bin\b/.test(text) && /version required/.test(text))
	);
}

function nvm_dir_for_shell(): string {
	return process.env.NVM_DIR || path.join(homedir(), '.nvm');
}

function unix_nvm_init_bash(): string {
	return [
		'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}";',
		'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh";',
		'elif [ -s "${XDG_CONFIG_HOME:-$HOME/.config}/nvm/nvm.sh" ]; then',
		'export NVM_DIR="${NVM_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/nvm}";',
		'. "$NVM_DIR/nvm.sh";',
		'elif [ -s "/usr/share/nvm/nvm.sh" ]; then . "/usr/share/nvm/nvm.sh";',
		'elif [ -s "/opt/homebrew/opt/nvm/nvm.sh" ]; then . "/opt/homebrew/opt/nvm/nvm.sh";',
		'elif [ -s "/usr/local/opt/nvm/nvm.sh" ]; then . "/usr/local/opt/nvm/nvm.sh";',
		'fi'
	].join(' ');
}

type RuntimeSnapshot = {
	collected_at: number;
	has_node: boolean;
	has_n_cmd: boolean;
	has_nvm: boolean;
	has_brew: boolean;
	n_versions_dir: boolean;
	brew_formula_n: boolean;
};

function empty_runtime_snapshot(): RuntimeSnapshot {
	return {
		collected_at: Date.now(),
		has_node: false,
		has_n_cmd: false,
		has_nvm: false,
		has_brew: false,
		n_versions_dir: false,
		brew_formula_n: false
	};
}

async function bash_probe_y(script: string, timeout_ms: number): Promise<boolean> {
	const full = `/bin/bash -lc ${JSON.stringify(script)}`;
	try {
		const { stdout } = await exec_async(full, { timeout: timeout_ms, env: process.env });
		return stdout.trim() === 'y';
	} catch {
		return false;
	}
}

async function collect_runtime_snapshot(): Promise<RuntimeSnapshot> {
	if (process.platform === 'win32') {
		return empty_runtime_snapshot();
	}
	const t = RUNTIME_PROBE_TIMEOUT_MS;
	const n_versions_script =
		'if [ -n "${N_PREFIX:-}" ] && [ -d "${N_PREFIX}/n/versions" ]; then echo y;' +
		' elif [ -d /usr/local/n/versions ]; then echo y;' +
		' elif [ -d /opt/homebrew/n/versions ]; then echo y;' +
		' else bp="$(brew --prefix n 2>/dev/null)"; if [ -n "$bp" ] && [ -d "$bp/n/versions" ]; then echo y; else echo n; fi; fi';
	const brew_formula_script =
		'command -v brew >/dev/null 2>&1 && brew list --formula n 2>/dev/null | grep -Fxq n && echo y || echo n';
	const [has_node, has_n_cmd, has_brew, has_nvm, n_versions_dir, brew_formula_n] = await Promise.all([
		bash_probe_y('command -v node >/dev/null 2>&1 && echo y || echo n', t),
		bash_probe_y('command -v n >/dev/null 2>&1 && echo y || echo n', t),
		bash_probe_y('command -v brew >/dev/null 2>&1 && echo y || echo n', t),
		bash_probe_y(`${unix_nvm_init_bash()}; command -v nvm >/dev/null 2>&1 && echo y || echo n`, t),
		bash_probe_y(n_versions_script, t),
		bash_probe_y(brew_formula_script, t)
	]);
	return {
		collected_at: Date.now(),
		has_node,
		has_n_cmd,
		has_nvm,
		has_brew,
		n_versions_dir,
		brew_formula_n
	};
}

function is_valid_runtime_snapshot(o: unknown): o is RuntimeSnapshot {
	if (!o || typeof o !== 'object') {
		return false;
	}
	const s = o as Record<string, unknown>;
	return (
		typeof s.collected_at === 'number' &&
		typeof s.has_node === 'boolean' &&
		typeof s.has_n_cmd === 'boolean' &&
		typeof s.has_nvm === 'boolean' &&
		typeof s.has_brew === 'boolean' &&
		typeof s.n_versions_dir === 'boolean' &&
		typeof s.brew_formula_n === 'boolean'
	);
}

export async function get_runtime_snapshot_cached(
	context: vscode.ExtensionContext,
	force: boolean
): Promise<RuntimeSnapshot> {
	if (process.platform === 'win32') {
		return empty_runtime_snapshot();
	}
	const at = context.workspaceState.get<number>(RUNTIME_SNAPSHOT_AT_KEY) ?? 0;
	const raw = context.workspaceState.get<string>(RUNTIME_SNAPSHOT_JSON_KEY);
	if (!force && Date.now() - at < RUNTIME_SNAPSHOT_TTL_MS && raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (is_valid_runtime_snapshot(parsed)) {
				return parsed;
			}
		} catch {
			/* use fresh snapshot */
		}
	}
	const snap = await collect_runtime_snapshot();
	await context.workspaceState.update(RUNTIME_SNAPSHOT_JSON_KEY, JSON.stringify(snap));
	await context.workspaceState.update(RUNTIME_SNAPSHOT_AT_KEY, Date.now());
	return snap;
}

function runtime_snapshot_tooltip_detail(snapshot: RuntimeSnapshot): string {
	const tools: string[] = [];
	if (snapshot.has_node) {
		tools.push('node');
	}
	if (snapshot.has_n_cmd) {
		tools.push('n');
	}
	if (snapshot.has_nvm) {
		tools.push('nvm');
	}
	if (snapshot.has_brew) {
		tools.push('brew');
	}
	const line = tools.length > 0 ? tools.join(', ') : 'none detected';
	const bits = [`Tools: ${line}`];
	if (snapshot.n_versions_dir) {
		bits.push('n versions dir');
	}
	if (snapshot.brew_formula_n) {
		bits.push('brew formula n');
	}
	return bits.join(' · ');
}

async function maybe_hint_n_ready_no_versions(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(N_READY_NO_VERSIONS_HINT_KEY) === true) {
		return;
	}
	await context.globalState.update(N_READY_NO_VERSIONS_HINT_KEY, true);
	void vscode.window.showInformationMessage(
		'NodeSwitcher: n is installed but no local Node versions are installed yet. Open the version picker to install one, or run `n lts` in a terminal.'
	);
}

function get_or_create_install_terminal(): vscode.Terminal {
	let t = vscode.window.terminals.find((x) => x.name === NODESWITCHER_INSTALL_TERMINAL_NAME);
	if (!t) {
		const wf = vscode.workspace.workspaceFolders?.[0];
		t = vscode.window.createTerminal({ name: NODESWITCHER_INSTALL_TERMINAL_NAME, cwd: wf?.uri.fsPath });
	}
	t.show(true);
	return t;
}

export function reveal_nodeswitcher_install_terminal(): void {
	get_or_create_install_terminal().show(true);
}

export function send_text_in_nodeswitcher_install_terminal(text: string, execute = true): void {
	get_or_create_install_terminal().sendText(text, execute);
}

async function send_text_in_install_terminal_and_poll_for_manager(
	context: vscode.ExtensionContext,
	command: string,
	progress_detail: string
): Promise<boolean> {
	const terminal = get_or_create_install_terminal();
	terminal.sendText(command, true);
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'NodeSwitcher',
			cancellable: true
		},
		async (progress, token) => {
			const start = Date.now();
			while (Date.now() - start < MANAGER_DETECT_MAX_MS && !token.isCancellationRequested) {
				const elapsed_s = Math.floor((Date.now() - start) / 1000);
				progress.report({
					message: `${progress_detail} — elapsed ${elapsed_s}s. Complete any prompts in the ${NODESWITCHER_INSTALL_TERMINAL_NAME} terminal; polling for n or nvm.`
				});
				if ((await probe_n(FAST_SHELL_TIMEOUT_MS)) || (await probe_nvm(FAST_SHELL_TIMEOUT_MS))) {
					await offer_retry_after_remediation(context, 'NodeSwitcher detected n or nvm.');
					return true;
				}
				await new Promise((r) => setTimeout(r, MANAGER_DETECT_POLL_MS));
			}
			if (token.isCancellationRequested) {
				vscode.window.showInformationMessage('NodeSwitcher install wait cancelled.');
				return false;
			}
			vscode.window.showInformationMessage(
				'NodeSwitcher still does not see n or nvm. When install finishes, reload the window or try again.'
			);
			return false;
		}
	);
}

function is_unix_permission_issue(error: unknown): boolean {
	if (process.platform === 'win32') {
		return false;
	}
	const text = error_text(error);
	const lower = text.toLowerCase();
	if (
		/\balready installed\b/i.test(text) ||
		/\bup[- ]to[- ]date\b/i.test(lower) ||
		/no such file or directory/i.test(text) ||
		/version required/i.test(text) ||
		/\bn bin\b/i.test(lower) ||
		/\/n\/versions/i.test(text)
	) {
		return false;
	}
	return /(\beacces\b|\beperm\b|permission denied|cannot create.*\bdir|mkdir:.*permission|mkdir:.*denied|failed to mkdir)/i.test(
		text
	);
}

async function maybe_prompt_unix_permission_guidance(context: vscode.ExtensionContext, error: unknown): Promise<void> {
	if (!is_unix_permission_issue(error)) {
		return;
	}
	const selection = await vscode.window.showWarningMessage(
		'NodeSwitcher install failed due to permissions.',
		'Open repair panel',
		'Dismiss'
	);
	if (selection === 'Open repair panel') {
		await vscode.commands.executeCommand('nodeswitcher.openRemediationPanel', error_text(error), 'permission');
	}
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
		const previous_text = status_item.text;
		const previous_tooltip = status_item.tooltip;
		const set_install_feedback = (phase: InstallPhase, version: string) => {
			const vv = node_version_display_v(version);
			const message = phase === 'downloading' ? `Installing Node ${vv}...` : `Switching to Node ${vv}...`;
			on_install_phase?.(phase, version);
			status_item.text = status_bar_text(`$(sync~spin) $(${STATUS_BAR_ICON}) ${message}`, 'loading');
			status_item.tooltip = message;
			apply_nodeswitcher_status_bar_style(status_item);
			apply_nodeswitcher_status_bar_visibility(status_item);
		};
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'NodeSwitcher', cancellable: false },
				async (progress) => {
					const report_phase = (phase: InstallPhase, version: string) => {
						const vv = node_version_display_v(version);
						const message = phase === 'downloading' ? `Installing Node ${vv}...` : `Switching to Node ${vv}...`;
						set_install_feedback(phase, version);
						progress.report({ message });
					};
					if (backend === 'nvm') {
						if (!entry.is_installed) {
							report_phase('downloading', entry.version);
							await run_nvm(`install ${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
							report_phase('installing', entry.version);
						} else {
							report_phase('installing', entry.version);
						}
						return;
					}
					if (!entry.is_installed) {
						report_phase('downloading', entry.version);
						await run_n(`${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
						report_phase('installing', entry.version);
						return;
					}
					report_phase('installing', entry.version);
					await run_n(`${entry.version}`, DEFAULT_SHELL_TIMEOUT_MS, cancel_signal);
				}
			);
		} finally {
			status_item.text = previous_text;
			status_item.tooltip = previous_tooltip;
			apply_nodeswitcher_status_bar_visibility(status_item);
			bind_status_bar_opens_picker(status_item);
		}
		const from_workspace_version = context.workspaceState.get<string>(VERSION_STATE_KEY);
		const { bin_dir } = await apply_node_environment(context, entry.version, backend, true);
		const applied_raw =
			(context.workspaceState.get<string>(VERSION_STATE_KEY) ?? sanitize_version(entry.version)) ||
			entry.version;
		const applied_n = normalize_version(applied_raw) || applied_raw;
		post_switch_active_integrated_terminal(
			vscode.window.activeTerminal,
			bin_dir,
			backend,
			from_workspace_version,
			applied_n
		);
		const backend_resolved = await resolve_backend_cached(context, true);
		await persist_project_selection(context, applied_n, backend_resolved);
		const probed = await get_current_version(backend_resolved, FAST_SHELL_TIMEOUT_MS).catch(() => '');
		const probed_n = probed ? normalize_version(probed) || probed : '';
		const display = probed_n && probed_n === applied_n ? probed_n : applied_n;
		await paint_main_status_bar(context, status_item, display, backend_resolved);
		const shown = visible_backend_label(backend_resolved);
		await clear_last_failed_switch(context);
		vscode.window.showInformationMessage(
			shown
				? `NodeSwitcher (${shown}): Node ${display} applied for this workspace. Integrated terminals pick up the new PATH when shell integration is enabled; if not, open a new terminal.`
				: `NodeSwitcher: Node ${display} applied for this workspace. Integrated terminals pick up the new PATH when shell integration is enabled; if not, open a new terminal.`
		);
	} catch (error) {
		if (error instanceof InstallCancelledError) {
			throw error;
		}
		await persist_last_failed_switch(context, backend, entry);
		let skip_error_panel_for_remediation = false;
		if (backend === 'n' && is_n_version_required_error(error)) {
			const choice = await vscode.window.showWarningMessage(
				'n has no active default Node version yet.',
				'Open first-time setup',
				'Dismiss'
			);
			if (choice === 'Open first-time setup') {
				await vscode.commands.executeCommand(
					'nodeswitcher.openRemediationPanel',
					error_text(error),
					'n_no_active'
				);
				skip_error_panel_for_remediation = true;
			}
		} else {
			await maybe_prompt_unix_permission_guidance(context, error);
		}
		if (!skip_error_panel_for_remediation) {
			report_nodeswitcher_failure(
				context,
				'NodeSwitcher failed to apply the selected Node version.',
				error_text(error)
			);
		}
		throw error;
	}
}

let refresh_status_bar_debounce_timer: ReturnType<typeof setTimeout> | undefined;

export async function refresh_status_bar(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	force = false
): Promise<void> {
	const run = async (): Promise<void> => {
		try {
			let runtime_snap: RuntimeSnapshot | undefined;
			if (force && process.platform !== 'win32') {
				set_initializer_loading_phase(status_item, 'Checking tools…', 'Refreshing runtime snapshot…');
				runtime_snap = await get_runtime_snapshot_cached(context, true);
				set_initializer_loading_phase(
					status_item,
					'Resolving version manager…',
					runtime_snapshot_tooltip_detail(runtime_snap)
				);
			}
			const backend = await resolve_backend_cached(context, force);
			if (force && process.platform !== 'win32' && runtime_snap) {
				set_initializer_loading_phase(
					status_item,
					'Reading active Node version…',
					runtime_snapshot_tooltip_detail(runtime_snap)
				);
			}
			const current = await get_current_version(backend, FAST_SHELL_TIMEOUT_MS);
			await paint_main_status_bar(context, status_item, current, backend);
		} catch (e) {
			await handle_status_bar_backend_failure(context, status_item, e);
		}
	};
	if (!force) {
		if (refresh_status_bar_debounce_timer !== undefined) {
			clearTimeout(refresh_status_bar_debounce_timer);
		}
		refresh_status_bar_debounce_timer = setTimeout(() => {
			refresh_status_bar_debounce_timer = undefined;
			void run();
		}, 200);
		return;
	}
	if (refresh_status_bar_debounce_timer !== undefined) {
		clearTimeout(refresh_status_bar_debounce_timer);
		refresh_status_bar_debounce_timer = undefined;
	}
	await run();
}

export function dispose_refresh_status_bar_debounce(): void {
	if (refresh_status_bar_debounce_timer !== undefined) {
		clearTimeout(refresh_status_bar_debounce_timer);
		refresh_status_bar_debounce_timer = undefined;
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

async function get_local_versions(
	backend: NodeBackend,
	options?: { omitCurrentProbe?: boolean }
): Promise<VersionEntry[]> {
	const { versions: installed, raw } = await get_installed_versions_with_raw(backend);
	const current = options?.omitCurrentProbe
		? ''
		: await get_current_version(backend).catch(() => '');
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
	} catch (e) {
		report_nodeswitcher_failure(
			context,
			'NodeSwitcher could not find a Node version manager (n or nvm) on PATH.',
			e
		);
		return null;
	}
	let raw: VersionEntry[];
	let live: string;
	try {
		[raw, live] = await Promise.all([
			get_local_versions(backend, { omitCurrentProbe: true }),
			resolve_live_version_for_ui(context, backend)
		]);
	} catch (e) {
		report_nodeswitcher_failure(
			context,
			'NodeSwitcher could not list installed Node versions from your version manager.',
			e
		);
		return null;
	}
	if (raw.length === 0) {
		try {
			raw = await get_versions_with_available(context, backend, []);
		} catch {
			/* fall through */
		}
	}
	if (raw.length === 0) {
		try {
			const probe = await get_installed_versions_with_raw(backend);
			if (probe.versions.length === 0 && probe.raw.trim().length > 0) {
				report_nodeswitcher_failure(
					context,
					'NodeSwitcher could not parse any installed versions from your version manager output.',
					`Output (truncated):\n${truncate_cli_output(probe.raw, 4000)}`
				);
			}
		} catch (probeErr) {
			report_nodeswitcher_failure(
				context,
				'NodeSwitcher could not read installed versions from your version manager.',
				probeErr
			);
		}
		return null;
	}
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
	const available_raw = await get_available_versions(backend);
	const available =
		process.platform === 'darwin' && installed.length === 0
			? keep_latest_per_major(available_raw)
			: available_raw;
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

function keep_latest_per_major(versions: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<number>();
	const sorted = sort_versions_semver_desc(versions);
	for (const version of sorted) {
		const normalized = normalize_version(version);
		if (!normalized) {
			continue;
		}
		const major = Number(normalized.split('.')[0]);
		if (!Number.isFinite(major) || seen.has(major)) {
			continue;
		}
		seen.add(major);
		out.push(version);
	}
	return out;
}

function version_is_active_row(version: string, current: string): boolean {
	if (!current.trim()) {
		return false;
	}
	return normalize_version(version) === normalize_version(current);
}

function map_versions_async(installed: string[], available: string[], current: string): Promise<VersionEntry[]> {
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
	const sorted = sort_versions_semver_desc(rows.map((row) => row.version));
	const rank = new Map(sorted.map((version, index) => [version, index]));
	rows.sort((left, right) => rank.get(left.version)! - rank.get(right.version)!);
	return Promise.resolve(rows);
}

function sanitize_n_ls_raw(raw: string): string {
	return raw
		.split(/\r?\n/)
		.filter((line) => {
			const t = line.trim();
			if (!t) {
				return false;
			}
			if (/^find:\s*/i.test(t)) {
				return false;
			}
			if (/No such file or directory/i.test(t)) {
				return false;
			}
			if (/not a directory/i.test(t)) {
				return false;
			}
			return true;
		})
		.join('\n');
}

function is_n_missing_versions_tree_output(raw: string): boolean {
	if (parse_versions(sanitize_n_ls_raw(raw)).length > 0) {
		return false;
	}
	const t = raw.trim();
	if (!t) {
		return true;
	}
	return /No such file or directory/i.test(t) || /find:\s/i.test(t) || /not a directory/i.test(t);
}

export async function get_installed_versions_with_raw(backend: NodeBackend): Promise<{ versions: string[]; raw: string }> {
	if (backend === 'n') {
		const raw_full = await run_n('ls', LIST_SHELL_TIMEOUT_MS);
		const raw_clean = sanitize_n_ls_raw(raw_full);
		const versions = parse_versions(raw_clean.length > 0 ? raw_clean : raw_full);
		if (versions.length === 0 && is_n_missing_versions_tree_output(raw_full)) {
			return { versions: [], raw: '' };
		}
		const raw_for_ui = raw_clean.trim() ? raw_clean : raw_full;
		return { versions, raw: raw_for_ui };
	}
	const raw = await run_nvm_with_fallback(['list', 'ls'], LIST_SHELL_TIMEOUT_MS);
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
		const n_prefix = n_install_prefix_for_paths();
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
	const max = get_max_other_available_versions();
	try {
		const from_index = await get_latest_stable_per_major_sorted(Math.max(max, 50));
		if (from_index.length > 0) {
			return sort_versions_semver_desc(from_index).slice(0, max);
		}
	} catch {
		// fall through to CLI fallback
	}
	return get_available_versions_cli_fallback(backend);
}

async function get_available_versions_cli_fallback(backend: NodeBackend): Promise<string[]> {
	const max = get_max_other_available_versions();
	const raw =
		backend === 'n'
			? await run_n('ls-remote', DEFAULT_SHELL_TIMEOUT_MS)
			: await run_nvm_with_fallback(['list available', 'ls-remote'], DEFAULT_SHELL_TIMEOUT_MS);
	const lines = raw.split(/\r?\n/).filter((line) => !/\brc\.|-rc\b|-beta|-nightly|\balpha\b/i.test(line));
	const versions = collect_stable_semver_versions_from_text(lines.join('\n'));
	const sorted = sort_versions_semver_desc(versions);
	return sorted.slice(0, max);
}

async function get_current_version(backend: NodeBackend, timeout_ms = DEFAULT_SHELL_TIMEOUT_MS): Promise<string> {
	if (backend === 'n') {
		try {
			const out = await run_n('bin', timeout_ms);
			const bin = parse_n_bin_output_line(out);
			if (bin) {
				const { stdout } = await exec_async(`${JSON.stringify(bin)} -v`, {
					timeout: timeout_ms,
					env: process.env
				});
				const v = stdout.trim();
				const parsed = parse_versions(v);
				if (parsed.length > 0) {
					return parsed[0];
				}
				const match = v.match(/v?\d+\.\d+\.\d+/);
				if (match) {
					return normalize_version(match[0]);
				}
			}
		} catch {
			// `n bin` fails with "version required" when n is installed but no version is active yet (e.g. fresh Homebrew install).
		}
		const path_ver = await try_get_node_version_from_path(timeout_ms);
		if (path_ver) {
			return path_ver;
		}
		throw new Error(
			'n is installed but has no active Node version yet. In a terminal run `n lts` or pick a version in NodeSwitcher, then reload if needed.'
		);
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

export async function probe_n_has_active_node(timeout_ms = FAST_SHELL_TIMEOUT_MS): Promise<boolean> {
	if (process.platform === 'win32') {
		return false;
	}
	try {
		await get_current_version('n', timeout_ms);
		return true;
	} catch {
		return false;
	}
}

export async function poll_until_n_has_active_node(token: vscode.CancellationToken): Promise<boolean> {
	if (process.platform === 'win32') {
		return false;
	}
	return poll_until_remediation(token, () => probe_n_has_active_node());
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

async function verify_cached_backend_still_works(backend: NodeBackend, timeout_ms: number): Promise<boolean> {
	if (backend === 'n') {
		return probe_n(timeout_ms);
	}
	if (backend === 'nvm') {
		return probe_nvm(timeout_ms);
	}
	return false;
}

async function try_get_node_version_from_path(timeout_ms: number): Promise<string | undefined> {
	if (process.platform === 'win32') {
		try {
			const { stdout } = await exec_async(`powershell -NoProfile -Command "node -v"`, {
				timeout: timeout_ms,
				env: process.env
			});
			const line = stdout.trim();
			const parsed = parse_versions(line);
			if (parsed.length > 0) {
				return parsed[0];
			}
			const match = line.match(/v?\d+\.\d+\.\d+/);
			return match ? normalize_version(match[0]) : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const script = 'command -v node >/dev/null 2>&1 && node -v';
		const { stdout } = await exec_async(`/bin/bash -lc ${JSON.stringify(script)}`, {
			timeout: timeout_ms,
			env: process.env
		});
		const line = stdout.trim();
		const parsed = parse_versions(line);
		if (parsed.length > 0) {
			return parsed[0];
		}
		const match = line.match(/v?\d+\.\d+\.\d+/);
		return match ? normalize_version(match[0]) : undefined;
	} catch {
		return undefined;
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

type UnixNodeManagerInstallPick = vscode.QuickPickItem & {
	value: 'npm' | 'brew' | 'nvm_install' | 'n_docs' | 'nvm_docs' | 'dismiss';
};

async function check_and_prompt_node_manager_unix(context: vscode.ExtensionContext): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}
	const dismiss_key = process.platform === 'darwin' ? N_MACOS_PROMPT_DISMISSED_KEY : NVM_SH_PROMPT_DISMISSED_KEY;
	if (context.globalState.get<boolean>(dismiss_key) === true) {
		return;
	}
	const snap = await get_runtime_snapshot_cached(context, false);
	if (await probe_nvm(FAST_SHELL_TIMEOUT_MS)) {
		return;
	}
	const has_n = snap.has_n_cmd || (await probe_n(FAST_SHELL_TIMEOUT_MS));
	if (has_n) {
		if (!snap.n_versions_dir) {
			await maybe_hint_n_ready_no_versions(context);
		}
		return;
	}
	const rows: UnixNodeManagerInstallPick[] = [
		{
			label: '$(terminal) Terminal: sudo npm global install n',
			description: N_PM_GLOBAL_INSTALL_SUDO,
			value: 'npm'
		}
	];
	const offer_brew =
		!snap.brew_formula_n &&
		((process.platform === 'darwin' && !snap.has_n_cmd) || (snap.has_brew && !snap.has_n_cmd));
	if (offer_brew) {
		rows.push({
			label: '$(terminal) Terminal: Homebrew install n',
			description: N_BREW_INSTALL,
			value: 'brew'
		});
	}
	rows.push(
		{
			label: '$(terminal) Terminal: install nvm-sh (curl | bash)',
			description: NVM_SH_DOC_URL,
			value: 'nvm_install'
		},
		{
			label: '$(link-external) Open n (tj/n) on GitHub',
			description: N_MACOS_DOC_URL,
			value: 'n_docs'
		},
		{
			label: '$(link-external) Open nvm-sh docs',
			description: NVM_SH_DOC_URL,
			value: 'nvm_docs'
		},
		{ label: "Don't ask again", description: 'Hide this until you reset global state', value: 'dismiss' }
	);
	const os_label = process.platform === 'darwin' ? 'macOS' : process.platform;
	const pick = await vscode.window.showQuickPick<UnixNodeManagerInstallPick>(rows, {
		title: `NodeSwitcher: install Node manager (${os_label})`,
		placeHolder: 'Opens the NodeSwitcher integrated terminal and waits until n or nvm is detected.'
	});
	if (!pick) {
		return;
	}
	if (pick.value === 'dismiss') {
		await context.globalState.update(dismiss_key, true);
		return;
	}
	if (pick.value === 'npm') {
		await send_text_in_install_terminal_and_poll_for_manager(
			context,
			N_PM_GLOBAL_INSTALL_SUDO,
			'npm global install n'
		);
		return;
	}
	if (pick.value === 'brew') {
		await send_text_in_install_terminal_and_poll_for_manager(
			context,
			N_BREW_INSTALL,
			'Homebrew install n'
		);
		return;
	}
	if (pick.value === 'nvm_install') {
		await send_text_in_install_terminal_and_poll_for_manager(
			context,
			`curl -fsSL '${NVM_SH_INSTALL_SCRIPT_URL}' | bash`,
			'nvm-sh install'
		);
		return;
	}
	if (pick.value === 'nvm_docs') {
		await vscode.env.openExternal(vscode.Uri.parse(NVM_SH_DOC_URL));
		return;
	}
	if (pick.value === 'n_docs') {
		await vscode.env.openExternal(vscode.Uri.parse(N_MACOS_DOC_URL));
	}
}

export async function check_and_prompt_required_runtime(context: vscode.ExtensionContext): Promise<void> {
	if (process.platform === 'win32') {
		await check_and_prompt_nvm_windows(context);
		return;
	}
	await check_and_prompt_node_manager_unix(context);
}

async function offer_backend_install_recovery(context: vscode.ExtensionContext): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		'Open the NodeSwitcher install helper? It runs commands in an integrated terminal and waits until n or nvm is detected.',
		'Show install options',
		'Dismiss'
	);
	if (choice !== 'Show install options') {
		return;
	}
	await check_and_prompt_node_manager_unix(context);
}

async function offer_backend_install_recovery_throttled(context: vscode.ExtensionContext): Promise<void> {
	const now = Date.now();
	const last = context.workspaceState.get<number>(BACKEND_RECONCILE_OFFER_AT_KEY) ?? 0;
	if (now - last < BACKEND_RECONCILE_OFFER_COOLDOWN_MS) {
		return;
	}
	await context.workspaceState.update(BACKEND_RECONCILE_OFFER_AT_KEY, now);
	await offer_backend_install_recovery(context);
}

async function handle_status_bar_backend_failure(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	error: unknown
): Promise<void> {
	await context.workspaceState.update(BACKEND_PROBE_VALUE_KEY, undefined);
	await context.workspaceState.update(BACKEND_PROBE_AT_KEY, undefined);
	await context.workspaceState.update(BACKEND_STATE_KEY, undefined);
	report_nodeswitcher_failure(
		context,
		'NodeSwitcher could not read the active Node version for the status bar.',
		error
	);
	const path_version = await try_get_node_version_from_path(5_000);
	const detail = error instanceof Error ? error.message : String(error);
	if (path_version) {
		const vn = normalize_version(path_version) || path_version;
		await context.workspaceState.update(VERSION_STATE_KEY, vn);
		status_item.text = status_bar_text(
			`$(warning) Node ${vn} on PATH — install n or nvm to switch`,
			'warning'
		);
		status_item.tooltip = `Node ${vn} works on PATH, but NodeSwitcher needs n or nvm (see error below). Click for the version picker; use “Show install options” when offered.\n\n${detail}`;
	} else {
		status_item.text = status_bar_text(`$(error) NodeSwitcher — could not read Node`, 'warning');
		status_item.tooltip = `Click to open the version picker. If this persists, install n or nvm.\n\n${detail}`;
	}
	apply_nodeswitcher_status_bar_style(status_item, 'probe_error');
	apply_nodeswitcher_status_bar_visibility(status_item);
	bind_status_bar_opens_picker(status_item);
	if (process.platform !== 'win32') {
		void offer_backend_install_recovery_throttled(context);
	}
}

async function resolve_backend_cached(context: vscode.ExtensionContext, force: boolean): Promise<NodeBackend> {
	const cached_backend = context.workspaceState.get<NodeBackend>(BACKEND_PROBE_VALUE_KEY);
	const cached_at = context.workspaceState.get<number>(BACKEND_PROBE_AT_KEY) ?? 0;
	if (!force && cached_backend && Date.now() - cached_at < PROBE_TTL_MS && backend_matches_platform(cached_backend)) {
		const coerced = normalize_backend_for_platform(cached_backend);
		const cache_age = Date.now() - cached_at;
		const needs_health_check = cache_age >= PROBE_CACHE_VERIFY_AFTER_MS;
		if (!needs_health_check || (await verify_cached_backend_still_works(coerced, FAST_SHELL_TIMEOUT_MS))) {
			return coerced;
		}
		await context.workspaceState.update(BACKEND_PROBE_VALUE_KEY, undefined);
		await context.workspaceState.update(BACKEND_PROBE_AT_KEY, 0);
	}
	const run_probe = async (timeout_ms: number) => {
		const backend = await resolve_backend(null, timeout_ms);
		const coerced = normalize_backend_for_platform(backend);
		await context.workspaceState.update(BACKEND_PROBE_VALUE_KEY, coerced);
		await context.workspaceState.update(BACKEND_PROBE_AT_KEY, Date.now());
		return coerced;
	};
	try {
		return await run_probe(FAST_SHELL_TIMEOUT_MS);
	} catch (first) {
		try {
			return await run_probe(DEFAULT_SHELL_TIMEOUT_MS);
		} catch {
			await context.workspaceState.update(BACKEND_PROBE_VALUE_KEY, undefined);
			await context.workspaceState.update(BACKEND_PROBE_AT_KEY, 0);
			throw first;
		}
	}
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
					`$(warning) Node ${live}${label_suffix} differs from project (${declared_spec})`,
					'warning'
				);
			} else if (declared_mismatch) {
				status_item.text = status_bar_text(
					`$(warning) Node ${live}${label_suffix} differs from project (${declared_spec})`,
					'warning'
				);
			} else {
				status_item.text = status_bar_text(
					`$(warning) Node ${live}${label_suffix} differs from pinned project version (${pin})`,
					'warning'
				);
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
			void maybe_show_project_mismatch_notice(
				context,
				status_item,
				backend,
				live,
				declared_mismatch,
				declared_spec,
				pin_mismatch,
				pin
			);
		} else if (
			looks_like_js &&
			!declared_spec &&
			ws &&
			!(await project_nodeswitcher_file_exists(ws))
		) {
			const label_suffix = tag ? ` (${tag})` : '';
			status_item.text = status_bar_text(`$(warning) Specify Node for project${label_suffix}`, 'warning');
			status_item.tooltip = `No Node declaration found (order: .nodeswitcher → package.json engines → project .npmrc → .nvmrc / .node-version → user ~/.npmrc). Active: ${live}.`;
			apply_nodeswitcher_status_bar_style(status_item, 'project_no_node_spec');
		} else {
			const lead = status_bar_leading_icon(pin, live);
			status_item.text = status_bar_text(format_status_bar_text(live, tag, pin, lead), 'default');
			apply_status_tooltip(context, status_item, tag, pin ?? undefined, live);
			const has_project_spec = pin !== undefined || declared_spec !== undefined;
			apply_nodeswitcher_status_bar_style(status_item, has_project_spec ? 'project_match' : 'default');
			await context.workspaceState.update(MISMATCH_NOTICE_FP_KEY, undefined);
		}
	}
	apply_nodeswitcher_status_bar_visibility(status_item);
	await context.workspaceState.update(VERSION_STATE_KEY, live);
	await context.workspaceState.update(BACKEND_STATE_KEY, backend);
	bind_status_bar_opens_picker(status_item);
	after_status_paint?.();
}

async function maybe_show_project_mismatch_notice(
	context: vscode.ExtensionContext,
	status_item: vscode.StatusBarItem,
	backend: NodeBackend,
	live: string,
	declared_mismatch: boolean,
	declared_spec: string | undefined,
	pin_mismatch: boolean,
	pin: string | undefined
): Promise<void> {
	const fp = `${live}::${declared_spec ?? ''}::${pin ?? ''}::${declared_mismatch ? 1 : 0}::${pin_mismatch ? 1 : 0}`;
	const seen = context.workspaceState.get<string>(MISMATCH_NOTICE_FP_KEY);
	if (seen === fp) {
		return;
	}
	await context.workspaceState.update(MISMATCH_NOTICE_FP_KEY, fp);
	const buttons = pin_mismatch && pin ? ['Switch to project version', 'Open picker', 'Dismiss'] : ['Open picker', 'Dismiss'];
	const message =
		pin_mismatch && pin
			? `Project expects Node ${pin}. Current is ${live}.`
			: declared_mismatch && declared_spec
				? `Project node declaration is ${declared_spec}. Current is ${live}.`
				: `Project node version does not match current Node ${live}.`;
	const choice = await vscode.window.showInformationMessage(message, ...buttons);
	if (choice === 'Switch to project version' && pin) {
		try {
			const from_v = context.workspaceState.get<string>(VERSION_STATE_KEY);
			const { bin_dir } = await apply_node_environment(context, pin, backend, false);
			const pin_n = normalize_version(pin) || pin;
			post_switch_active_integrated_terminal(
				vscode.window.activeTerminal,
				bin_dir,
				backend,
				from_v,
				pin_n
			);
			await persist_project_selection(context, pin, backend);
			await paint_main_status_bar(context, status_item, pin, backend);
		} catch (error) {
			report_nodeswitcher_failure(context, `NodeSwitcher could not switch to Node ${pin}.`, error);
		}
		return;
	}
	if (choice === 'Open picker') {
		await open_version_picker(context, status_item);
	}
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
			const from_v = context.workspaceState.get<string>(VERSION_STATE_KEY);
			const { bin_dir } = await apply_node_environment(context, desired, backend, false);
			const to_n = normalize_version(desired) || desired;
			post_switch_active_integrated_terminal(
				vscode.window.activeTerminal,
				bin_dir,
				backend,
				from_v,
				to_n
			);
		} catch (e) {
			report_nodeswitcher_failure(context, `NodeSwitcher could not switch to Node ${desired}.`, e);
			return 'dismissed';
		}
		return 'resolved';
	}
	if (choice === 'Keep current') {
		await context.workspaceState.update(MISMATCH_KEEP_CURRENT_KEY, true);
		try {
			const from_v = context.workspaceState.get<string>(VERSION_STATE_KEY);
			const { bin_dir } = await apply_node_environment(context, current_n, backend, true);
			const to_n = normalize_version(current_n) || current_n;
			post_switch_active_integrated_terminal(
				vscode.window.activeTerminal,
				bin_dir,
				backend,
				from_v,
				to_n
			);
			await persist_project_selection(context, current_n, backend);
		} catch (e) {
			report_nodeswitcher_failure(context, 'NodeSwitcher could not update the environment.', e);
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
		const text = 'NodeSwitcher could not read the active Node version.';
		report_nodeswitcher_failure(context, text, text);
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
	if (process.platform === 'win32') {
		const nvm_home = process.env.NVM_HOME;
		const nvm_exe = nvm_home ? path.join(nvm_home, 'nvm.exe') : 'nvm';
		const cmd = `"${nvm_exe}" ${args}`;
		const { stdout, stderr } = signal
			? await exec_async_cancellable(cmd, { timeout: timeout_ms, signal })
			: await exec_async(cmd, { timeout: timeout_ms });
		return `${stdout}\n${stderr}`;
	}
	const command = `nvm ${args}`;
	const script = `${unix_nvm_init_bash()}; ${command}`;
	const full = `/bin/bash -lc ${JSON.stringify(script)}`;
	const { stdout, stderr } = signal
		? await exec_async_cancellable(full, { timeout: timeout_ms, env: process.env, signal })
		: await exec_async(full, { timeout: timeout_ms, env: process.env });
	return `${stdout}\n${stderr}`;
}

async function run_n(args: string, timeout_ms = DEFAULT_SHELL_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
	if (process.platform === 'win32') {
		throw new Error('n is not supported on Windows');
	}
	const shell = process.env.SHELL ?? '/bin/bash';
	const cmd = `n ${args}`.trim();
	const full = `${shell} -lc ${JSON.stringify(cmd)}`;
	const env = n_process_env();
	const { stdout, stderr } = signal
		? await exec_async_cancellable(full, { timeout: timeout_ms, env, signal })
		: await exec_async(full, { timeout: timeout_ms, env });
	return `${stdout}\n${stderr}`;
}
