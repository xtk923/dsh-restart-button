/**
 * The plugin mounted on a fake Cordis context.
 *
 * This is the test that proves the wiring — that `/restart` registers, that the
 * commands actually reach the restart path, that both diagnostic routes exist,
 * that the fence runs before the handler, and that a host which is *not* the
 * desktop host refuses with a reason instead of reaching for a process it does
 * not own. Nothing here spawns anything: under `node --test` this process has
 * no shell channel, so the restart path can only ever take its refusal branch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMAND, configSchema, install } from '../src/index.js';
import { NOW_PATH, REQUEST_HEADER, STATUS_PATH } from '../src/restart-plan.js';

/** A Cordis context with just the surface `install` touches. */
function mountHost(config, options = {}) {
	const routes = new Map();
	const webServer = options.brokenWebServer === true
		? { port: 19387 }
		: {
			port: 19387,
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		};
	const commands = {
		registered: [],
		register(definition) {
			this.registered.push(definition);
			return () => {
				const at = this.registered.indexOf(definition);
				if (at >= 0) this.registered.splice(at, 1);
			};
		}
	};
	const warnings = [];
	const makeContext = () => {
		const ctx = {
			logger: { info() {}, warn: (line) => warnings.push(String(line)) },
			get: (name) =>
				name === 'webServer' ? webServer : name === 'commands' ? commands : undefined,
			effect: (fn) => {
				fn();
				return () => {};
			}
		};
		ctx.inject = (deps, callback) => {
			if (!Array.isArray(deps)) return;
			if (deps.includes('webServer') && options.withoutWebServer !== true) callback({ ...ctx, webServer });
			if (deps.includes('commands') && options.withoutCommands !== true) callback({ ...ctx, commands });
		};
		return ctx;
	};
	const api = install(makeContext(), config);
	return { routes, api, warnings, commands };
}

/** Drive one route handler with a synthesized request. */
async function callRoute(routes, path, options = {}) {
	const route = routes.get(path);
	assert.ok(route !== undefined, `route ${path} should be registered`);
	const response = {
		status: 0,
		body: null,
		headers: null,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body) {
			this.body = JSON.parse(body);
		}
	};
	const request = {
		method: options.method ?? 'GET',
		headers: { host: '127.0.0.1:19387', ...(options.headers ?? {}) },
		socket: { remoteAddress: options.peer ?? '127.0.0.1' }
	};
	await route.handler(request, response);
	return response;
}

test('both routes are registered on the composition web server', () => {
	const { routes } = mountHost({});
	assert.deepEqual([...routes.keys()].sort(), [NOW_PATH, STATUS_PATH].sort());
	assert.equal(routes.get(STATUS_PATH).kind, 'exact');
	assert.equal(routes.get(NOW_PATH).kind, 'exact');
});

test('the status route answers with the capability, the port and the options', async () => {
	const { routes } = mountHost({ restartDelayMs: 900 });
	const answer = await callRoute(routes, STATUS_PATH);
	assert.equal(answer.status, 200);
	assert.equal(answer.body.ok, true);
	assert.equal(answer.body.version, 1);
	assert.equal(answer.body.host.port, 19387);
	assert.equal(answer.body.host.pid, process.pid);
	// A test process is not the desktop host, and the payload says so honestly.
	assert.equal(answer.body.supported, false);
	assert.equal(answer.body.reason, 'no-shell-channel');
	assert.equal(answer.body.shell, null);
	assert.equal(answer.body.busy.active, false);
	assert.equal(answer.body.options.restartDelayMs, 900);
	assert.equal(answer.body.options.raiseWindow, true);
	assert.match(answer.headers['content-type'], /application\/json/u);
	assert.equal(answer.headers['cache-control'], 'no-store');
});

test('/restart is registered with the composition command layer', () => {
	const { commands } = mountHost({});
	assert.equal(commands.registered.length, 1);
	const command = commands.registered[0];
	assert.equal(command.name, 'restart');
	assert.equal(command.name, COMMAND.name);
	assert.match(command.description, /重启 DSH/u);
	assert.equal(typeof command.handler, 'function');
	// No input descriptor: the command takes no arguments, and one that did would
	// advertise a hint the handler then refuses.
	assert.equal(command.input, undefined);
});

test('/restart refuses arguments with the usage line', async () => {
	const { commands } = mountHost({});
	const answer = await commands.registered[0].handler({ rawInput: '  now please  ', agent: { id: 's' }, attachments: [], signal: new AbortController().signal });
	assert.equal(answer.kind, 'error');
	assert.equal(answer.text, COMMAND.usage);
});

test('/restart on a host that is not the desktop says so instead of doing nothing', async () => {
	const { commands, api } = mountHost({});
	const answer = await commands.registered[0].handler({ rawInput: '', agent: { id: 's' }, attachments: [], signal: new AbortController().signal });
	assert.equal(answer.kind, 'error');
	// Both languages, because the reader is a person: the refusal has to be as
	// readable as the success message would have been.
	assert.match(answer.text, /重启没有开始/u);
	assert.match(answer.text, /no shell process|desktop/iu);
	assert.equal(api.state.restarting, false, 'a refused command must not arm anything');
});

test('a disabled plugin keeps its command and routes, and refuses with a reason', async () => {
	const { routes, commands } = mountHost({ enabled: false });
	const status = await callRoute(routes, STATUS_PATH);
	assert.equal(status.body.supported, false);
	assert.equal(status.body.reason, 'disabled');
	const now = await callRoute(routes, NOW_PATH, { method: 'POST', headers: { [REQUEST_HEADER]: '1' } });
	assert.equal(now.status, 409);
	assert.equal(now.body.ok, false);
	assert.equal(now.body.error, 'disabled');
	assert.equal(commands.registered.length, 1, 'the command stays visible and explains, rather than vanishing');
});

test('the restart route refuses anything that is not the desktop host', async () => {
	const { routes, api } = mountHost({});
	const answer = await callRoute(routes, NOW_PATH, { method: 'POST', headers: { [REQUEST_HEADER]: '1' } });
	// 409, not 500: "this host cannot restart itself" is an answer, not a fault.
	assert.equal(answer.status, 409);
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.error, 'no-shell-channel');
	assert.ok(answer.body.detail.length > 0);
	assert.equal(api.state.restarting, false);
});

test('the fence runs before the restart handler', async () => {
	const { routes } = mountHost({});
	assert.equal((await callRoute(routes, NOW_PATH, { method: 'GET' })).status, 405);
	assert.equal((await callRoute(routes, NOW_PATH, { method: 'POST' })).body.error, 'missing-request-header');
	assert.equal((await callRoute(routes, NOW_PATH, { method: 'POST', headers: { [REQUEST_HEADER]: '1' }, peer: '10.1.2.3' })).status, 403);
	assert.equal(
		(await callRoute(routes, STATUS_PATH, { peer: '::ffff:127.0.0.1' })).status,
		200,
		'the IPv6-mapped loopback form is still loopback'
	);
});

test('the published config schema names every accepted key', () => {
	const keys = Object.keys(configSchema.properties);
	for (const key of ['enabled', 'raiseWindow', 'restartDelayMs', 'logDir']) {
		assert.ok(keys.includes(key), `the schema should document ${key}`);
	}
	// The button's own knobs are gone with the button; a schema that still offered
	// them would be documenting three settings that do nothing.
	for (const gone of ['confirm', 'showLabel', 'hideWhenUnsupported', 'label']) {
		assert.ok(!keys.includes(gone), `the schema should no longer offer ${gone}`);
	}
	assert.equal(configSchema.additionalProperties, false);
});

test('a composition without a command layer still mounts, and says the command is absent', async () => {
	const { api, commands, routes } = mountHost({}, { withoutCommands: true });
	assert.equal(typeof api.arm, 'function');
	assert.equal(commands.registered.length, 0, 'there is no registry to register into');
	// A soft `inject` cannot warn about a service that never arrives — its
	// callback simply never runs — so the diagnostic payload is where "the
	// command is not live here" has to show up.
	const status = await callRoute(routes, STATUS_PATH);
	assert.equal(status.body.command.registered, false);
});

test('a composition without a web server still mounts, with the command and no routes', () => {
	const { api, routes, commands } = mountHost({}, { withoutWebServer: true });
	assert.equal(typeof api.arm, 'function');
	assert.equal(routes.size, 0, 'there is no carrier to register routes on');
	assert.equal(commands.registered.length, 1, 'the command is the feature; the routes are diagnostics');
});

test('a web server that cannot take routes is reported rather than assumed', () => {
	const { warnings, commands } = mountHost({}, { brokenWebServer: true });
	assert.equal(commands.registered.length, 1);
	assert.ok(warnings.some((line) => line.includes('diagnostic surface is unavailable')));
});
