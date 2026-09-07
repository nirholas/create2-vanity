/**
 * The MCP tool list and shapes are a public contract, so they are driven here
 * over a real stdio transport, the way a host would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../mcp/index.js', import.meta.url));
const ARACHNID = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const HASH = '0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f';
const SALT = '0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5';

/**
 * @template T
 * @param {(client: Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withClient(fn) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
	const client = new Client({ name: 'create2-vanity-tests', version: '1.0.0' });
	await client.connect(transport);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

const payload = (result) => JSON.parse(result.content[0].text);

test('the server exposes exactly the documented tools', async () => {
	const names = await withClient(async (client) => (await client.listTools()).tools.map((t) => t.name).sort());
	assert.deepEqual(names, [
		'create2_availability',
		'create2_chains',
		'create2_derive',
		'create2_grind',
		'create2_quote',
		'create2_verify_attestation',
	]);
});

test('create2_derive reproduces a live address', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'create2_derive', arguments: { deployer: ARACHNID, salt: SALT, initCodeHash: HASH } }),
	));
	assert.equal(data.addressChecksum, '0x00000000D49195AE81759cd247cFeDD9D0B479df');
});

test('create2_grind returns a checkable salt', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'create2_grind', arguments: { initCodeHash: HASH, prefix: 'ab', timeBudgetMs: 20000 } }),
	));
	assert.match(data.salt, /^0x[0-9a-f]{64}$/);
	assert.ok(data.address.startsWith('0xab'));
	// The default deployer is the Arachnid proxy, so the address is re-derivable
	// from the response alone.
	assert.equal(data.deployer, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});

test('create2_chains includes Robinhood Chain', async () => {
	const data = await withClient(async (client) => payload(await client.callTool({ name: 'create2_chains', arguments: {} })));
	assert.ok(data.chains.some((c) => c.id === 4663));
	assert.equal(data.factories.length, 4);
});

test('a bad pattern comes back as a tool error, not a crash', async () => {
	const result = await withClient(async (client) => client.callTool({ name: 'create2_quote', arguments: { prefix: 'zzzz' } }));
	assert.equal(result.isError, true);
	assert.match(payload(result).error, /invalid prefix/);
});
