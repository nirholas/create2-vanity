/**
 * The issuer key.
 *
 * Attestations are EIP-712 typed data signed with a secp256k1 key, so the
 * issuer is an ordinary EVM address that `ecrecover` returns. The address is
 * published at `/.well-known/create2-vanity.json`, and a verifier pins against
 * that list rather than trusting the address a pasted document names for itself.
 *
 * Note what this key is *not* for. A CREATE2 attestation's central claim (that
 * a salt produces an address) is re-derived by the verifier with one keccak, so
 * the signature adds provenance, never authority. Losing this key would cost
 * the service its identity and cost users nothing.
 *
 * Operators supply the private half in `ATTESTATION_KEY` (32 bytes, hex). With
 * none set the service mints an ephemeral key for the process and says so, in
 * the well-known document and in every response, so a fresh clone works end to
 * end without ever pretending an ephemeral key is a durable identity.
 *
 * Mint a durable one with `npm run keygen`.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';

/** @type {{ privateKey: Uint8Array, address: string, ephemeral: boolean } | null} */
let cached = null;

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ privateKey: Uint8Array, address: string, ephemeral: boolean }}
 */
export function issuerKey(env = {}) {
	if (cached) return cached;
	const raw = env.ATTESTATION_KEY || (typeof process !== 'undefined' ? process.env?.ATTESTATION_KEY : undefined);
	let privateKey;
	let ephemeral = false;
	if (raw) {
		const hex = String(raw).trim().replace(/^0x/, '');
		if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ATTESTATION_KEY must be 32 bytes of hex');
		privateKey = hexToBytes(hex);
		if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new Error('ATTESTATION_KEY is not a valid secp256k1 key');
	} else {
		privateKey = secp256k1.utils.randomSecretKey();
		ephemeral = true;
		console.warn(
			'[attestation] ATTESTATION_KEY is not set. Minting an ephemeral key for this process.\n' +
			'              Attestations will stop verifying when the process restarts.\n' +
			'              Run `npm run keygen` and set ATTESTATION_KEY for a durable identity.',
		);
	}
	cached = { privateKey, address: eip55Checksum(addressFromPrivateKey(privateKey)), ephemeral };
	return cached;
}

/**
 * The published issuer list. An array, because rotation means more than one
 * address can be valid at a time: publish the new one alongside the old until
 * every attestation signed by the old one has aged out.
 * @param {Record<string, string|undefined>} [env]
 */
export function publicIssuers(env = {}) {
	const key = issuerKey(env);
	return [{ address: key.address, ephemeral: key.ephemeral, algorithm: 'eip712-ecdsa-secp256k1' }];
}

/** Hex of the private key, for the keygen script only. */
export function privateKeyHex(key) {
	return `0x${bytesToHex(key.privateKey)}`;
}
