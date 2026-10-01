/**
 * restart-button — the whole plugin, and it is host-side only.
 *
 * Registers one human command:
 *
 *   /restart    end the desktop shell and bring DSH back
 *
 * and, because a command that fails silently is a command nobody can debug, a
 * small read-only diagnostic surface on the composition's Web server:
 *
 *   GET  /api/dsh-restart/status   can this host restart itself, and is work in flight?
 *   POST /api/dsh-restart/now      the same restart, for a script
 *
 * It never restarts anything itself. The request writes a detached helper
 * script, starts it, and answers; the helper does the killing and the
 * relaunching, because this process is one of the processes that must die for
 * the restart to happen. `restart-plan.js` holds the decisions and explains
 * the mechanism; this file is only the wiring.
 *
 * `commands` and `webServer` are reached through nested `inject`s rather than
 * declared in the module's own `inject`: Cordis has no optional form, and a
 * composition without a Web carrier or a command layer must still mount this
 * plugin rather than leave the whole entry pending forever.
 *
 * @module dsh-restart-button
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
	activeWork,
	buildJob,
	detectDesktopHost,
	helperPaths,
	normalizeConfig,
	NOW_PATH,
	restartHelperSource,
	reasonText,
	screenRestartRequest,
	STATUS_PATH
} from './restart-plan.js';

export const name = 'restart-button';

/** Nothing here is required: every dependency is reached optionally at runtime. */
export const inject = [];

/**
 * The window probe/raise script that ships with this package.
 *
 * Built from this module's own URL so it resolves inside the installed package
 * however the profile linked it (a junction, a copy, or an npm tarball).
 */
export function raiseScriptPath() {
	try {
		return fileURLToPath(new URL('./raise-window.ps1', import.meta.url));
	} catch {
		return '';
	}
}

/** Plain-object JSON schema helper, kept small on purpose. */
const objectSchema = (properties, required = []) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false
});

/**
 * The config shape, exported for readers and tests.
 *
 * Deliberately NOT named `Config`: this composition's loader reserves that
 * export for a schemastery schema, and handing it a plain JSON-schema object
 * would be a mount-time surprise. The accepted keys are validated by
 * `normalizeConfig` instead, which is what every branch below actually reads.
 */
export const configSchema = objectSchema({
	enabled: { type: 'boolean', description: 'Keep the command and the routes but refuse with a reason when false.' },
	raiseWindow: { type: 'boolean', description: 'Raise the replacement window once it is up; false leaves the window state alone.' },
	restartDelayMs: { type: 'number', description: 'Pause before the shell is terminated, so the command result reaches the log.' },
	shellExitWaitMs: { type: 'number', description: 'How long to wait for the shell process to disappear.' },
	hostExitWaitMs: { type: 'number', description: 'How long to wait for this host to shut down.' },
	portWaitMs: { type: 'number', description: 'How long to wait for the Web port to be released.' },
	settleMs: { type: 'number', description: 'Pause after the port is free, before relaunching.' },
	verifyMs: { type: 'number', description: 'How long the helper watches for the replacement to come up.' },
	steadyMs: { type: 'number', description: 'How long the replacement must answer to count as up.' },
	windowWaitMs: { type: 'number', description: 'How long to let the replacement produce a window before judging it.' },
	logDir: { type: 'string', description: 'Directory for the helper script and its log; defaults to the OS temp dir.' }
});

/**
 * The human command this plugin exists for.
 *
 * A command rather than a control in the interface: it needs no client half at
 * all, so there is nothing to render, nothing to keep in sync with the shell's
 * seats, and nothing that can be invisible in a layout its author did not
 * picture. `/restart` is typed deliberately, which is its own confirmation.
 */
export const COMMAND = {
	name: 'restart',
	description: '重启 DSH：结束桌面端并自动重新打开，窗口会自己回来 / Restart DSH: end the desktop shell and bring it back',
	usage: '用法：/restart（不接受参数）/ Usage: /restart (no arguments)'
};

/** Both languages of a refusal, because the reader is the user, not a log. */
function refusalText(reason) {
	const zh = reasonText(reason, 'zh');
	const en = reasonText(reason, 'en');
	if (zh === '') return en;
	if (en === '' || en === zh) return zh;
	return `${zh} / ${en}`;
}

/** `apply`'s entry point, kept separate so a test can mount it on a fake context. */
export function install(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const state = { restarting: false, last: null, commandRegistered: false, port: null };

	const log = (...args) => {
		try {
			ctx.logger?.info?.(...args);
		} catch {
			/* logging is never worth a failed request */
		}
	};
	const warn = (...args) => {
		try {
			ctx.logger?.warn?.(...args);
		} catch {
			/* as above */
		}
	};

	/** The desktop facts, re-detected per request: cheap, and never stale. */
	const detect = () =>
		detectDesktopHost({
			env: process.env,
			argv: process.argv,
			execPath: process.execPath,
			ppid: process.ppid,
			pid: process.pid,
			connected: process.connected,
			send: process.send
		});

	/** What the command and the diagnostic route both read. */
	const statusOf = (port) => {
		const detection = detect();
		const supported = config.enabled && detection.desktop;
		const reason = !config.enabled ? 'disabled' : detection.reason;
		const busy = activeWork(ctx.get?.('agents'), ctx.get?.('jobs'));
		return {
			ok: true,
			version: 1,
			supported,
			reason,
			reasonText: { zh: reasonText(reason, 'zh'), en: reasonText(reason, 'en') },
			shell: detection.desktop ? { pid: detection.appPid, exe: detection.appExe } : null,
			host: { pid: process.pid, port: Number.isInteger(port) ? port : null },
			busy,
			restarting: state.restarting,
			// The one fact a soft `inject` cannot report by failing: whether this
			// composition actually has the command. A composition whose command
			// layer never arrives leaves no error anywhere else.
			command: { name: COMMAND.name, registered: state.commandRegistered === true },
			last: state.last,
			options: { raiseWindow: config.raiseWindow, restartDelayMs: config.restartDelayMs }
		};
	};

	const send = (res, status, value) => {
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store'
		});
		res.end(JSON.stringify(value));
	};

	/**
	 * Write the helper, start it detached, and report where it logs.
	 *
	 * The helper is started from `process.execPath` in Node mode 鈥?the same way
	 * the shell starts its own pnpm and CLI 鈥?so it needs no toolchain beyond
	 * the running application, and it keeps that application's runtime alive
	 * while the replacement starts.
	 */
	const arm = async (port) => {
		const detection = detect();
		if (!config.enabled) return { status: 409, body: { ok: false, error: 'disabled' } };
		if (!detection.desktop) {
			return {
				status: 409,
				body: { ok: false, error: detection.reason, detail: reasonText(detection.reason, 'zh') }
			};
		}
		if (state.restarting) return { status: 409, body: { ok: false, error: 'already-restarting' } };

		const paths = helperPaths(config);
		await mkdir(paths.directory, { recursive: true });
		const raiseScript = raiseScriptPath();
		if (config.raiseWindow && (raiseScript === '' || !existsSync(raiseScript))) {
			// Degrading here is survivable but must not be silent: without the probe
			// the restart still happens, and the window may need the tray again.
			warn(`restart-button: the window probe is missing at ${raiseScript || '(unresolved)'}; the replacement will not be raised`);
		}
		// Resolved from THIS module, not from the helper's working directory: the
		// helper runs out of the temp directory and would never find the script.
		const probe = raiseScript !== '' && existsSync(raiseScript) ? raiseScript : '';
		const job = buildJob(config, detection, {
			hostPid: process.pid,
			port: Number.isInteger(port) ? port : null,
			logPath: paths.log,
			diagnosticFile: paths.diagnostic,
			raiseScript: probe
		});
		await writeFile(paths.script, restartHelperSource(job), 'utf8');

		const helper = spawn(process.execPath, [paths.script], {
			detached: true,
			stdio: 'ignore',
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			windowsHide: true
		});
		// The spawn failure is asynchronous: without this listener the only trace
		// of a helper that never ran would be a command whose restart never came.
		helper.on('error', (error) => warn(`restart-button: the helper could not start: ${error?.message ?? error}`));
		helper.unref();

		state.restarting = true;
		state.last = {
			at: new Date().toISOString(),
			shellPid: detection.appPid,
			hostPid: process.pid,
			helperPid: helper.pid ?? null,
			log: paths.log,
			script: paths.script
		};
		log(`restart-button: restart armed (shell ${detection.appPid}, helper ${String(helper.pid)}, log ${paths.log})`);
		return { status: 200, body: { ok: true, restarting: true, ...state.last } };
	};

	/**
	 * One `/restart`, as the human command layer sees it.
	 *
	 * The invocation is deliberate, so there is no confirmation step here — the
	 * typing *is* the confirmation. What it does instead is say what is about to
	 * be interrupted, and where the helper's log is if the app does not come back.
	 */
	const runCommand = async (invocation) => {
		if (String(invocation?.rawInput ?? '').trim() !== '') {
			return { kind: 'error', text: COMMAND.usage };
		}
		const busy = activeWork(ctx.get?.('agents'), ctx.get?.('jobs'));
		let answer;
		try {
			answer = await arm(state.port ?? null);
		} catch (error) {
			return { kind: 'error', text: `重启没有开始：${String(error?.message ?? error)}` };
		}
		if (answer.status !== 200) {
			const reason = answer.body?.error ?? 'unavailable';
			const detail = answer.body?.detail ? `（${answer.body.detail}）` : '';
			return { kind: 'error', text: `重启没有开始：${refusalText(reason)}${detail}` };
		}
		const interrupted = busy.active
			? `（有 ${busy.runningAgents} 个会话在运行、${busy.runningJobs} 个后台任务，会被中断 / ${busy.runningAgents} running session(s) and ${busy.runningJobs} job(s) will be interrupted）`
			: '';
		return {
			kind: 'success',
			text:
				`正在重启 DSH：结束桌面端并自动重新打开，窗口会自己回来${interrupted}。` +
				`日志：${answer.body.log} / Restarting DSH: the desktop shell is ending and will come back with its window. Log: ${answer.body.log}`
		};
	};

	/**
	 * Register the command, optionally.
	 *
	 * `commands` is reached through a nested inject, exactly like `webServer`:
	 * a composition without a human-command layer (an SDK or headless run) must
	 * still mount this plugin rather than leave the entry pending forever.
	 */
	const installCommand = (scoped) => {
		const commands = scoped.commands ?? scoped.get?.('commands');
		if (commands === undefined || typeof commands.register !== 'function') {
			warn('restart-button: this composition has no command registry; /restart is unavailable');
			return;
		}
		const register = () =>
			commands.register({
				name: COMMAND.name,
				description: COMMAND.description,
				handler: runCommand
			});
		if (typeof scoped.effect === 'function') scoped.effect(register, 'restart-button command');
		else register();
		state.commandRegistered = true;
		log(`restart-button: /${COMMAND.name} registered (enabled=${String(config.enabled)})`);
	};

	const attach = (scoped, webServer) => {
		const port = Number(webServer?.port);
		state.port = Number.isInteger(port) ? port : null;
		const route = (path, method, handle, label) => {
			const register = () =>
				webServer.register({
					kind: 'exact',
					path,
					handler: async (req, res) => {
						const refused = screenRestartRequest(req, { method });
						if (refused !== undefined) {
							send(res, refused.status, refused.body);
							return;
						}
						try {
							const answer = await handle();
							send(res, answer.status, answer.body);
						} catch (error) {
							// A failed restart attempt is this plugin's problem, never
							// the harness's: answer with the reason.
							warn(`restart-button: ${path} failed: ${error?.message ?? error}`);
							send(res, 500, { ok: false, error: 'internal', detail: String(error?.message ?? error) });
						}
					}
				});
			if (typeof scoped.effect === 'function') scoped.effect(register, label);
			else register();
		};

		route(STATUS_PATH, 'GET', async () => ({ status: 200, body: statusOf(port) }), 'restart-button status route');
		route(NOW_PATH, 'POST', () => arm(port), 'restart-button restart route');

		log(`restart-button: serving ${STATUS_PATH} and ${NOW_PATH} (enabled=${String(config.enabled)})`);
	};

	if (typeof ctx.inject === 'function') {
		ctx.inject(['commands'], installCommand);
		ctx.inject(['webServer'], (scoped) => {
			const webServer = scoped.webServer ?? scoped.get?.('webServer');
			if (webServer === undefined || typeof webServer.register !== 'function') {
				warn('restart-button: the web server does not accept routes; the diagnostic surface is unavailable');
				return;
			}
			attach(scoped, webServer);
		});
	} else {
		installCommand(ctx);
		const webServer = ctx.get?.('webServer');
		if (webServer !== undefined && typeof webServer.register === 'function') attach(ctx, webServer);
	}

	return { statusOf, arm, runCommand, config, state };
}

/** Cordis entry point. */
export function apply(ctx, config) {
	const api = install(ctx, config);
	if (typeof ctx.reflect?.provide === 'function') {
		// Discoverable rather than hidden: another plugin (or a tool) can ask what
		// the command would do without re-deriving the detection.
		try {
			ctx.reflect.provide('restartButton', {
				version: 1,
				command: COMMAND.name,
				status: () => api.statusOf(api.state.port ?? null),
				restart: () => api.arm(api.state.port ?? null)
			});
		} catch {
			/* the service is a convenience; the command does not depend on it */
		}
	}
}
