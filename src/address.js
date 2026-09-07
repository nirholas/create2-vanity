/**
 * EVM address derivation, checksums and pattern matching.
 *
 * One place that answers "what address is this?" and "does it match?", so the
 * browser grinder, the split-key verifier, the certificate verifier and the API
 * can never disagree about either.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const Point = secp256k1.Point;

/**
 * Address of a public point: keccak256 of the uncompressed key without its
 * 0x04 tag, last 20 bytes.
 * @param {InstanceType<typeof Point>} point
 * @returns {string} lowercase `0x…` address
 */
export function addressFromPoint(point) {
	const uncompressed = point.toBytes(false);
	return `0x${bytesToHex(keccak_256(uncompressed.subarray(1))).slice(-40)}`;
}

/**
 * Address of a private key.
 * @param {string|Uint8Array} privateKey 32 bytes, hex or bytes
 * @returns {string} lowercase `0x…` address
 */
export function addressFromPrivateKey(privateKey) {
	const bytes = typeof privateKey === 'string' ? hexToBytes(privateKey.replace(/^0x/, '')) : privateKey;
	return addressFromPoint(Point.fromBytes(secp256k1.getPublicKey(bytes, false)));
}

/**
 * The CREATE2 address for a deployer, salt and init-code hash (EIP-1014).
 * Included here because a vanity EOA and a vanity contract address are the same
 * hex space, and the tooling should not need two ideas of "address".
 * @param {string} deployer `0x…` 20 bytes
 * @param {string} salt `0x…` 32 bytes
 * @param {string} initCodeHash `0x…` 32 bytes
 * @returns {string} lowercase `0x…` address
 */
export function create2Address(deployer, salt, initCodeHash) {
	const packed = new Uint8Array(85);
	packed[0] = 0xff;
	packed.set(hexToBytes(deployer.replace(/^0x/, '')), 1);
	packed.set(hexToBytes(salt.replace(/^0x/, '')), 21);
	packed.set(hexToBytes(initCodeHash.replace(/^0x/, '')), 53);
	return `0x${bytesToHex(keccak_256(packed)).slice(-40)}`;
}

/**
 * EIP-55 checksum casing.
 * @param {string} address `0x…`, any casing
 * @returns {string} `0x…` with checksum casing
 */
export function eip55Checksum(address) {
	const body = address.replace(/^0x/, '').toLowerCase();
	const hash = bytesToHex(keccak_256(new TextEncoder().encode(body)));
	let out = '0x';
	for (let i = 0; i < body.length; i++) {
		out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
	}
	return out;
}

/**
 * Is this a well-formed address, and does its casing satisfy EIP-55?
 * An all-lowercase or all-uppercase address is valid but unchecksummed.
 * @param {string} address
 * @returns {{ valid: boolean, checksummed: boolean, reason: string }}
 */
export function inspectAddress(address) {
	const raw = String(address || '').trim();
	if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
		return { valid: false, checksummed: false, reason: 'not a 20-byte 0x-prefixed hex address' };
	}
	const body = raw.slice(2);
	if (body === body.toLowerCase() || body === body.toUpperCase()) {
		return { valid: true, checksummed: false, reason: 'valid, but not EIP-55 checksummed' };
	}
	const ok = eip55Checksum(raw) === raw;
	return {
		valid: ok,
		checksummed: ok,
		reason: ok ? 'valid EIP-55 checksum' : 'mixed case that fails the EIP-55 checksum: a typo, or not a real address',
	};
}

/**
 * Does an address satisfy a pattern?
 *
 * A case-sensitive pattern is compared against the EIP-55 checksummed rendering,
 * which is what makes `BeeF` mean something different from `beef`.
 *
 * @param {string} address `0x…`
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} [pattern]
 * @returns {boolean}
 */
export function addressMatchesPattern(address, { prefix = '', suffix = '', caseSensitive = false } = {}) {
	const raw = String(address || '');
	if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return false;

	const body = caseSensitive ? eip55Checksum(raw).slice(2) : raw.slice(2).toLowerCase();
	const pre = caseSensitive ? prefix.replace(/^0x/i, '') : prefix.replace(/^0x/i, '').toLowerCase();
	const suf = caseSensitive ? suffix : suffix.toLowerCase();

	if (pre && !body.startsWith(pre)) return false;
	if (suf && !body.endsWith(suf)) return false;
	return true;
}
