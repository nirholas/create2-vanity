/**
 * CREATE2 grind attestations, signed as EIP-712 typed data:
 * `create2-vanity-attestation/v1`.
 *
 * ── Why this one is unusually strong ─────────────────────────────────────────
 * An attestation about a *wallet* can only ever be a claim: nobody outside can
 * check that the issuer did not keep a copy of the key. A CREATE2 address has no
 * key at all, and its derivation is public:
 *
 *     address = keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)[12:]
 *
 * so a verifier does not have to trust the issuer about the central fact. It
 * recomputes the address from the attested salt, and a lie fails in one keccak.
 * The signature adds provenance (who ground it, when, and how many attempts it
 * took), not authority.
 *
 * ── Why EIP-712 ──────────────────────────────────────────────────────────────
 * The interesting verifier here is on chain. A registry, a marketplace or a
 * factory wrapper recovers the signer with `ecrecover` and can gate on it, while
 * the same document verifies off chain in a browser with no RPC. The domain
 * carries no `chainId`: a CREATE2 address is the same on every chain that has
 * the deployer, and pinning one would make a true statement fail elsewhere.
 *
 * Pure @noble: no ethers, no RPC, identical in the browser, the API and tests.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { addressFromPoint, eip55Checksum, addressMatchesPattern } from './address.js';
import { create2Address, parseHex } from './create2.js';
import { expectedAttempts } from './difficulty.js';

export const ATTESTATION_PROTOCOL = 'create2-vanity-attestation/v1';

/** Certificates older than this are stale, but still structurally valid. */
export const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const DOMAIN_TYPE = 'EIP712Domain(string name,string version)';
const DOMAIN_NAME = 'Create2VanityAttestation';
const DOMAIN_VERSION = '1';

const ATTESTATION_TYPE =
	'Create2Attestation(' +
	'address account,' +
	'address deployer,' +
	'bytes32 salt,' +
	'bytes32 initCodeHash,' +
	'string prefix,' +
	'string suffix,' +
	'bool caseSensitive,' +
	'uint256 expectedAttempts,' +
	'uint256 attempts,' +
	'bytes32 nonce,' +
	'uint256 issuedAt' +
	')';

const DOMAIN_SEPARATOR = keccak_256(concatBytes(
	keccak_256(utf8ToBytes(DOMAIN_TYPE)),
	keccak_256(utf8ToBytes(DOMAIN_NAME)),
	keccak_256(utf8ToBytes(DOMAIN_VERSION)),
));

/** The type hash a Solidity verifier must use. Exported so the two cannot drift. */
export const TYPE_HASH = `0x${bytesToHex(keccak_256(utf8ToBytes(ATTESTATION_TYPE)))}`;
export const DOMAIN_SEPARATOR_HEX = `0x${bytesToHex(DOMAIN_SEPARATOR)}`;
export { ATTESTATION_TYPE };

// ── encoding ─────────────────────────────────────────────────────────────────

/** @param {bigint|number} value @returns {Uint8Array} 32-byte big-endian word */
function word(value) {
	let v = BigInt(value);
	if (v < 0n) throw new RangeError('negative value in a uint256 field');
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0 && v > 0n; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** @param {string} hex @param {number} bytes @returns {Uint8Array} left-padded word */
function hexWord(hex, bytes) {
	const raw = parseHex(hex, 'field', bytes);
	const out = new Uint8Array(32);
	out.set(raw, 32 - bytes);
	return out;
}

/** @param {string} s @returns {Uint8Array} */
const stringWord = (s) => keccak_256(utf8ToBytes(String(s ?? '')));

/**
 * The EIP-712 digest a signer signs and `ecrecover` recovers against.
 * @param {object} core
 * @returns {Uint8Array} 32 bytes
 */
export function attestationDigest(core) {
	const structHash = keccak_256(concatBytes(
		keccak_256(utf8ToBytes(ATTESTATION_TYPE)),
		hexWord(core.account, 20),
		hexWord(core.deployment.deployer, 20),
		hexWord(core.deployment.salt, 32),
		hexWord(core.deployment.initCodeHash, 32),
		stringWord(core.pattern.prefix || ''),
		stringWord(core.pattern.suffix || ''),
		word(core.pattern.caseSensitive ? 1 : 0),
		word(BigInt(Math.round(core.difficulty.expectedAttempts))),
		word(BigInt(Math.round(core.attempts || 0))),
		hexWord(core.freshness.nonce, 32),
		word(BigInt(Math.floor(Date.parse(core.freshness.issuedAt) / 1000))),
	));
	return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

/** A fresh 32-byte freshness nonce. */
export function randomNonce() {
	const out = new Uint8Array(32);
	globalThis.crypto.getRandomValues(out);
	return `0x${bytesToHex(out)}`;
}

/**
 * Build the unsigned core of an attestation.
 *
 * Refuses to describe a deployment whose inputs do not derive the stated
 * address, or an address that does not match the claimed pattern. An
 * attestation that cannot verify is worse than none.
 *
 * @param {object} p
 * @param {string} p.deployer `0x…` 20 bytes
 * @param {string} p.salt `0x…` 32 bytes
 * @param {string} p.initCodeHash `0x…` 32 bytes
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} p.pattern
 * @param {number} [p.attempts]
 * @param {string} [p.nonce]
 * @param {string} [p.issuedAt]
 * @returns {object}
 */
export function buildAttestation({ deployer, salt, initCodeHash, pattern, attempts, nonce, issuedAt }) {
	const account = create2Address(deployer, salt, initCodeHash);

	const pat = {
		prefix: String(pattern?.prefix || '').replace(/^0x/i, ''),
		suffix: String(pattern?.suffix || ''),
		caseSensitive: !!pattern?.caseSensitive,
	};
	if (!pat.prefix && !pat.suffix) throw new Error('an attestation needs a prefix, a suffix, or both');
	if (!addressMatchesPattern(account, pat)) {
		throw new Error('the derived address does not match the claimed pattern');
	}

	return {
		protocol: ATTESTATION_PROTOCOL,
		account: eip55Checksum(account),
		deployment: {
			deployer: eip55Checksum(deployer),
			salt: `0x${bytesToHex(parseHex(salt, 'salt', 32))}`,
			initCodeHash: `0x${bytesToHex(parseHex(initCodeHash, 'initCodeHash', 32))}`,
			derivation: 'keccak256(0xff | deployer | salt | initCodeHash)[12:]',
		},
		pattern: pat,
		attempts: Number.isFinite(attempts) ? Math.round(attempts) : 0,
		difficulty: {
			expectedAttempts: Math.round(expectedAttempts(pat)),
			model: 'hex-uniform/v1',
		},
		freshness: {
			nonce: nonce || randomNonce(),
			issuedAt: issuedAt || new Date().toISOString(),
		},
	};
}

/**
 * Sign an attestation core with the issuer's secp256k1 key.
 *
 * The signature is 65 bytes, `r ‖ s ‖ v` with `v ∈ {27, 28}`: the layout
 * `ecrecover` expects, so the document verifies in Solidity unchanged.
 *
 * @param {{ core: object, signingKey: string|Uint8Array }} p
 * @returns {object}
 */
export function signAttestation({ core, signingKey }) {
	const key = typeof signingKey === 'string' ? hexToBytes(signingKey.replace(/^0x/, '')) : signingKey;
	if (key.length !== 32) throw new Error('signingKey must be 32 bytes');

	const digest = attestationDigest(core);
	// @noble returns `[recovery, r, s]`; Ethereum wants `[r, s, v]`.
	const recovered = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
	const ethSignature = concatBytes(recovered.subarray(1), new Uint8Array([27 + recovered[0]]));

	return {
		...core,
		digest: `0x${bytesToHex(digest)}`,
		signature: `0x${bytesToHex(ethSignature)}`,
		issuer: eip55Checksum(addressFromPoint(secp256k1.Point.fromBytes(secp256k1.getPublicKey(key, false)))),
		signatureScheme: 'eip712-ecdsa-secp256k1',
	};
}

/**
 * Recover the signer address from an attestation.
 * @param {object} attestation
 * @returns {string} `0x…` checksummed
 */
export function recoverIssuer(attestation) {
	const digest = attestationDigest(attestation);
	const sig = hexToBytes(String(attestation.signature || '').replace(/^0x/, ''));
	if (sig.length !== 65) throw new Error('signature must be 65 bytes (r, s, v)');
	const recovery = sig[64] - 27;
	if (recovery !== 0 && recovery !== 1) throw new Error('signature v must be 27 or 28');
	const publicKey = secp256k1.recoverPublicKey(
		concatBytes(new Uint8Array([recovery]), sig.subarray(0, 64)),
		digest,
		{ prehash: false, format: 'recovered' },
	);
	return eip55Checksum(addressFromPoint(secp256k1.Point.fromBytes(publicKey)));
}

/**
 * Verify an attestation end to end, recomputing every claim.
 *
 * The derivation check is the important one and needs no signature at all: it
 * re-runs CREATE2 over the attested inputs. A verifier that only checked the
 * signature would be trusting the issuer about something it can compute itself.
 *
 * @param {object} attestation
 * @param {object} [opts]
 * @param {string[]} [opts.issuers] addresses allowed to have signed it
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.freshnessWindowMs]
 * @returns {{ valid: boolean, checks: Array<{id:string,label:string,pass:boolean,detail:string}>, account: string, issuer: string }}
 */
export function verifyAttestation(attestation, opts = {}) {
	const checks = [];
	const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();

	if (!attestation || typeof attestation !== 'object') {
		add('shape', 'Attestation is well-formed', false, 'attestation is missing or not an object');
		return { valid: false, checks, account: '', issuer: '' };
	}
	if (attestation.protocol !== ATTESTATION_PROTOCOL) {
		add('protocol', 'Protocol version is supported', false, `document is "${attestation.protocol}", expected "${ATTESTATION_PROTOCOL}"`);
		return { valid: false, checks, account: attestation.account || '', issuer: '' };
	}
	add('protocol', 'Protocol version is supported', true, ATTESTATION_PROTOCOL);

	// 1. The derivation. This is the check that makes the document worth having,
	//    and it needs nothing from the issuer.
	{
		let ok = false;
		let detail = '';
		try {
			const derived = create2Address(
				attestation.deployment?.deployer,
				attestation.deployment?.salt,
				attestation.deployment?.initCodeHash,
			);
			ok = derived.toLowerCase() === String(attestation.account || '').toLowerCase();
			detail = ok
				? `keccak256(0xff | ${attestation.deployment.deployer} | salt | initCodeHash)[12:] = ${attestation.account}`
				: `the attested inputs derive ${derived}, not ${attestation.account}`;
		} catch (err) {
			detail = err.message;
		}
		add('derivation', 'The salt really produces this address', ok, detail);
	}

	// 2. Checksum casing of the account.
	{
		const raw = String(attestation.account || '');
		const wellFormed = /^0x[0-9a-fA-F]{40}$/.test(raw);
		add('account', 'Account is a valid EVM address', wellFormed && eip55Checksum(raw) === raw,
			wellFormed ? raw : 'not a 20-byte 0x-prefixed hex address');
	}

	// 3. The address matches the pattern it claims.
	{
		const ok = addressMatchesPattern(attestation.account, attestation.pattern || {});
		const p = attestation.pattern || {};
		add('pattern', 'Address matches the attested pattern', ok,
			ok ? `matches ${p.prefix ? `prefix "${p.prefix}"` : ''}${p.prefix && p.suffix ? ' and ' : ''}${p.suffix ? `suffix "${p.suffix}"` : ''}${p.caseSensitive ? ' (EIP-55 case-sensitive)' : ''}`
			   : 'the address does not satisfy the pattern in the document');
	}

	// 4. The difficulty claim is what the named model produces.
	{
		let expected = NaN;
		try {
			expected = Math.round(expectedAttempts(attestation.pattern || {}));
		} catch { /* handled below */ }
		const claimed = Number(attestation.difficulty?.expectedAttempts);
		const ok = Number.isFinite(expected) && claimed === expected;
		add('difficulty', 'Difficulty claim is honest', ok,
			ok ? `expectedAttempts = ${expected.toLocaleString('en-US')} under ${attestation.difficulty?.model}`
			   : `document claims ${claimed}, the model gives ${expected}`);
	}

	// 5. Freshness.
	{
		const issued = Date.parse(attestation.freshness?.issuedAt || '');
		const nonceOk = /^0x[0-9a-fA-F]{64}$/.test(attestation.freshness?.nonce || '');
		let ok = Number.isFinite(issued) && nonceOk && issued <= now + DEFAULT_FUTURE_SKEW_MS;
		let detail = ok ? `issued ${attestation.freshness.issuedAt}` : 'missing, malformed, or future-dated issue time';
		if (ok && opts.freshnessWindowMs && now - issued > opts.freshnessWindowMs) {
			ok = false;
			detail = `issued ${Math.round((now - issued) / 86400000)} days ago, outside the requested freshness window`;
		}
		add('freshness', 'Freshness nonce and timestamp are sane', ok, detail);
	}

	// 6. The signature covers exactly these facts.
	let issuer = '';
	{
		let ok = false;
		let detail = '';
		try {
			issuer = recoverIssuer(attestation);
			ok = !!issuer;
			detail = ok ? `EIP-712 signature recovers to ${issuer}` : 'signature did not recover a signer';
			if (ok && attestation.issuer && attestation.issuer.toLowerCase() !== issuer.toLowerCase()) {
				ok = false;
				detail = `document names ${attestation.issuer} but the signature recovers to ${issuer}`;
			}
		} catch (err) {
			detail = err.message;
		}
		add('signature', 'EIP-712 signature is valid', ok, detail);
	}

	// 7. The signer is one this verifier accepts.
	{
		if (opts.issuers?.length) {
			const allowed = opts.issuers.map((a) => String(a).toLowerCase());
			const ok = !!issuer && allowed.includes(issuer.toLowerCase());
			add('issuerPinned', 'Signed by a published issuer key', ok,
				ok ? `${issuer} is in the published issuer list`
				   : `${issuer || 'unknown signer'} is not in the published issuer list, so this could be self-signed`);
		} else {
			add('issuerPinned', 'Signed by a published issuer key', false,
				'no issuer list supplied: fetch /.well-known/create2-vanity.json to pin the issuer. The derivation check above still holds regardless, because it needs no issuer.');
		}
	}

	return { valid: checks.every((c) => c.pass), checks, account: attestation.account || '', issuer };
}
