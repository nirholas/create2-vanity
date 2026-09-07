/**
 * API tests drive the Fetch handler directly. It is the same function the Node
 * server and the Cloudflare Worker both call, so these cover both hosts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../server/app.mjs';
import { create2Address } from '../src/create2.js';

const BASE = 'https://c2.test';
const ARACHNID = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const HASH = '0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f';
const SALT = '0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5';

/**
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function call(path, body) {
	const req = body === undefined
		? new Request(`${BASE}${path}`)
		: new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const res = await handle(req, {});
	assert.ok(res, `no route matched ${path}`);
	return { status: res.status, json: await res.json() };
}

test('health reports the issuer and the EIP-712 constants', async () => {
	const { status, json } = await call('/api/health');
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.match(json.issuer.address, /^0x[0-9a-fA-F]{40}$/);
	assert.match(json.eip712.typeHash, /^0x[0-9a-f]{64}$/);
	assert.equal(json.attestationProtocol, 'create2-vanity-attestation/v1');
});

test('derive reproduces a live address, and rejects malformed inputs', async () => {
	const ok = await call('/api/derive', { deployer: ARACHNID, salt: SALT, initCodeHash: HASH });
	assert.equal(ok.status, 200);
	assert.equal(ok.json.addressChecksum, '0x00000000D49195AE81759cd247cFeDD9D0B479df');

	assert.equal((await call('/api/derive', { deployer: 'nope', salt: SALT, initCodeHash: HASH })).status, 400);
	assert.equal((await call('/api/derive', { deployer: ARACHNID, salt: '0x00', initCodeHash: HASH })).status, 400);
	assert.equal((await call('/api/derive', { deployer: ARACHNID, initCodeHash: HASH })).status, 400);
});

test('derive also does plain CREATE', async () => {
	const { status, json } = await call('/api/derive', { sender: '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', nonce: 1 });
	assert.equal(status, 200);
	assert.equal(json.scheme, 'create');
	assert.equal(json.address, '0x343c43A37D37dfF08AE8C4A11544c718AbB4fCF8');
	assert.equal((await call('/api/derive', { sender: '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', nonce: -1 })).status, 400);
});

test('derive accepts raw init code and hashes it', async () => {
	const { json } = await call('/api/derive', { deployer: ARACHNID, salt: SALT, initCode: '0x6080' });
	assert.equal(json.address, create2Address(ARACHNID, SALT, json.initCodeHash));
	// The calldata is exactly what the Arachnid proxy expects.
	assert.equal(json.calldata, `${SALT}6080`);
});

test('quote reports the case multiplier', async () => {
	const plain = await call('/api/quote', { prefix: 'beef' });
	const cased = await call('/api/quote', { prefix: 'Beef' });
	assert.equal(plain.json.difficulty.caseSensitivityCost, 1);
	assert.equal(cased.json.difficulty.caseSensitivityCost, 16, 'four case-carrying letters: B, e, e, f');
	assert.ok(cased.json.difficulty.p99 > cased.json.difficulty.p50);
});

test('grind returns a salt the caller can check, and is enabled by default', async () => {
	const { status, json } = await call('/api/grind', { deployer: ARACHNID, initCodeHash: HASH, prefix: 'ab', timeBudgetMs: 8000 });
	assert.equal(status, 200);
	assert.equal(json.found, true);
	// The whole point: the caller verifies rather than trusting.
	assert.equal(create2Address(ARACHNID, json.salt, HASH), json.address);
	assert.ok(json.address.startsWith('0xab'));
});

test('grind rejects a missing init code instead of grinding nonsense', async () => {
	assert.equal((await call('/api/grind', { deployer: ARACHNID, prefix: 'ab' })).status, 400);
	assert.equal((await call('/api/grind', { initCodeHash: HASH, prefix: 'ab', deployer: 'x' })).status, 400);
});

test('attest then verify round-trips, and a tampered salt fails the derivation check', async () => {
	const issued = await call('/api/attest', { deployer: ARACHNID, salt: SALT, initCodeHash: HASH, prefix: '00000000', attempts: 4_294_967_296 });
	assert.equal(issued.status, 200);
	assert.equal(issued.json.attestation.account, '0x00000000D49195AE81759cd247cFeDD9D0B479df');

	const ok = await call('/api/verify', { attestation: issued.json.attestation });
	assert.equal(ok.json.valid, true, JSON.stringify(ok.json.checks.filter((c) => !c.pass)));

	const tampered = {
		...issued.json.attestation,
		deployment: { ...issued.json.attestation.deployment, salt: `0x${'11'.repeat(32)}` },
	};
	const bad = await call('/api/verify', { attestation: tampered });
	assert.equal(bad.json.valid, false);
	assert.equal(bad.json.checks.find((c) => c.id === 'derivation').pass, false);
});

test('attest refuses to describe an address that does not match the pattern', async () => {
	const { status, json } = await call('/api/attest', { deployer: ARACHNID, salt: SALT, initCodeHash: HASH, prefix: 'ffffffff' });
	assert.equal(status, 400);
	assert.match(json.error, /does not match/);
});

test('the chain registry includes Robinhood Chain', async () => {
	const { json } = await call('/api/chains');
	const ids = json.chains.map((c) => c.id);
	for (const id of [1, 8453, 42161, 4663]) assert.ok(ids.includes(id), `chain ${id} missing`);
	assert.equal(json.factories.length, 4);
});

test('availability rejects a malformed address before touching the network', async () => {
	assert.equal((await call('/api/availability', { address: 'nope' })).status, 400);
});

test('discovery documents are served and internally consistent', async () => {
	const card = await call('/.well-known/agents.json');
	assert.ok(card.json.skills.length >= 5);
	for (const skill of card.json.skills) assert.ok(skill.endpoint.url.startsWith(BASE));

	const wellKnown = await call('/.well-known/create2-vanity.json');
	assert.match(wellKnown.json.issuers[0].address, /^0x[0-9a-fA-F]{40}$/);
	assert.ok(wellKnown.json.eip712.type.startsWith('Create2Attestation('));

	const openapi = await call('/openapi.json');
	assert.equal(openapi.json.openapi, '3.1.0');
	assert.ok(openapi.json.paths['/api/availability']);

	const mcp = await call('/.well-known/mcp.json');
	assert.equal(mcp.json.tools.length, 6);
});

test('a random salt endpoint returns 32 bytes', async () => {
	const { json } = await call('/api/salt');
	assert.match(json.salt, /^0x[0-9a-f]{64}$/);
});

test('an unknown API path 404s as JSON, and a page path falls through', async () => {
	const missing = await handle(new Request(`${BASE}/api/nope`), {});
	assert.equal(missing.status, 404);
	assert.equal(await handle(new Request(`${BASE}/some/page.html`), {}), null);
});
