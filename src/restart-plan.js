/**
 * restart-plan — every decision behind the button, with no Cordis, no HTTP and
 * no process side effects, so each of them can be exercised without a desktop
 * app to restart.
 *
 * ## Why the restart works the way it does
 *
 * DSH Desktop is an Electron shell whose main process spawns the Web host as a
 * child in Electron's Node mode (`dsh-desktop-host/lib/index.js`) and talks to
 * it over the child's IPC channel. The shell is the process that owns the
 * application's lifetime, and nothing the host can say makes it relaunch:
 * `isDesktopHostEvent()` accepts exactly `ready`, `platform-state`, `fatal`,
 * `shutdown-complete`, `update-tasks` and `quit-inspection`, and the packaged
 * Windows build ships no restart menu item at all (the application menu holds
 * only devtools; the tray offers Open and Quit). So a restart button cannot
 * ask the shell for anything — it has to *be* the shell's restart:
 *
 *   1. terminate the shell process (we are its child, so its death also hands
 *      us the `disconnect` that makes this host shut down cleanly),
 *   2. wait for the host and the Web port to actually be released,
 *   3. start the application executable again, detached.
 *
 * Steps 1-3 run in a detached helper, never in this process: the process that
 * schedules the restart is one of the processes that dies in step 1, so it
 * cannot be the one watching for step 3. The helper is spawned from
 * `process.execPath` in Node mode, exactly the way the shell itself invokes
 * pnpm and its own CLI, so it needs no toolchain beyond what is already
 * running.
 *
 * Killing the shell is hard on purpose. A graceful close is not available to
 * us, and on Windows it is not even a quit: the shell's main window close
 * hides to the tray (`DesktopBackgroundNotice`), and `before-quit` asks a
 * question through a native dialog nobody can click. Erring the other way —
 * exiting this host first and hoping the shell notices — is worse than hard:
 * the shell watches its child and answers an exit it did not request with the
 * fatal-recovery dialog, so the user gets an error box instead of a restart.
 *
 * @module dsh-restart-button/plan
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** The desktop host entry, which is what tells this process who its parent is. */
export const DESKTOP_HOST_ENTRY = /dsh-desktop-host[\\/]lib[\\/]index\.js$/u;

/** Where the client asks whether a restart is possible, and asks for one. */
export const STATUS_PATH = '/api/dsh-restart/status';
export const NOW_PATH = '/api/dsh-restart/now';

/**
 * The header the client must send on the restart request.
 *
 * It is not a secret and not authentication: it is what makes the request
 * impossible for another page to send. A cross-origin `fetch` carrying a
 * custom header is preflighted, and this route answers no preflight, so a
 * browser refuses to send it; an ordinary cross-origin form post never
 * carries it either. The loopback and Host checks below are the real fence —
 * this only keeps the two remaining browser shapes out of reach.
 */
export const REQUEST_HEADER = 'x-dsh-restart';

export const DEFAULTS = {
	/** `false` keeps the command and the routes alive but refuses with a reason. */
	enabled: true,
	/**
	 * Raise the replacement's window after it is up. `false` leaves the window
	 * state alone, which is only useful for diagnosing a raise that misbehaves.
	 */
	raiseWindow: true,
	/**
	 * The pause between the command returning and the shell being terminated.
	 * Its job is to let the command's own result row reach the session log before
	 * the process that would write it goes away — 500ms was enough for an HTTP
	 * response, which is all the button needed, and a log flush wants a little more.
	 */
	restartDelayMs: 900,
	/** How long to wait for the shell process to disappear after the kill. */
	shellExitWaitMs: 15_000,
	/** How long to wait for this host to exit after the shell is gone. */
	hostExitWaitMs: 15_000,
	/** How long to wait for the Web port to stop answering. */
	portWaitMs: 30_000,
	/** A released socket can still be in TIME_WAIT; pause before relaunching. */
	settleMs: 400,
	/** How long the helper watches for the replacement to bind the port. */
	verifyMs: 60_000,
	/** How long the replacement must answer continuously to count as up. */
	steadyMs: 8_000,
	/**
	 * How long to let the replacement produce a window before judging it.
	 *
	 * A window appears when the application decides it is ready, which is not the
	 * moment the port starts answering — and a replacement that is judged too
	 * early is "a replacement with no window", which triggers the second launch
	 * for nothing and writes a misleading verdict into the log. Measured on the
	 * real app: the window is up well inside a second of the port, so this budget
	 * is only ever spent by a launch that is genuinely not going to show one.
	 */
	windowWaitMs: 12_000,
	/** Directory for helper scripts and their logs; defaults to the OS temp dir. */
	logDir: ''
};

/** A positive number, or the fallback when the configured value is unusable. */
function positive(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** Fill the defaults into whatever the Loader entry carried. */
export function normalizeConfig(raw) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	return {
		enabled: input.enabled === undefined ? DEFAULTS.enabled : input.enabled !== false,
		raiseWindow: input.raiseWindow !== false,
		restartDelayMs: positive(input.restartDelayMs, DEFAULTS.restartDelayMs),
		shellExitWaitMs: positive(input.shellExitWaitMs, DEFAULTS.shellExitWaitMs),
		hostExitWaitMs: positive(input.hostExitWaitMs, DEFAULTS.hostExitWaitMs),
		portWaitMs: positive(input.portWaitMs, DEFAULTS.portWaitMs),
		settleMs: positive(input.settleMs, DEFAULTS.settleMs),
		verifyMs: positive(input.verifyMs, DEFAULTS.verifyMs),
		steadyMs: positive(input.steadyMs, DEFAULTS.steadyMs),
		windowWaitMs: positive(input.windowWaitMs, DEFAULTS.windowWaitMs),
		logDir: typeof input.logDir === 'string' && input.logDir.trim() !== '' ? input.logDir.trim() : ''
	};
}

/**
 * Whether this process is the DSH Desktop host, and if so which process is the
 * shell that owns it.
 *
 * Every signal is required, because a wrong answer here terminates an
 * application: the IPC channel proves a shell is watching, `ELECTRON_RUN_AS_NODE`
 * proves it is Electron in Node mode, the entry path proves it is *this* shell
 * (a plain `dsh web` under a terminal inherits none of these), and the parent
 * identifier is the process to relaunch the application around.
 *
 * @param input - Process facts, injectable so each branch is testable.
 * @returns `{ desktop: true, appPid, appExe }` or `{ desktop: false, reason }`.
 */
export function detectDesktopHost(input = {}) {
	const env = input.env ?? {};
	const argv = Array.isArray(input.argv) ? input.argv : [];
	const execPath = typeof input.execPath === 'string' ? input.execPath : '';
	const entry = typeof argv[1] === 'string' ? argv[1] : '';
	const ppid = Number(input.ppid ?? 0);
	const pid = Number(input.pid ?? 0);
	const exists = typeof input.existsSync === 'function' ? input.existsSync : existsSync;

	if (typeof input.send !== 'function' || input.connected !== true) {
		return { desktop: false, reason: 'no-shell-channel' };
	}
	if (String(env.ELECTRON_RUN_AS_NODE ?? '') !== '1') {
		return { desktop: false, reason: 'not-electron-node' };
	}
	if (!DESKTOP_HOST_ENTRY.test(entry)) {
		return { desktop: false, reason: 'not-desktop-host-entry' };
	}
	if (!Number.isInteger(ppid) || ppid <= 0 || ppid === pid) {
		return { desktop: false, reason: 'no-shell-process' };
	}
	if (execPath === '' || basename(execPath) === '') {
		return { desktop: false, reason: 'no-app-executable' };
	}
	if (!exists(execPath)) {
		return { desktop: false, reason: 'app-executable-missing' };
	}
	return { desktop: true, reason: 'desktop-host', appPid: ppid, appExe: execPath };
}

/** Human-readable text for a detection reason, for the button's tooltip. */
export const REASON_TEXT = {
	'disabled': { zh: '这个插件已在配置里停用（enabled: false）', en: 'this plugin is switched off in its configuration (enabled: false)' },
	'no-shell-channel': { zh: '当前 DSH 不是由桌面端启动的（没有可用的外壳进程）', en: 'this DSH was not started by the desktop app (no shell process)' },
	'not-electron-node': { zh: '当前 DSH 不在桌面端外壳里运行', en: 'this DSH is not running inside the desktop shell' },
	'not-desktop-host-entry': { zh: '当前 DSH 由别的入口启动，不是桌面端宿主', en: 'this DSH was started by another entry point, not the desktop host' },
	'no-shell-process': { zh: '找不到桌面端主进程，无法重启', en: 'the desktop app process could not be identified' },
	'no-app-executable': { zh: '找不到桌面端可执行文件，无法重启', en: 'the desktop executable could not be identified' },
	'app-executable-missing': { zh: '桌面端可执行文件已不在原位置，无法重启', en: 'the desktop executable is no longer at its recorded path' },
	'desktop-host': { zh: '', en: '' },
	'already-restarting': { zh: '已经有一次重启在进行中', en: 'a restart is already in progress' },
	'unavailable': { zh: '宿主没有提供重启接口', en: 'the host does not expose the restart route' }
};

/** The localized sentence for a reason code, falling back to the code itself. */
export function reasonText(reason, locale = 'zh') {
	const english = locale === 'en';
	const entry = REASON_TEXT[reason];
	if (entry === undefined) return String(reason ?? '');
	const sentence = english ? entry.en : entry.zh;
	// `desktop-host` is the supported case and its sentence is deliberately empty:
	// there is nothing to explain when the button works.
	if (sentence !== '') return sentence;
	if (reason === 'desktop-host') return '';
	return english ? REASON_TEXT.unavailable.en : REASON_TEXT.unavailable.zh;
}

/**
 * Whether the composition is doing work a restart would interrupt.
 *
 * Mirrors the shell's own quit inspection (`hasDesktopActiveTasks` in the
 * desktop's main process): generating agents, queued inbox messages, and
 * running or stopping jobs. It is read defensively — a composition without
 * `agents` or `jobs` reports "nothing active" rather than throwing on a route.
 */
export function activeWork(agents, jobs) {
	const call = (fn, argument) => {
		try {
			const value = fn(argument);
			return Array.isArray(value) ? value : [];
		} catch {
			return [];
		}
	};
	const roster = agents !== undefined && typeof agents.list === 'function' ? call((id) => agents.list(id)) : [];
	const runningAgents = roster.filter((agent) => agent?.status === 'running').length;
	const queuedMessages = roster.filter(
		(agent) => (agent?.inbox?.nextTurn?.length ?? 0) > 0 || (agent?.inbox?.nextStep?.length ?? 0) > 0
	).length;
	// The shell asks the same two questions (`jobs.list(undefined)` for the global
	// roster, then each agent's own), so this mirrors it rather than summing both
	// — summing would count an agent-owned job twice wherever the global roster
	// already carries it.
	const live = (job) => job?.status === 'running' || job?.status === 'stopping';
	const globalJobs = jobs !== undefined && typeof jobs.list === 'function' ? call(() => jobs.list(undefined)).filter(live) : [];
	const agentJobs = jobs !== undefined && typeof jobs.list === 'function'
		? roster.filter((agent) => call(() => jobs.list(agent.id)).some(live)).length
		: 0;
	const runningJobs = globalJobs.length;
	return {
		active: runningAgents > 0 || queuedMessages > 0 || runningJobs > 0 || agentJobs > 0,
		runningAgents,
		queuedMessages,
		runningJobs
	};
}

/** Loopback test for a bare address, including the IPv6-mapped IPv4 form. */
export function isLoopbackAddress(address) {
	if (typeof address !== 'string' || address === '') return false;
	const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
	if (bare === '::1' || bare === 'localhost') return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare);
}

/** Host header without its port, tolerating a bracketed IPv6 literal. */
export function hostNameOf(header) {
	if (typeof header !== 'string' || header === '') return '';
	if (header.startsWith('[')) return header.slice(1, header.indexOf(']'));
	const colon = header.lastIndexOf(':');
	return colon === -1 ? header : header.slice(0, colon);
}

/**
 * Decide whether a process-control request may be served.
 *
 * Modelled on the fence the plugin market put around its own restart route,
 * with one addition the desktop needs: the shell's custom-protocol carrier
 * *deletes* `origin` before forwarding to this host, so a desktop-window
 * request arrives with no Origin at all. Requiring one would refuse the very
 * click this route exists for, so Origin is checked when present and the
 * unforgeable parts — loopback peer, loopback Host, no forwarding headers, and
 * the deliberate request header — carry the decision.
 *
 * @returns `undefined` when the request is acceptable, else `{ status, body }`.
 */
export function screenRestartRequest(req, options = {}) {
	const method = options.method ?? 'GET';
	const headers = req?.headers ?? {};
	if (req?.method !== method) return { status: 405, body: { ok: false, error: 'method-not-allowed' } };
	if (!isLoopbackAddress(req?.socket?.remoteAddress)) return { status: 403, body: { ok: false, error: 'forbidden' } };
	if (!isLoopbackAddress(hostNameOf(headers.host))) return { status: 403, body: { ok: false, error: 'forbidden' } };
	// Any forwarding trace means the loopback peer is a proxy, not the user.
	if (headers.forwarded !== undefined || headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined) {
		return { status: 403, body: { ok: false, error: 'forbidden' } };
	}
	if (method === 'POST' && typeof headers[REQUEST_HEADER] !== 'string') {
		return { status: 403, body: { ok: false, error: 'missing-request-header' } };
	}
	if (headers.origin !== undefined) {
		let origin;
		try {
			origin = new URL(String(headers.origin));
		} catch {
			return { status: 403, body: { ok: false, error: 'forbidden' } };
		}
		const host = String(headers.host ?? '');
		if (origin.host !== host) return { status: 403, body: { ok: false, error: 'forbidden' } };
	}
	return undefined;
}

/** `restart-<stamp>.cjs` and its siblings, inside the configured directory. */
export function helperPaths(config, now = new Date()) {
	const stamp = now.toISOString().replace(/[:.]/gu, '-').slice(0, 19);
	const directory = config.logDir === '' ? join(tmpdir(), 'dsh-restart-button') : config.logDir;
	return {
		directory,
		script: join(directory, `restart-${stamp}.cjs`),
		log: join(directory, `restart-${stamp}.log`),
		// Where a startup failure of the replacement leaves its stack. The shell
		// writes this file itself when the variable is set, and without it a fatal
		// during startup is a dialog nobody sees plus nothing on disk.
		diagnostic: join(directory, `restart-${stamp}.diagnostic.log`)
	};
}

/**
 * Build the job the helper runs. Split out so the shape is asserted by tests
 * rather than discovered at 3am in a temp file.
 */
export function buildJob(config, detection, options = {}) {
	return {
		appPid: detection.appPid,
		appExe: detection.appExe,
		appDir: dirname(detection.appExe),
		hostPid: Number(options.hostPid ?? 0),
		port: Number.isInteger(options.port) ? options.port : null,
		logPath: options.logPath ?? '',
		diagnosticFile: options.diagnosticFile ?? '',
		raiseScript: options.raiseScript ?? '',
		raiseWindow: config.raiseWindow === true,
		delayMs: config.restartDelayMs,
		shellExitWaitMs: config.shellExitWaitMs,
		hostExitWaitMs: config.hostExitWaitMs,
		portWaitMs: config.portWaitMs,
		settleMs: config.settleMs,
		verifyMs: config.verifyMs,
		steadyMs: config.steadyMs,
		windowWaitMs: config.windowWaitMs
	};
}

/**
 * Source of the detached helper.
 *
 * Written as lines rather than as a template literal so the escaping that
 * matters (Windows paths, JSON payload) happens exactly once, through
 * `JSON.stringify`, instead of being reasoned about twice.
 *
 * The helper must survive the death of both processes it is watching, so it
 * runs detached, logs everything it does to a file beside itself (the process
 * that would have reported a failure is the one that just died), and never
 * uses the console.
 */
export function restartHelperSource(job) {
	const value = (input) => JSON.stringify(input);
	return [
		"'use strict'",
		"const { spawn, spawnSync } = require('node:child_process')",
		"const { appendFileSync } = require('node:fs')",
		"const net = require('node:net')",
		'',
		`const job = ${value(job)}`,
		'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
		'const note = (line) => {',
		"  try { appendFileSync(job.logPath, new Date().toISOString() + ' ' + line + '\\n') } catch {}",
		'}',
		"process.on('uncaughtException', (error) => note('helper crashed: ' + (error && error.stack ? error.stack : error)))",
		"process.on('unhandledRejection', (error) => note('helper rejection: ' + (error && error.stack ? error.stack : error)))",
		"process.on('exit', (code) => note('helper exiting (code ' + code + ')'))",
		'',
		'/** Whether a pid still exists; EPERM means it does, owned by someone else. */',
		'const alive = (pid) => {',
		'  if (!pid) return false',
		'  try { process.kill(pid, 0); return true } catch (error) { return error && error.code === "EPERM" }',
		'}',
		'/** A free port is one nothing accepts a connection on — never bind to test. */',
		'const listening = () => new Promise((resolve) => {',
		'  if (!job.port) { resolve(false); return }',
		"  const probe = net.connect({ host: '127.0.0.1', port: job.port })",
		'  const done = (answer) => { probe.destroy(); resolve(answer) }',
		"  probe.on('connect', () => done(true))",
		"  probe.on('error', () => done(false))",
		'  setTimeout(() => done(false), 500)',
		'})',
		'const until = async (check, budget, label) => {',
		'  const deadline = Date.now() + budget',
		'  while (Date.now() < deadline) {',
		'    if (await check()) return true',
		'    await sleep(200)',
		'  }',
		'  note(label + " (waited " + budget + "ms)")',
		'  return false',
		'}',
		'',
		'/** Terminate one process hard, and say what happened either way. */',
		'const terminate = (pid, what) => {',
		'  if (!alive(pid)) { note(what + " (pid " + pid + ") is already gone"); return true }',
		'  try {',
		"    process.kill(pid, 'SIGKILL')",
		'    note("terminated " + what + " (pid " + pid + ")")',
		'    return true',
		'  } catch (error) {',
		'    note("could not terminate " + what + " (pid " + pid + "): " + (error && error.message ? error.message : error))',
		'    return false',
		'  }',
		'}',
		'',
		'/** The console host every Windows install ships, which owns the window APIs. */',
		'const powershellPath = () => {',
		"  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\\\Windows'",
		"  return root + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'",
		'}',
		'/**',
		' * Ask raise-window.ps1 what the replacement\'s windows look like, and tell it',
		' * to show the main one. Returns its JSON report, or null when unusable.',
		' */',
		'const windowState = (pid, raise) => {',
		'  if (!job.raiseScript || !pid) return null',
		"  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', job.raiseScript, '-ProcessId', String(pid)]",
		"  if (raise) args.push('-Raise')",
		'  let result',
		'  try {',
		'    result = spawnSync(powershellPath(), args, { encoding: "utf8", windowsHide: true, timeout: 30000 })',
		'  } catch (error) {',
		"    note('the window probe could not run: ' + (error && error.message ? error.message : error))",
		'    return null',
		'  }',
		"  if (result.error) { note('the window probe failed: ' + result.error.message); return null }",
		'  const text = String(result.stdout || "").trim()',
		'  try { return JSON.parse(text) } catch {',
		"    note('the window probe answered with something that is not JSON: ' + text.slice(0, 200))",
		'    return null',
		'  }',
		'}',
		'/**',
		' * Make sure the replacement actually shows a window.',
		' *',
		' * A replacement started by this helper is not the foreground process, and the',
		' * first report from the field was exactly that: the tray icon came back, the',
		' * host was serving, and no window ever appeared until the user double-clicked',
		' * the tray. So the window is not assumed — it is looked at, and raised when it',
		' * is missing or hidden.',
		' */',
		'const showWindow = async (pid, relaunch) => {',
		'  if (!job.raiseWindow || !job.raiseScript || !pid) return',
		'  // Wait for the window before judging it: a replacement judged too early is',
		'  // "a replacement with no window", which buys a pointless second launch and a',
		'  // verdict in this log that describes the clock rather than the application.',
		'  const deadline = Date.now() + job.windowWaitMs',
		'  let first = windowState(pid, true)',
		'  while ((!first || !first.main || first.visibleAfter !== true) && Date.now() < deadline) {',
		'    await sleep(500)',
		'    first = windowState(pid, true)',
		'  }',
		"  note('window state after the relaunch: ' + JSON.stringify(first))",
		'  if (first && first.main && first.visibleAfter === true) return',
		'  // Either there was no window to raise or it stayed hidden. A second launch',
		'  // is what the user does by hand: the running instance answers the',
		'  // second-instance event by showing its window. Do that, then look again.',
		"  note('no visible window yet; asking the running instance to show one')",
		'  relaunch()',
		'  await sleep(2500)',
		"  note('window state after the second launch: ' + JSON.stringify(windowState(pid, true)))",
		'}',
		'',
		'const main = async () => {',
		'  note("helper up (pid " + process.pid + ") to restart the shell (pid " + job.appPid + ") via " + job.appExe)',
		'  // Let the HTTP response that asked for this reach the page first; killing',
		'  // the shell mid-response turns a working button into a network error.',
		'  await sleep(job.delayMs)',
		'  if (!terminate(job.appPid, "the desktop shell")) {',
		'    // Without the shell gone there is nothing to replace: a fresh launch',
		'    // would only hit the single-instance lock and focus the old window.',
		'    note("aborting: the shell could not be terminated, so no replacement was started")',
		'    return',
		'  }',
		'  await until(async () => !alive(job.appPid), job.shellExitWaitMs, "the shell was still alive after the kill")',
		'  // The host is a child of the shell: its IPC channel closes when the shell',
		'  // dies and the desktop host shuts down cleanly on its own. This only waits,',
		'  // and only terminates when the host outlives its parent.',
		'  if (alive(job.hostPid)) {',
		'    const exited = await until(async () => !alive(job.hostPid), job.hostExitWaitMs, "the host did not shut down after the shell exited")',
		'    if (!exited) terminate(job.hostPid, "the DSH host")',
		'  }',
		'  if (job.port) {',
		'    const free = await until(async () => !(await listening()), job.portWaitMs, "port " + job.port + " was still in use")',
		'    if (!free) note("starting the replacement anyway — it will fail loudly if the port is truly taken")',
		'    await sleep(job.settleMs)',
		'  }',
		'  const env = { ...process.env }',
		'  // Inherited Electron-as-Node state must not leak into the application.',
		"  delete env.ELECTRON_RUN_AS_NODE",
		"  delete env.NODE_OPTIONS",
		"  delete env.ELECTRON_NO_ATTACH_CONSOLE",
		'  // A startup failure the shell reports through this path leaves a stack',
		'  // behind instead of a dialog nobody sees.',
		'  if (job.diagnosticFile) env.DSH_DESKTOP_DIAGNOSTIC_FILE = job.diagnosticFile',
		'  /** Start one instance of the application; the caller decides what to watch. */',
		'  const startApp = () => {',
		'    try {',
		'      const started = spawn(job.appExe, [], {',
		'        cwd: job.appDir,',
		'        detached: true,',
		"        stdio: 'ignore',",
		'        env,',
		'        // NOT windowsHide: that sets STARTF_USESHOWWINDOW/SW_HIDE on a',
		'        // GUI child, which is one more way its first window can start',
		'        // hidden — the exact failure this helper then has to clean up.',
		'        windowsHide: false',
		'      })',
		"      started.on('error', (error) => note('could not start the replacement: ' + (error && error.message ? error.message : error)))",
		'      started.unref()',
		'      note("started the replacement (pid " + started.pid + ")")',
		'      return started.pid ?? null',
		'    } catch (error) {',
		"      note('could not start the replacement: ' + (error && error.message ? error.message : error))",
		'      return null',
		'    }',
		'  }',
		'  let replacementPid = startApp()',
		'  if (replacementPid === null) return',
		'  if (!job.port) {',
		'    // No port to watch: give the application a moment, then make sure it is',
		'    // actually on screen. The window step is not tied to the port check.',
		'    await sleep(3000)',
		'    await showWindow(replacementPid, startApp)',
		'    return',
		'  }',
		'  // Success is not "the port answered once": a boot that fails after',
		'  // binding answers for a moment and then exits. Require it to stay up.',
		'  const upBy = Date.now() + job.verifyMs',
		'  let steadySince = null',
		'  let up = false',
		'  while (Date.now() < upBy) {',
		'    if (await listening()) {',
		'      if (steadySince === null) steadySince = Date.now()',
		'      else if (Date.now() - steadySince >= job.steadyMs) { up = true; break }',
		'    } else steadySince = null',
		'    await sleep(500)',
		'  }',
		'  if (!up) {',
		"    note(\"the replacement never came up on port \" + job.port + \" — see this log and the app's own logs\")",
		'    return',
		'  }',
		'  note("the replacement is up on port " + job.port)',
		'  await showWindow(replacementPid, startApp)',
		'}',
		'',
		'main()'
	].join('\n');
}
