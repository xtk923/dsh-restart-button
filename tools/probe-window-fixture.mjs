/**
 * A throwaway GUI window the tests own end to end.
 *
 * ## Why this exists (the litter lesson)
 *
 * Two tests need a real window: one drives the probe's hide/raise path, the
 * other needs a replacement process that is genuinely on screen. Both used
 * Notepad, and both cleaned up by killing the pid they had seen — which was the
 * wrong contract twice over:
 *
 *   - Notepad is a *document* window. A leftover is not an invisible test
 *     artifact, it is a blank application on somebody's desktop, and a suite run
 *     five times leaves five of them.
 *   - The helper is allowed to launch the replacement TWICE (the second launch
 *     is the feature that makes a windowless shell show its window), and the
 *     cleanup killed only the first pid it found in the log. Every run where the
 *     fallback fired left one window behind, silently.
 *
 * So the fixture is a window with no document, a title that says what it is, and
 * a position off-screen: it satisfies `IsWindowVisible` — which is what the
 * probe actually measures — without appearing in front of whoever is using the
 * machine. It is also an executable built into the test's own temp directory,
 * which makes "is anything of mine still running?" answerable by path instead of
 * by hoping.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deliberately not ASCII: this title crosses Windows PowerShell's console
 * encoding on its way to Node, so a title that survives the round trip is what
 * proves the window named in the helper's log is readable.
 */
export const PROBE_WINDOW_TITLE = 'dsh-restart-button 探针窗口';

const CSC_CANDIDATES = [
	join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
	join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];

const SOURCE = `using System;
using System.Windows.Forms;

public class DshProbeWindow : Form {
    [STAThread]
    public static void Main() {
        var form = new DshProbeWindow();
        form.Text = ${JSON.stringify(PROBE_WINDOW_TITLE)};
        form.Width = 320;
        form.Height = 200;
        form.StartPosition = FormStartPosition.Manual;
        // Off-screen on purpose: the probe measures IsWindowVisible, and a window
        // nobody has to look at is a window nobody has to close.
        form.Left = -4000;
        form.Top = -4000;
        form.Show();
        Application.Run();
    }
}
`;

const POWERSHELL = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Whether this machine can build the fixture at all. */
export function hasCompiler() {
	return process.platform === 'win32' && CSC_CANDIDATES.some((candidate) => existsSync(candidate));
}

/** Compile the fixture into `directory`, or return null when no compiler exists. */
export function buildProbeWindow(directory) {
	const exe = join(directory, 'dsh-probe-window.exe');
	if (existsSync(exe)) return exe;
	const compiler = CSC_CANDIDATES.find((candidate) => existsSync(candidate));
	if (compiler === undefined) return null;
	const source = join(directory, 'dsh-probe-window.cs');
	writeFileSync(source, SOURCE, 'utf8');
	const built = spawnSync(
		compiler,
		['/nologo', '/target:winexe', `/out:${exe}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', source],
		{ encoding: 'utf8', windowsHide: true }
	);
	if (!existsSync(exe)) {
		throw new Error(`the probe window could not be built: ${built.stdout ?? ''} ${built.stderr ?? ''}`);
	}
	return exe;
}

/** Start the fixture window and hand back the child. */
export function startProbeWindow(exe) {
	return spawn(exe, [], { stdio: 'ignore', windowsHide: false });
}

/** Every pid whose executable lives inside `directory` — this fixture, nothing else. */
export function processesFrom(directory) {
	if (process.platform !== 'win32') return [];
	const pattern = join(directory, '*');
	const listed = spawnSync(
		POWERSHELL,
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${pattern}' } | Select-Object -ExpandProperty ProcessId`
		],
		{ encoding: 'utf8', windowsHide: true, timeout: 30_000 }
	);
	return String(listed.stdout ?? '')
		.split(/\r?\n/u)
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Kill a whole process tree, tolerating processes that already exited. */
export function killTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		return;
	}
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* already gone */
	}
}

/** Every pid a helper log says it started — not just the first one. */
export function launchedPids(log) {
	const pids = [];
	for (const match of log.matchAll(/started the replacement \(pid (\d+)\)/gu)) pids.push(Number(match[1]));
	for (const match of log.matchAll(/"pid":(\d+)/gu)) pids.push(Number(match[1]));
	return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fail loudly if anything this suite started is still running.
 *
 * This is the guard that turns "a leak nobody noticed" into a red test. It is
 * checked by executable path inside the test's own temp directory, so it cannot
 * mistake an application the user is running for test litter.
 */
export async function assertNothingLeftRunning(directory, label) {
	const deadline = Date.now() + 10_000;
	let left = processesFrom(directory);
	while (left.length > 0 && Date.now() < deadline) {
		await sleep(250);
		left = processesFrom(directory);
	}
	if (left.length > 0) {
		for (const pid of left) killTree(pid);
		throw new Error(`${label}: ${left.length} test process(es) survived cleanup (pids ${left.join(', ')})`);
	}
}
