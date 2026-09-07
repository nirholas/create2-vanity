/**
 * Deterministic contract addresses: CREATE2, CREATE, and the init code that
 * feeds them.
 *
 * CREATE2 (EIP-1014) fixes the deployer and the init code and leaves the salt
 * free, so an address is a pure function you can search:
 *
 *     address = keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))[12:]
 *
 * No private key exists anywhere in that expression. Grinding a CREATE2 address
 * is therefore a completely different risk model from grinding a wallet: the
 * worst a hostile grinder can do is hand you a salt that does not work, which
 * one keccak proves. That is why this project has no key material at all, and
 * why every result it produces is independently re-derivable by anyone.
 *
 * The same determinism is what makes an address portable: the same deployer,
 * salt and init code produce the same address on every EVM chain where that
 * deployer exists.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { eip55Checksum } from './address.js';

/** `0x`-prefixed hex of arbitrary bytes. */
const hex = (bytes) => `0x${bytesToHex(bytes)}`;

/**
 * Parse `0x…` hex into bytes, with a useful error rather than a silent misparse.
 * @param {string} value
 * @param {string} label
 * @param {number} [expectedBytes]
 * @returns {Uint8Array}
 */
export function parseHex(value, label, expectedBytes) {
	const raw = String(value ?? '').trim().replace(/^0x/i, '');
	if (raw.length % 2) throw new Error(`${label} has an odd number of hex characters`);
	if (!/^[0-9a-fA-F]*$/.test(raw)) throw new Error(`${label} contains non-hex characters`);
	const bytes = hexToBytes(raw);
	if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
		throw new Error(`${label} must be ${expectedBytes} bytes, got ${bytes.length}`);
	}
	return bytes;
}

/**
 * keccak256 of raw init code: deploy bytecode with the ABI-encoded constructor
 * arguments appended. This is the value CREATE2 actually consumes, and getting
 * it wrong is the single most common way a predicted address turns out wrong.
 * @param {string|Uint8Array} initCode
 * @returns {string} `0x…` 32 bytes
 */
export function initCodeHash(initCode) {
	const bytes = initCode instanceof Uint8Array ? initCode : parseHex(initCode, 'initCode');
	if (bytes.length === 0) throw new Error('initCode is empty');
	return hex(keccak_256(bytes));
}

/**
 * The CREATE2 address for a deployer, salt and init-code hash (EIP-1014).
 * @param {string} deployer `0x…` 20 bytes
 * @param {string|Uint8Array} salt `0x…` 32 bytes
 * @param {string} initCodeHashHex `0x…` 32 bytes
 * @returns {string} lowercase `0x…` address
 */
export function create2Address(deployer, salt, initCodeHashHex) {
	const packed = new Uint8Array(85);
	packed[0] = 0xff;
	packed.set(parseHex(deployer, 'deployer', 20), 1);
	packed.set(salt instanceof Uint8Array ? salt : parseHex(salt, 'salt', 32), 21);
	packed.set(parseHex(initCodeHashHex, 'initCodeHash', 32), 53);
	return `0x${bytesToHex(keccak_256(packed)).slice(-40)}`;
}

/**
 * The plain CREATE address for a sender and nonce: `keccak256(rlp([sender, nonce]))[12:]`.
 *
 * Included because "which address will my next deploy land on" is the same
 * question one step earlier, and because a CREATE3-style deployment resolves
 * through exactly this after its CREATE2 proxy.
 *
 * @param {string} sender `0x…` 20 bytes
 * @param {number|bigint} nonce
 * @returns {string} lowercase `0x…` address
 */
export function createAddress(sender, nonce) {
	const senderBytes = parseHex(sender, 'sender', 20);
	const n = BigInt(nonce);
	if (n < 0n) throw new Error('nonce must not be negative');

	// RLP of a 2-item list: [20-byte string, integer].
	const nonceBytes = rlpEncodeInteger(n);
	const payload = new Uint8Array(1 + 20 + nonceBytes.length);
	payload[0] = 0x80 + 20;
	payload.set(senderBytes, 1);
	payload.set(nonceBytes, 21);

	// The payload is always short (23 to 30 bytes), so the list header is one byte.
	const encoded = new Uint8Array(1 + payload.length);
	encoded[0] = 0xc0 + payload.length;
	encoded.set(payload, 1);

	return `0x${bytesToHex(keccak_256(encoded)).slice(-40)}`;
}

/**
 * RLP for a non-negative integer: empty string for 0, a single byte below 0x80,
 * otherwise a length-prefixed big-endian minimal encoding.
 * @param {bigint} value
 * @returns {Uint8Array}
 */
function rlpEncodeInteger(value) {
	if (value === 0n) return new Uint8Array([0x80]);
	if (value < 0x80n) return new Uint8Array([Number(value)]);
	const bytes = [];
	let v = value;
	while (v > 0n) {
		bytes.unshift(Number(v & 0xffn));
		v >>= 8n;
	}
	return new Uint8Array([0x80 + bytes.length, ...bytes]);
}

/**
 * Calldata for the Arachnid deterministic-deployment-proxy: `salt ‖ initCode`,
 * sent to the proxy with no function selector.
 *
 * The proxy is the simplest deployer to actually use, which is why it is the
 * default here: any wallet can send this transaction, no ABI required.
 *
 * @param {string|Uint8Array} salt 32 bytes
 * @param {string|Uint8Array} initCode
 * @returns {string} `0x…` calldata
 */
export function arachnidDeployCalldata(salt, initCode) {
	const saltBytes = salt instanceof Uint8Array ? salt : parseHex(salt, 'salt', 32);
	const codeBytes = initCode instanceof Uint8Array ? initCode : parseHex(initCode, 'initCode');
	const out = new Uint8Array(32 + codeBytes.length);
	out.set(saltBytes, 0);
	out.set(codeBytes, 32);
	return hex(out);
}

/**
 * Everything about a ground salt, in one object: the address in both renderings,
 * the inputs that produce it, and the calldata that deploys it.
 * @param {{ deployer: string, salt: string, initCodeHash: string, initCode?: string }} input
 * @returns {{ address: string, addressChecksum: string, deployer: string, salt: string, initCodeHash: string, calldata: string|null }}
 */
export function describeDeployment({ deployer, salt, initCodeHash: hashHex, initCode }) {
	const address = create2Address(deployer, salt, hashHex);
	return {
		address,
		addressChecksum: eip55Checksum(address),
		deployer: eip55Checksum(deployer),
		salt: hex(salt instanceof Uint8Array ? salt : parseHex(salt, 'salt', 32)),
		initCodeHash: hex(parseHex(hashHex, 'initCodeHash', 32)),
		calldata: initCode ? arachnidDeployCalldata(salt, initCode) : null,
	};
}

/**
 * Pull deploy bytecode out of a compiler artifact.
 *
 * Foundry writes `{ bytecode: { object } }`, Hardhat writes `{ bytecode }` as a
 * string, and both also appear wrapped in `{ data: { bytecode: { object } } }`
 * from solc directly. Handling all three is the difference between a tool people
 * can use and one that makes them read a JSON file by hand.
 *
 * @param {any} artifact parsed JSON
 * @returns {{ bytecode: string, contractName: string|null, abi: any[]|null }}
 */
export function readArtifact(artifact) {
	if (!artifact || typeof artifact !== 'object') throw new Error('artifact must be a JSON object');

	const candidates = [
		artifact.bytecode?.object,
		typeof artifact.bytecode === 'string' ? artifact.bytecode : undefined,
		artifact.data?.bytecode?.object,
		artifact.evm?.bytecode?.object,
	].filter((c) => typeof c === 'string');

	if (candidates.length === 0) {
		throw new Error('no deploy bytecode found: expected bytecode.object (Foundry), bytecode (Hardhat), or evm.bytecode.object (solc)');
	}

	// A present-but-empty field is a different problem from a missing one, and
	// says something useful: the artifact is an interface, an abstract contract,
	// or a library that was not compiled with bytecode output.
	const raw = candidates[0].trim();
	const body = raw.replace(/^0x/i, '');
	if (body.length === 0) {
		throw new Error('the artifact has empty deploy bytecode: is this an interface or an abstract contract?');
	}
	if (!/^[0-9a-fA-F]+$/.test(body) || body.length % 2) {
		throw new Error('the artifact’s bytecode is not valid hex');
	}
	const normalized = `0x${body}`;

	return {
		bytecode: normalized,
		contractName: artifact.contractName ?? artifact.metadata?.settings?.compilationTarget
			? Object.values(artifact.metadata?.settings?.compilationTarget ?? {})[0] ?? artifact.contractName ?? null
			: null,
		abi: Array.isArray(artifact.abi) ? artifact.abi : null,
	};
}

/**
 * The constructor inputs an artifact's ABI declares, so a caller knows what
 * arguments have to be encoded and appended before the init code is complete.
 * @param {any[]|null} abi
 * @returns {Array<{ name: string, type: string }>}
 */
export function constructorInputs(abi) {
	if (!Array.isArray(abi)) return [];
	const ctor = abi.find((entry) => entry?.type === 'constructor');
	return (ctor?.inputs ?? []).map((input) => ({ name: input.name || '', type: input.type }));
}

/** A fresh random 32-byte salt, for a deployment that needs no vanity at all. */
export function randomSalt() {
	const out = new Uint8Array(32);
	globalThis.crypto.getRandomValues(out);
	return hex(out);
}
