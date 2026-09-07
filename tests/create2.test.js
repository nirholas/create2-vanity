/**
 * The derivation is the whole product. If `create2Address` is wrong, every
 * address this project produces is wrong and nothing else matters, so it is
 * pinned against addresses that exist on chain today.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	create2Address, createAddress, initCodeHash, describeDeployment,
	arachnidDeployCalldata, readArtifact, constructorInputs, parseHex, randomSalt,
} from '../src/create2.js';
import { eip55Checksum } from '../src/address.js';

/** The Arachnid deterministic-deployment-proxy, live on every chain in the registry. */
const ARACHNID = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

test('CREATE2 reproduces an address that exists on chain', () => {
	// ThreeWSFactory, deployed on BSC, Base and Arbitrum through the Arachnid
	// proxy. Public inputs, public result: this vector can be checked against any
	// block explorer.
	const address = create2Address(
		ARACHNID,
		'0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5',
		'0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f',
	);
	assert.equal(address, '0x00000000d49195ae81759cd247cfedd9d0b479df');
	assert.equal(eip55Checksum(address), '0x00000000D49195AE81759cd247cFeDD9D0B479df');
});

test('CREATE reproduces the canonical nonce vectors', () => {
	const sender = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0';
	assert.equal(createAddress(sender, 0), '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
	assert.equal(createAddress(sender, 1), '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8');
	// Nonces above 0x7f take a length-prefixed RLP encoding; the boundary is the
	// part hand-rolled RLP usually gets wrong.
	assert.match(createAddress(sender, 127), /^0x[0-9a-f]{40}$/);
	assert.match(createAddress(sender, 128), /^0x[0-9a-f]{40}$/);
	assert.notEqual(createAddress(sender, 127), createAddress(sender, 128));
	assert.match(createAddress(sender, 1_000_000), /^0x[0-9a-f]{40}$/);
	assert.throws(() => createAddress(sender, -1), /negative/);
});

test('init-code hashing rejects malformed input instead of guessing', () => {
	assert.equal(initCodeHash('0x00').length, 66);
	assert.throws(() => initCodeHash('0x'), /empty/);
	assert.throws(() => initCodeHash('0x123'), /odd number/);
	assert.throws(() => initCodeHash('0xzz'), /non-hex/);
});

test('the deployment description carries everything needed to reproduce it', () => {
	const salt = randomSalt();
	const initCode = '0x60806040';
	const described = describeDeployment({ deployer: ARACHNID, salt, initCodeHash: initCodeHash(initCode), initCode });
	assert.equal(described.address, create2Address(ARACHNID, salt, initCodeHash(initCode)));
	assert.equal(described.addressChecksum, eip55Checksum(described.address));
	// Arachnid calldata is exactly salt followed by init code, no selector.
	assert.equal(described.calldata, `${salt}${initCode.slice(2)}`);
	assert.equal(arachnidDeployCalldata(salt, initCode), described.calldata);
});

test('parseHex reports the actual problem', () => {
	assert.throws(() => parseHex('0x1234', 'salt', 32), /must be 32 bytes, got 2/);
	assert.throws(() => parseHex('0xgg', 'salt'), /non-hex/);
	assert.equal(parseHex('0xff', 'x').length, 1);
	assert.equal(parseHex('ff', 'x').length, 1, 'the 0x prefix is optional');
});

test('artifacts from Foundry, Hardhat and solc all parse', () => {
	assert.equal(readArtifact({ bytecode: { object: '0x6080' } }).bytecode, '0x6080');
	assert.equal(readArtifact({ bytecode: '0x6080' }).bytecode, '0x6080');
	assert.equal(readArtifact({ evm: { bytecode: { object: '6080' } } }).bytecode, '0x6080', 'a missing 0x prefix is normalized');
	assert.throws(() => readArtifact({ abi: [] }), /no deploy bytecode/);
	assert.throws(() => readArtifact({ bytecode: { object: '0x' } }), /empty deploy bytecode/);
	assert.throws(() => readArtifact(null), /JSON object/);
});

test('constructor inputs are surfaced, because forgetting them breaks the address', () => {
	const abi = [
		{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }, { name: 'cap', type: 'uint256' }] },
		{ type: 'function', name: 'transfer', inputs: [] },
	];
	assert.deepEqual(constructorInputs(abi), [{ name: 'owner', type: 'address' }, { name: 'cap', type: 'uint256' }]);
	assert.deepEqual(constructorInputs([{ type: 'function', name: 'x' }]), []);
	assert.deepEqual(constructorInputs(null), []);
});

test('a different salt gives a different address, and the same salt does not', () => {
	const hash = initCodeHash('0x6080');
	const a = create2Address(ARACHNID, `0x${'11'.repeat(32)}`, hash);
	const b = create2Address(ARACHNID, `0x${'12'.repeat(32)}`, hash);
	assert.notEqual(a, b);
	assert.equal(a, create2Address(ARACHNID, `0x${'11'.repeat(32)}`, hash));
	// And a different init code moves the address even with the same salt, which
	// is why the constructor-argument warning exists.
	assert.notEqual(a, create2Address(ARACHNID, `0x${'11'.repeat(32)}`, initCodeHash('0x6081')));
});
