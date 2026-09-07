/**
 * worker_threads entry for the multi-core salt grinder.
 *
 * Each worker starts from its own random salt, so the pool never re-walks the
 * same stretch of the counter.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

import { parseHex } from './create2.js';
import { eip55Checksum, addressMatchesPattern } from './address.js';

const PROGRESS_INTERVAL = 8192;
const { deployer, initCodeHash, prefix, suffix, caseSensitive } = workerData;
const pattern = { prefix, suffix, caseSensitive };

const preimage = new Uint8Array(85);
preimage[0] = 0xff;
preimage.set(parseHex(deployer, 'deployer', 20), 1);
preimage.set(parseHex(initCodeHash, 'initCodeHash', 32), 53);

const salt = new Uint8Array(32);
crypto.getRandomValues(salt);
preimage.set(salt, 21);

// A DataView counter over the salt's last eight bytes. Not `++buf[i]` with a
// carry loop: `++` on a Uint8Array element returns 256 when the byte wraps, not
// 0, so the obvious carry loop breaks on every wrap and the search silently
// covers 256 salts instead of 2^64.
const counter = new DataView(preimage.buffer, preimage.byteOffset + 45, 8);
const counterState = { hi: counter.getUint32(0, false), lo: counter.getUint32(4, false) };

function bumpCounter() {
	counterState.lo = (counterState.lo + 1) >>> 0;
	if (counterState.lo === 0) counterState.hi = (counterState.hi + 1) >>> 0;
	counter.setUint32(0, counterState.hi, false);
	counter.setUint32(4, counterState.lo, false);
}

let attempts = 0;
for (;;) {
	bumpCounter();

	const address = `0x${bytesToHex(keccak_256(preimage)).slice(-40)}`;
	attempts++;

	if (addressMatchesPattern(address, pattern)) {
		parentPort.postMessage({
			type: 'hit',
			salt: `0x${bytesToHex(preimage.subarray(21, 53))}`,
			address,
			addressChecksum: eip55Checksum(address),
			attempts,
		});
		break;
	}

	if (attempts % PROGRESS_INTERVAL === 0) parentPort.postMessage({ type: 'progress', attempts });
}
