/**
 * The window probe, run for real.
 *
 * This is the piece that fixes the reported failure — a replacement DSH that
 * came back with its tray icon, its host serving, and no window — so it is
 * measured rather than assumed: a window this script hides itself has to come
 * back visible, on the same code path the helper uses.
 *
 * The window is this suite's own compiled fixture, off-screen: see
 * `tools/probe-window-fixture.mjs` for why a real application (Notepad, in the
 * first draft) was the wrong thing to borrow.
 *
 * Windows-only, because it is user32 through PowerShell.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	assertNothingLeftRunning,
	buildProbeWindow,
	hasCompiler,
	killTree,
	PROBE_WINDOW_TITLE,
	startProbeWindow
} from '../tools/probe-window-fixture.mjs';

const script = fileURLToPath(new URL('../src/raise-window.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const usable = process.platform === 'win32' && existsSync(powershell) && hasCompiler();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the probe, returning its parsed JSON report. */
function probe(pid, ...extra) {
	const result = spawnSync(
		powershell,
		['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), ...extra],
		{ encoding: 'utf8', windowsHide: true, timeout: 60_000 }
	);
	assert.equal(result.status, 0, `the probe should exit cleanly: ${result.stderr}`);
	const text = String(result.stdout ?? '').trim();
	assert.ok(text.startsWith('{'), `the probe should answer with JSON, got: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

test('the probe reports this process honestly when there is no window', { skip: !usable }, () => {
	const report = probe(process.pid);
	assert.equal(report.pid, process.pid);
	assert.equal(report.alive, true);
	assert.equal(typeof report.windowCount, 'number');
	assert.equal(report.raised, false);
	// A console process's window belongs to conhost, not to node, so this is
	// normally null — the point is that "no window" is an answer, not a crash.
	if (report.main !== null) assert.equal(typeof report.main.handle, 'number');
});

test('the probe reports a missing process instead of throwing', { skip: !usable }, () => {
	// A pid that cannot exist: the helper runs this after the shell is gone, so
	// "the process is not there" must be data, not an exception.
	const report = probe(999_999);
	assert.equal(report.alive, false);
	assert.equal(report.windowCount, 0);
	assert.equal(report.main, null);
	assert.equal(report.visibleAfter, false);
});

test('a hidden window is hidden, then raised back into view', { skip: !usable }, async () => {
	// The window is this suite's own fixture: no document, off-screen, and owned
	// by an executable inside this test's temp directory — so a leak is a red
	// test rather than a blank application on somebody's desktop.
	const directory = mkdtempSync(join(tmpdir(), 'dsh-probe-window-'));
	const exe = buildProbeWindow(directory);
	assert.ok(exe !== null, 'the fixture needs a C# compiler');
	const child = startProbeWindow(exe);
	try {
		assert.ok(child.pid > 0);
		let report = null;
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			report = probe(child.pid);
			if (report.main !== null) break;
			await sleep(400);
		}
		assert.ok(report?.main !== null, 'the fixture window should exist');
		assert.equal(report.visibleAfter, true, 'a fresh fixture window is visible even off-screen');
		// The report has to survive PowerShell's console encoding on its way to
		// Node: a mangled title is a diagnosis nobody can read.
		assert.equal(report.main.title, PROBE_WINDOW_TITLE, 'the window title must round-trip as UTF-8');

		const hidden = probe(child.pid, '-Hide');
		assert.equal(hidden.hidden, true, 'the test hook hides the window');
		assert.equal(hidden.visibleAfter, false, 'and the probe reports it hidden');

		const raised = probe(child.pid, '-Raise');
		assert.equal(raised.raised, true, 'the raise path reports that it acted');
		assert.equal(raised.visibleAfter, true, 'and the window is visible again');
	} finally {
		if (child.pid !== undefined) killTree(child.pid);
		await assertNothingLeftRunning(directory, 'raise-window');
		rmSync(directory, { recursive: true, force: true });
	}
});
