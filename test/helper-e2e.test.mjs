/**
 * The generated helper, run for real.
 *
 * The unit tests prove the helper *parses*; this one proves it *works*, against
 * real processes: it stands up a fake shell (a long-lived process) and a fake
 * host (a process holding a port), runs the generated helper exactly as the
 * plugin would, and then asserts what the user's restart depends on —
 * the shell is gone, the port is released, and a replacement was started.
 *
 * Nothing here is DSH. The shell stand-in is an ordinary Node process and the
 * replacement is a Node executable, so a failure costs a temp directory rather
 * than the user's session.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildJob, normalizeConfig, restartHelperSource } from '../src/restart-plan.js';
import {
	assertNothingLeftRunning,
	buildProbeWindow,
	hasCompiler,
	killTree,
	launchedPids
} from '../tools/probe-window-fixture.mjs';

const nodeExe = process.execPath;
const raiseScript = fileURLToPath(new URL('../src/raise-window.ps1', import.meta.url));
const windowsOnly = process.platform === 'win32';
/** The window-verdict test needs a real GUI process it can build and own. */
const windowFixture = windowsOnly && hasCompiler();

/** A port nothing is listening on, released immediately after it is found. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Whether a pid is still alive. */
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

/** Whether something accepts a connection on a loopback port. */
function listening(port) {
	return new Promise((resolve) => {
		const probe = net.connect({ host: '127.0.0.1', port });
		const done = (answer) => {
			probe.destroy();
			resolve(answer);
		};
		probe.on('connect', () => done(true));
		probe.on('error', () => done(false));
		setTimeout(() => done(false), 500);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a stand-in process and hand back its pid and an exit promise. */
function startStandIn(source) {
	const child = spawn(nodeExe, ['-e', source], { stdio: 'ignore', windowsHide: true });
	const exited = new Promise((resolve) => child.once('exit', resolve));
	return { child, pid: child.pid, exited };
}

/**
 * A config whose waits are short enough for a test and long enough to be real.
 *
 * `raiseWindow` is off here on purpose: these tests are about the process
 * sequence, and the window probe has its own test against a window it hides
 * itself. The probe's wiring into the helper is asserted separately.
 */
const fastConfig = (overrides = {}) =>
	normalizeConfig({
		restartDelayMs: 100,
		shellExitWaitMs: 3_000,
		hostExitWaitMs: 1_200,
		portWaitMs: 5_000,
		settleMs: 100,
		verifyMs: 1_500,
		steadyMs: 500,
		windowWaitMs: 1_200,
		raiseWindow: false,
		...overrides
	});

test('the helper terminates the shell, waits out the port, and starts a replacement', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'));
	const logPath = join(directory, 'restart.log');
	const scriptPath = join(directory, 'restart.cjs');
	const port = await freePort();
	const config = fastConfig();

	const shell = startStandIn('setInterval(() => {}, 1000)');
	const host = startStandIn(
		`require('node:http').createServer((request, response) => response.end('ok')).listen(${port}, '127.0.0.1')`
	);
	try {
		assert.ok(shell.pid > 0 && host.pid > 0);
		assert.ok(await waitForPort(port), 'the stand-in host should hold the port');

		const job = buildJob(config, { appPid: shell.pid, appExe: nodeExe }, {
			hostPid: host.pid,
			port,
			logPath
		});
		await writeFile(scriptPath, restartHelperSource(job), 'utf8');
		const helper = spawn(nodeExe, [scriptPath], { stdio: 'ignore', windowsHide: true });
		const code = await new Promise((resolve) => helper.once('exit', resolve));

		const log = readFileSync(logPath, 'utf8');
		assert.equal(code, 0, `the helper should exit cleanly:\n${log}`);
		assert.match(log, /helper up/u);
		assert.match(log, /terminated the desktop shell \(pid \d+\)/u);
		// The stand-in host does not shut itself down the way the real desktop
		// host does when its IPC channel closes, so this also covers the branch
		// that terminates a host which outlived its parent.
		assert.match(log, /the host did not shut down after the shell exited/u);
		assert.match(log, /terminated the DSH host \(pid \d+\)/u);
		assert.match(log, /started the replacement \(pid \d+\)/u);
		assert.doesNotMatch(log, /could not start the replacement/u);
		assert.doesNotMatch(log, /helper crashed/u);

		assert.equal(alive(shell.pid), false, 'the shell must be gone');
		assert.equal(alive(host.pid), false, 'the host must be gone');
		assert.equal(await listening(port), false, 'the port must be released before relaunching');
	} finally {
		for (const pid of [shell.pid, host.pid]) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				/* already gone, which is the point */
			}
		}
		await Promise.race([Promise.all([shell.exited, host.exited]), sleep(2000)]);
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a replacement that cannot start is written down, not swallowed', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'));
	const logPath = join(directory, 'restart.log');
	const scriptPath = join(directory, 'restart.cjs');
	const config = fastConfig();
	const shell = startStandIn('setInterval(() => {}, 1000)');
	try {
		const job = buildJob(config, { appPid: shell.pid, appExe: join(directory, 'not-an-application.exe') }, {
			hostPid: 0,
			port: null,
			logPath
		});
		await writeFile(scriptPath, restartHelperSource(job), 'utf8');
		const helper = spawn(nodeExe, [scriptPath], { stdio: 'ignore', windowsHide: true });
		await new Promise((resolve) => helper.once('exit', resolve));

		const log = readFileSync(logPath, 'utf8');
		assert.match(log, /could not start the replacement/u);
		assert.equal(alive(shell.pid), false, 'the shell is still terminated even when the relaunch fails');
	} finally {
		try {
			process.kill(shell.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
		await Promise.race([shell.exited, sleep(2000)]);
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Wait for a loopback port to accept a connection. */
async function waitForPort(port, budgetMs = 5000) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (await listening(port)) return true;
		await sleep(100);
	}
	return false;
}

/** Run the generated helper to completion with one job, and return its log. */
async function runHelper(job, directory, name) {
	const logPath = join(directory, `${name}.log`);
	const scriptPath = join(directory, `${name}.cjs`);
	await writeFile(scriptPath, restartHelperSource({ ...job, logPath }), 'utf8');
	const helper = spawn(nodeExe, [scriptPath], { stdio: 'ignore', windowsHide: true });
	await new Promise((resolve) => helper.once('exit', resolve));
	return readFileSync(logPath, 'utf8');
}

test('a replacement with no window at all falls back to a second launch', { skip: !windowsOnly }, async () => {
	// The reported failure was exactly this shape: the replacement was up and
	// serving, and no window ever appeared. The helper now asks the window probe
	// and writes the answer down, so a log line — not a guess — says whether the
	// interface came back.
	const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'));
	const config = fastConfig({ raiseWindow: true });
	const shell = startStandIn('setInterval(() => {}, 1000)');
	try {
		// node, launched with no arguments, has no top-level window at all: the
		// honest "there is nothing to raise" answer, which must lead to the second
		// launch rather than to silence.
		const job = buildJob(config, { appPid: shell.pid, appExe: nodeExe }, {
			hostPid: 0,
			port: null,
			logPath: '',
			raiseScript
		});
		const log = await runHelper(job, directory, 'window');
		assert.match(log, /window state after the relaunch: \{/u);
		assert.match(log, /"main":null/u, `the probe should report no window:\n${log}`);
		assert.match(log, /no visible window yet; asking the running instance to show one/u);
		assert.match(log, /window state after the second launch: \{/u);
	} finally {
		try {
			process.kill(shell.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
		await Promise.race([shell.exited, sleep(2000)]);
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a window that is already up is left alone', { skip: !windowFixture }, async () => {
	// The other half of the verdict: when the probe finds a visible window, the
	// helper must NOT launch a second instance — that would only focus the window
	// and, worse, hide a real "the window never appeared" failure behind a retry.
	const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'));
	// The replacement is this suite's own fixture, built inside this directory:
	// no document window, off-screen, and any survivor is found by path below.
	const exe = buildProbeWindow(directory);
	assert.ok(exe !== null, 'the fixture needs a C# compiler');
	// A budget the window genuinely has time to appear inside. The helper waits
	// for the window now, so this is not a race against a cold application start.
	const config = fastConfig({ raiseWindow: true, windowWaitMs: 10_000 });
	const shell = startStandIn('setInterval(() => {}, 1000)');
	let log = '';
	try {
		const job = buildJob(config, { appPid: shell.pid, appExe: exe }, {
			hostPid: 0,
			port: null,
			logPath: '',
			raiseScript
		});
		log = await runHelper(job, directory, 'visible');
		assert.match(log, /window state after the relaunch: \{/u);
		assert.match(log, /"visibleAfter":true/u, `the probe should find the fixture window:\n${log}`);
		assert.doesNotMatch(log, /no visible window yet/u);
		// The helper may legitimately start the replacement twice; THIS run must not,
		// because a visible window was found.
		assert.equal(launchedPids(log).length, 1, 'exactly one launch');
	} finally {
		// Every pid the log names, not just the first: the fallback launch is part of
		// the contract of the code under test, and a cleanup that assumes one process
		// is how one blank Notepad per run ended up on somebody's desktop.
		for (const pid of launchedPids(log)) killTree(pid);
		try {
			process.kill(shell.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
		await Promise.race([shell.exited, sleep(2000)]);
		await assertNothingLeftRunning(directory, 'helper-e2e visible window');
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a detached child outlives the process that spawned it', async () => {
	// The whole design rests on this: the helper is started by the host, and the
	// host is one of the processes the helper has to outlive. If Windows took the
	// helper down with its parent, the button would kill DSH and nothing would
	// bring it back — so it is measured rather than assumed.
	const directory = mkdtempSync(join(tmpdir(), 'dsh-restart-e2e-'));
	const childLog = join(directory, 'child.log');
	const childSource = [
		"const fs = require('node:fs')",
		"fs.appendFileSync(process.env.CHILD_LOG, 'child up ' + process.pid + '\\n')",
		"setTimeout(() => { fs.appendFileSync(process.env.CHILD_LOG, 'child survived its parent\\n'); process.exit(0) }, 2500)"
	].join('\n');
	const parentSource = [
		"const { spawn } = require('node:child_process')",
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { detached: true, stdio: 'ignore', env: process.env })`,
		'child.unref()',
		"setTimeout(() => {}, 60000)"
	].join('\n');

	const parent = spawn(nodeExe, ['-e', parentSource], {
		stdio: 'ignore',
		windowsHide: true,
		env: { ...process.env, CHILD_LOG: childLog }
	});
	try {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			try {
				if (readFileSync(childLog, 'utf8').includes('child up')) break;
			} catch {
				/* not written yet */
			}
			await sleep(100);
		}
		assert.match(readFileSync(childLog, 'utf8'), /child up/u, 'the detached child should have started');

		process.kill(parent.pid, 'SIGKILL');
		await new Promise((resolve) => parent.once('exit', resolve));
		await sleep(3200);

		assert.match(
			readFileSync(childLog, 'utf8'),
			/child survived its parent/u,
			'the detached child must outlive the process that started it'
		);
	} finally {
		try {
			process.kill(parent.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
