/**
 * The decisions behind the button, exercised without a desktop app.
 *
 * Everything asserted here is a rule that would be expensive to get wrong in
 * production: which process may be terminated, which request may ask for it,
 * and what the helper that outlives this process is told to do.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
	activeWork,
	buildJob,
	DEFAULTS,
	detectDesktopHost,
	helperPaths,
	hostNameOf,
	isLoopbackAddress,
	normalizeConfig,
	NOW_PATH,
	reasonText,
	restartHelperSource,
	screenRestartRequest,
	STATUS_PATH
} from '../src/restart-plan.js';

/**
 * Synthetic paths shaped like a desktop launch.
 *
 * The detector's subject is the *shape* of an invocation — an executable that
 * is also the host's Node runtime, an entry inside `app.asar`, a profile
 * directory — so the values below are deliberately invented. A real machine's
 * layout and user name belong in a live diagnosis, not in a public repository,
 * which is what the first version of this file got wrong.
 */
const APP_DIR = 'X:\\apps\\DeepSeek Harness';
const APP_EXE = `${APP_DIR}\\DeepSeek Harness.exe`;
const PROFILE_DIR = 'X:\\home\\you\\.dsh\\profiles\\desktop';

/** The process facts of a desktop host, shaped from a live launch. */
const desktopFacts = () => ({
	env: { ELECTRON_RUN_AS_NODE: '1' },
	argv: [
		APP_EXE,
		`${APP_DIR}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js`,
		`${APP_DIR}\\resources\\app.asar\\dsh`,
		PROFILE_DIR
	],
	execPath: APP_EXE,
	ppid: 54884,
	pid: 6900,
	connected: true,
	send: () => {},
	existsSync: () => true
});

test('a desktop host is identified, with the shell pid and the app executable', () => {
	const detection = detectDesktopHost(desktopFacts());
	assert.equal(detection.desktop, true);
	assert.equal(detection.appPid, 54884);
	assert.equal(detection.appExe, APP_EXE);
});

test('every missing desktop signal is refused, and named', () => {
	const cases = [
		['no-shell-channel', { connected: false }],
		['no-shell-channel', { send: undefined }],
		['not-electron-node', { env: {} }],
		['not-desktop-host-entry', { argv: ['node', 'C:\\somewhere\\bin.js'] }],
		['no-shell-process', { ppid: 0 }],
		['no-shell-process', { ppid: 6900 }],
		['no-app-executable', { execPath: '' }],
		['app-executable-missing', { existsSync: () => false }]
	];
	for (const [reason, patch] of cases) {
		const detection = detectDesktopHost({ ...desktopFacts(), ...patch });
		assert.equal(detection.desktop, false, `${reason} should not be treated as desktop`);
		assert.equal(detection.reason, reason);
	}
});

test('a plain `dsh web` under a terminal is never mistaken for the desktop host', () => {
	// The shape that matters: a real DSH host, but started by a shell rather than
	// by Electron, so there is no shell process to relaunch and process.ppid is
	// whatever terminal opened it.
	const detection = detectDesktopHost({
		env: { PATH: 'C:\\Program Files\\nodejs' },
		argv: ['C:\\Program Files\\nodejs\\node.exe', 'X:\\home\\you\\src\\dsh\\bin.js', 'web'],
		execPath: 'C:\\Program Files\\nodejs\\node.exe',
		ppid: 4711,
		pid: 4712,
		connected: false,
		send: undefined,
		existsSync: () => true
	});
	assert.equal(detection.desktop, false);
	assert.equal(detection.reason, 'no-shell-channel');
});

test('config is normalized, and unusable values fall back to the defaults', () => {
	const normalized = normalizeConfig({ raiseWindow: 'yes please', restartDelayMs: -5, logDir: '  ' });
	// `raiseWindow` is on unless it is explicitly false: a string is not a "no".
	assert.equal(normalized.raiseWindow, true);
	assert.equal(normalized.restartDelayMs, DEFAULTS.restartDelayMs);
	assert.equal(normalized.logDir, '');
	assert.equal(normalizeConfig({ raiseWindow: false }).raiseWindow, false);
	assert.equal(normalizeConfig({ restartDelayMs: 2500 }).restartDelayMs, 2500);
	assert.equal(normalizeConfig(undefined).enabled, true);
	assert.equal(normalizeConfig({ enabled: false }).enabled, false);
	assert.equal(normalizeConfig({ logDir: 'D:\\logs' }).logDir, 'D:\\logs');
});

test('the work inspector mirrors the shell: running agents, queued inbox, live jobs', () => {
	const idle = activeWork({ list: () => [] }, { list: () => [] });
	assert.equal(idle.active, false);

	const generating = activeWork({ list: () => [{ status: 'running', inbox: {} }] }, undefined);
	assert.equal(generating.active, true);
	assert.equal(generating.runningAgents, 1);

	const queued = activeWork({ list: () => [{ status: 'inactive', inbox: { nextStep: [{}, {}] } }] }, undefined);
	assert.equal(queued.active, true);
	assert.equal(queued.queuedMessages, 1);

	const jobbed = activeWork({ list: () => [{ status: 'inactive', inbox: {} }] }, { list: () => [{ status: 'stopping' }] });
	assert.equal(jobbed.active, true);
	assert.equal(jobbed.runningJobs, 1);

	// A job the global roster does not carry still counts, because the shell asks
	// each agent's own roster too.
	const agentScoped = activeWork(
		{ list: () => [{ id: 's1', status: 'inactive', inbox: {} }] },
		{ list: (id) => (id === 's1' ? [{ status: 'running' }] : []) }
	);
	assert.equal(agentScoped.active, true);
	assert.equal(agentScoped.runningJobs, 0);

	// A composition without those services reports "nothing active" instead of
	// throwing on a route that a HTTP handler runs.
	assert.equal(activeWork(undefined, undefined).active, false);
	assert.equal(activeWork({ list: () => { throw new Error('no'); } }, { list: () => { throw new Error('no'); } }).active, false);
});

test('loopback and Host parsing cover the shapes Node actually reports', () => {
	assert.equal(isLoopbackAddress('127.0.0.1'), true);
	assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
	assert.equal(isLoopbackAddress('::1'), true);
	assert.equal(isLoopbackAddress('192.168.1.10'), false);
	assert.equal(isLoopbackAddress(undefined), false);
	assert.equal(hostNameOf('127.0.0.1:19387'), '127.0.0.1');
	assert.equal(hostNameOf('[::1]:19387'), '::1');
	assert.equal(hostNameOf('evil.example.com'), 'evil.example.com');
});

test('the restart request fence: loopback peer, loopback Host, no forwarding, and the header', () => {
	const base = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } };
	assert.equal(screenRestartRequest(base, { method: 'GET' }), undefined);
	assert.equal(screenRestartRequest({ ...base, method: 'POST' }, { method: 'GET' })?.status, 405);
	assert.equal(screenRestartRequest({ ...base, socket: { remoteAddress: '10.0.0.7' } }, { method: 'GET' })?.status, 403);
	assert.equal(screenRestartRequest({ ...base, headers: { host: 'attacker.example' } }, { method: 'GET' })?.status, 403);
	assert.equal(
		screenRestartRequest({ ...base, headers: { ...base.headers, 'x-forwarded-for': '10.0.0.7' } }, { method: 'GET' })?.status,
		403
	);

	// The desktop window's own request arrives with NO Origin: the shell's
	// custom-protocol carrier deletes it before forwarding to the host. A fence
	// that demanded one would refuse the only click this route exists for.
	const post = { ...base, method: 'POST' };
	assert.equal(screenRestartRequest(post, { method: 'POST' })?.body.error, 'missing-request-header');
	const postWithHeader = { ...post, headers: { ...post.headers, 'x-dsh-restart': '1' } };
	assert.equal(screenRestartRequest(postWithHeader, { method: 'POST' }), undefined);

	// An Origin that does arrive (a browser tab) has to name this host.
	assert.equal(
		screenRestartRequest({ ...postWithHeader, headers: { ...postWithHeader.headers, origin: 'http://127.0.0.1:19387' } }, { method: 'POST' }),
		undefined
	);
	assert.equal(
		screenRestartRequest({ ...postWithHeader, headers: { ...postWithHeader.headers, origin: 'http://evil.example' } }, { method: 'POST' })?.status,
		403
	);
});

test('the helper job carries the shell, the host, the port and the log', () => {
	const config = normalizeConfig({});
	const detection = { appPid: 1234, appExe: 'X:\\apps\\dsh\\DeepSeek Harness.exe' };
	const job = buildJob(config, detection, { hostPid: 5678, port: 19387, logPath: 'C:\\tmp\\x.log' });
	assert.deepEqual(
		{ appPid: job.appPid, hostPid: job.hostPid, port: job.port, logPath: job.logPath },
		{ appPid: 1234, hostPid: 5678, port: 19387, logPath: 'C:\\tmp\\x.log' }
	);
	assert.equal(job.appDir, 'X:\\apps\\dsh');
	assert.equal(job.verifyMs, DEFAULTS.verifyMs);
});

test('the helper source is valid JavaScript and encodes the whole sequence', () => {
	const job = buildJob(
		normalizeConfig({ raiseWindow: true }),
		{ appPid: 42, appExe: 'C:\\app\\app.exe' },
		{
			hostPid: 43,
			port: 19387,
			logPath: 'C:\\tmp\\restart.log',
			diagnosticFile: 'C:\\tmp\\restart.diagnostic.log',
			raiseScript: 'C:\\plugins\\dsh-restart-button\\src\\raise-window.ps1'
		}
	);
	const source = restartHelperSource(job);
	// Parsing it here is the point: the helper runs in a process that is about to
	// be orphaned, so a syntax error would be invisible until a user clicked.
	new vm.Script(source, { filename: 'restart-helper.cjs' });
	for (const fragment of [
		"require('node:child_process')",
		'SIGKILL',
		'ELECTRON_RUN_AS_NODE',
		'job.appExe',
		'listening()',
		// The window step, which is what turns "the tray icon is back" into "the
		// interface is back", and the diagnostic the replacement's startup leaves.
		'showWindow(replacementPid, startApp)',
		'window state after the relaunch',
		'DSH_DESKTOP_DIAGNOSTIC_FILE',
		// A GUI child must not inherit the hidden-show-state flag.
		'windowsHide: false'
	]) {
		assert.ok(source.includes(fragment), `the helper should mention ${fragment}`);
	}
	assert.ok(source.includes(JSON.stringify('C:\\app\\app.exe')), 'the executable path must survive escaping');
	assert.ok(source.includes(JSON.stringify('C:\\plugins\\dsh-restart-button\\src\\raise-window.ps1')), 'the probe path must survive escaping');
	assert.ok(/main\(\)\s*$/u.test(source), 'the helper must actually run');
});

test('the window step is skipped when it is switched off or has no script', () => {
	const off = buildJob(normalizeConfig({ raiseWindow: false }), { appPid: 1, appExe: 'C:\\app\\a.exe' }, { hostPid: 2, port: 3 });
	assert.equal(off.raiseWindow, false);
	assert.ok(restartHelperSource(off).includes('if (!job.raiseWindow || !job.raiseScript || !pid) return'));

	const on = buildJob(normalizeConfig({}), { appPid: 1, appExe: 'C:\\app\\a.exe' }, { hostPid: 2, port: 3 });
	assert.equal(on.raiseWindow, true);
	assert.equal(on.raiseScript, '', 'no script means the helper cannot probe at all');
	assert.equal(normalizeConfig({ raiseWindow: false }).raiseWindow, false);
	assert.equal(normalizeConfig(undefined).raiseWindow, true, 'raising is on by default');
});

test('helper files land in one directory, stamped and distinct', () => {
	const config = normalizeConfig({});
	const first = helperPaths(config, new Date('2026-10-01T10:20:30.400Z'));
	const second = helperPaths(config, new Date('2026-10-01T10:20:31.000Z'));
	assert.match(first.script, /restart-2026-10-01T10-20-30\.cjs$/u);
	assert.match(first.log, /restart-2026-10-01T10-20-30\.log$/u);
	assert.notEqual(first.script, second.script);
	const configured = helperPaths(normalizeConfig({ logDir: 'D:\\dsh-logs' }));
	assert.match(configured.script, /^D:\\dsh-logs\\/u);
	assert.equal(NOW_PATH, '/api/dsh-restart/now');
	assert.equal(STATUS_PATH, '/api/dsh-restart/status');
});

test('every reason code has a sentence in both languages', () => {
	for (const reason of [
		'disabled',
		'no-shell-channel',
		'not-electron-node',
		'not-desktop-host-entry',
		'no-shell-process',
		'no-app-executable',
		'app-executable-missing'
	]) {
		assert.ok(reasonText(reason, 'zh').length > 0, `${reason} needs a Chinese sentence`);
		assert.ok(reasonText(reason, 'en').length > 0, `${reason} needs an English sentence`);
	}
	assert.equal(reasonText('unheard-of', 'zh'), 'unheard-of');
	// The supported case explains nothing, in both languages: the button is
	// there and it works, and a sentence about it would be noise in the tooltip.
	assert.equal(reasonText('desktop-host', 'zh'), '');
	assert.equal(reasonText('desktop-host', 'en'), '');
});
