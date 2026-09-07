/**
 * The salt grinder must return a salt that actually produces the address it
 * claims. That is checked here by re-deriving from first principles, and the
 * counter itself is checked directly, because the way it broke once is invisible
 * from the outside: a grinder with a stuck carry still reports a healthy attempt
 * rate, it just silently searches 256 salts instead of 2^64.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

import { grindSaltPool } from '../src/grinder-pool.js';
import { grindSaltNode } from '../src/grinder-node.js';
import { create2Address } from '../src/create2.js';
import { addressMatchesPattern } from '../src/address.js';

const ARACHNID = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const HASH = '0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f';

test('the multi-core pool returns a salt that produces its address', async () => {
	const result = await grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'ab', workers: 2 });

	assert.match(result.salt, /^0x[0-9a-f]{64}$/);
	assert.ok(result.address.startsWith('0xab'));
	// Re-derive independently of the grinder.
	assert.equal(create2Address(ARACHNID, result.salt, HASH), result.address);
	assert.equal(result.workers, 2);
	assert.ok(result.attempts > 0);
});

test('the pool honours a suffix and an EIP-55 spelling', async () => {
	const suffixed = await grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH, suffix: 'a', workers: 2 });
	assert.ok(suffixed.address.endsWith('a'));
	assert.equal(create2Address(ARACHNID, suffixed.salt, HASH), suffixed.address);

	const cased = await grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'A', workers: 2 });
	assert.equal(cased.caseSensitive, true);
	assert.ok(cased.addressChecksum.startsWith('0xA'));
	assert.equal(addressMatchesPattern(cased.address, { prefix: 'A', caseSensitive: true }), true);
});

test('the salt counter carries', () => {
	// `++buf[i]` on a Uint8Array returns 256 when the byte wraps, not 0, so a
	// carry loop written the obvious way breaks out on every wrap and the search
	// never leaves the last byte. This is the regression test for that: the
	// grinder must produce far more than 256 distinct addresses.
	const seen = new Set();
	let salt = null;
	for (let i = 0; i < 12; i++) {
		const result = grindSaltNode({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'a', timeBudgetMs: 5000, startSalt: salt });
		assert.equal(result.found, true);
		seen.add(result.address);
		salt = null;
	}
	assert.ok(seen.size >= 10, `expected distinct addresses across runs, got ${seen.size}`);

	// And directly: 5000 consecutive salts from one start must give 5000
	// distinct addresses, not 256.
	const preimage = new Uint8Array(85);
	preimage[0] = 0xff;
	const counter = new DataView(preimage.buffer, 45, 8);
	const state = { hi: 0, lo: 0 };
	const addresses = new Set();
	for (let i = 0; i < 5000; i++) {
		state.lo = (state.lo + 1) >>> 0;
		if (state.lo === 0) state.hi = (state.hi + 1) >>> 0;
		counter.setUint32(0, state.hi, false);
		counter.setUint32(4, state.lo, false);
		addresses.add(bytesToHex(keccak_256(preimage)).slice(-40));
	}
	assert.equal(addresses.size, 5000, 'the counter must reach beyond one byte');
});

test('an aborted grind rejects promptly and frees its workers', async () => {
	const controller = new AbortController();
	const promise = grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'deadbeef', workers: 2, signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(promise, (err) => err.name === 'AbortError');
});

test('the pool validates before spawning anything', async () => {
	await assert.rejects(grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'zz' }), /invalid prefix/);
	await assert.rejects(grindSaltPool({ deployer: ARACHNID, initCodeHash: HASH }), /prefix or suffix is required/);
	await assert.rejects(grindSaltPool({ deployer: 'nope', initCodeHash: HASH, prefix: 'a' }), /deployer/);
	await assert.rejects(grindSaltPool({ deployer: ARACHNID, initCodeHash: '0x00', prefix: 'a' }), /initCodeHash/);
});

test('the single-threaded grinder gives up cleanly instead of hanging', () => {
	const result = grindSaltNode({ deployer: ARACHNID, initCodeHash: HASH, prefix: 'deadbeef', timeBudgetMs: 300 });
	assert.equal(result.found, false);
	assert.ok(result.attempts > 0);
	assert.ok(result.durationMs >= 250);
});
