/**
 * A CREATE2 attestation's central claim is re-derivable, so these tests care
 * most about the derivation check catching a lie, with the signature layer
 * tested for tamper-evidence and issuer pinning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
	buildAttestation, signAttestation, verifyAttestation, recoverIssuer,
	attestationDigest, TYPE_HASH, DOMAIN_SEPARATOR_HEX, ATTESTATION_TYPE,
} from '../src/attestation.js';
import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';

const ARACHNID = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const HASH = '0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f';
const SALT = '0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5';

const key = secp256k1.utils.randomSecretKey();
const issuer = eip55Checksum(addressFromPrivateKey(key));

/** @returns {object} a signed attestation over the live factory deployment */
function signed(overrides = {}) {
	const core = buildAttestation({
		deployer: ARACHNID,
		salt: SALT,
		initCodeHash: HASH,
		pattern: { prefix: '00000000' },
		attempts: 4_294_967_296,
		...overrides,
	});
	return signAttestation({ core, signingKey: key });
}

test('an attestation round-trips and recovers its signer', () => {
	const doc = signed();
	assert.equal(doc.account, '0x00000000D49195AE81759cd247cFeDD9D0B479df');
	assert.equal(doc.issuer, issuer);
	assert.equal(recoverIssuer(doc), issuer);
	assert.match(doc.signature, /^0x[0-9a-f]{130}$/);
	const v = parseInt(doc.signature.slice(-2), 16);
	assert.ok(v === 27 || v === 28, `v was ${v}`);

	const result = verifyAttestation(doc, { issuers: [issuer] });
	assert.equal(result.valid, true, JSON.stringify(result.checks.filter((c) => !c.pass)));
	assert.equal(result.checks.find((c) => c.id === 'derivation').pass, true);
});

test('the EIP-712 constants are stable', () => {
	// A Solidity verifier hardcodes these; changing them silently breaks every
	// deployed verifier, so they are pinned.
	assert.equal(ATTESTATION_TYPE, 'Create2Attestation(address account,address deployer,bytes32 salt,bytes32 initCodeHash,string prefix,string suffix,bool caseSensitive,uint256 expectedAttempts,uint256 attempts,bytes32 nonce,uint256 issuedAt)');
	assert.match(TYPE_HASH, /^0x[0-9a-f]{64}$/);
	assert.match(DOMAIN_SEPARATOR_HEX, /^0x[0-9a-f]{64}$/);
});

test('the derivation check catches a swapped salt, deployer or init code', () => {
	const doc = signed();
	for (const [label, mutate] of [
		['salt', (a) => ({ ...a, deployment: { ...a.deployment, salt: `0x${'11'.repeat(32)}` } })],
		['deployer', (a) => ({ ...a, deployment: { ...a.deployment, deployer: eip55Checksum(`0x${'22'.repeat(20)}`) } })],
		['initCodeHash', (a) => ({ ...a, deployment: { ...a.deployment, initCodeHash: `0x${'33'.repeat(32)}` } })],
	]) {
		const result = verifyAttestation(mutate(doc), { issuers: [issuer] });
		assert.equal(result.valid, false, `${label} tampering was not caught`);
		assert.equal(result.checks.find((c) => c.id === 'derivation').pass, false, `${label} did not fail the derivation check`);
	}
});

test('the derivation check needs no issuer at all', () => {
	const doc = signed();
	// Verify with no issuer list: the signature pin fails, but the derivation
	// still passes, which is the property that makes this document useful even
	// from an unknown source.
	const result = verifyAttestation(doc);
	assert.equal(result.checks.find((c) => c.id === 'derivation').pass, true);
	assert.equal(result.checks.find((c) => c.id === 'issuerPinned').pass, false);
	assert.equal(result.valid, false);
});

test('the digest changes when any attested field changes', () => {
	const core = buildAttestation({ deployer: ARACHNID, salt: SALT, initCodeHash: HASH, pattern: { prefix: '00000000' }, attempts: 10 });
	const digest = attestationDigest(core);
	for (const mutate of [
		(a) => ({ ...a, attempts: 11 }),
		(a) => ({ ...a, pattern: { ...a.pattern, caseSensitive: true } }),
		(a) => ({ ...a, difficulty: { ...a.difficulty, expectedAttempts: 1 } }),
		(a) => ({ ...a, freshness: { ...a.freshness, nonce: `0x${'11'.repeat(32)}` } }),
		(a) => ({ ...a, deployment: { ...a.deployment, salt: `0x${'11'.repeat(32)}` } }),
	]) {
		assert.notDeepEqual(attestationDigest(mutate(core)), digest);
	}
});

test('an attestation cannot claim a pattern the derived address does not have', () => {
	assert.throws(() => buildAttestation({ deployer: ARACHNID, salt: SALT, initCodeHash: HASH, pattern: { prefix: 'ffffffff' } }), /does not match/);
	assert.throws(() => buildAttestation({ deployer: ARACHNID, salt: SALT, initCodeHash: HASH, pattern: {} }), /prefix, a suffix, or both/);
});

test('a signer who is not on the list fails, even with a real signature', () => {
	const doc = signed();
	const result = verifyAttestation(doc, { issuers: [eip55Checksum(`0x${'44'.repeat(20)}`)] });
	assert.equal(result.valid, false);
	assert.equal(result.checks.find((c) => c.id === 'issuerPinned').pass, false);
	// The signature itself is still valid; only the pin failed.
	assert.equal(result.checks.find((c) => c.id === 'signature').pass, true);
});

test('a future-dated attestation fails freshness', () => {
	const doc = signed({ issuedAt: new Date(Date.now() + 86_400_000).toISOString() });
	const result = verifyAttestation(doc, { issuers: [issuer] });
	assert.equal(result.checks.find((c) => c.id === 'freshness').pass, false);
});
