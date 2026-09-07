/**
 * Node salt grinder, single-threaded.
 *
 * The same hot loop as the browser worker: keccak over the 85-byte preimage
 * `0xff ‖ deployer ‖ salt ‖ initCodeHash`, bumping a counter in the salt. The
 * `0xff ‖ deployer` prefix is constant per session but Keccak-f[1600] cannot
 * cache a partial input shorter than its 136-byte rate, and the preimage is 85
 * bytes, so each attempt costs one permutation (two when EIP-55 case matching
 * adds a keccak over the rendered address).
 *
 * Bounded by a wall-clock budget so a request handler can call it directly.
 * `grinder-pool.js` runs this shape across every core, which is what the CLI
 * uses.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

import { parseHex } from './create2.js';
import { eip55Checksum, addressMatchesPattern } from './address.js';
import { normalizePattern, expectedAttempts } from './difficulty.js';

/** Check the clock this often: frequently enough to honour a budget, rarely enough not to dominate. */
const CLOCK_INTERVAL = 4096;

/**
 * Bump the 64-bit big-endian counter that occupies the salt's last eight bytes.
 *
 * A `DataView` rather than `++buf[i]` with a carry loop, because `++` on a
 * `Uint8Array` element returns the *arithmetic* result (256 when a byte wraps),
 * not the stored value (0). A carry loop written the obvious way therefore
 * breaks out on every wrap, the carry never propagates, and the search silently
 * explores 256 salts instead of 2^64. That failure is invisible: the grinder
 * still reports a plausible attempt rate, it just never finds anything past a
 * two-character pattern.
 *
 * @param {DataView} counter
 * @param {{ hi: number, lo: number }} state
 */
function bumpCounter(counter, state) {
	state.lo = (state.lo + 1) >>> 0;
	if (state.lo === 0) state.hi = (state.hi + 1) >>> 0;
	counter.setUint32(0, state.hi, false);
	counter.setUint32(4, state.lo, false);
}

/**
 * @typedef {object} SaltGrindResult
 * @property {boolean} found
 * @property {string} [salt] `0x…` 32 bytes
 * @property {string} [address] lowercase `0x…`
 * @property {string} [addressChecksum]
 * @property {number} attempts
 * @property {number} durationMs
 */

/**
 * Search salts on this thread until a match or the budget runs out.
 *
 * @param {object} opts
 * @param {string} opts.deployer `0x…` 20 bytes
 * @param {string} opts.initCodeHash `0x…` 32 bytes
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.caseSensitive]
 * @param {number} [opts.timeBudgetMs=15000]
 * @param {Uint8Array} [opts.startSalt] 32 bytes; random when omitted
 * @param {(p: { attempts: number, rate: number }) => void} [opts.onProgress]
 * @returns {SaltGrindResult}
 */
export function grindSaltNode(opts = {}) {
	const pattern = normalizePattern(opts);
	if (!pattern.length) throw new Error('a prefix or suffix is required');

	const deployer = parseHex(opts.deployer, 'deployer', 20);
	const initHash = parseHex(opts.initCodeHash, 'initCodeHash', 32);
	const timeBudgetMs = opts.timeBudgetMs ?? 15_000;
	const started = Date.now();

	// One reusable preimage buffer: 0xff, the deployer, the salt, the init-code
	// hash. Only the salt's tail changes between attempts.
	const preimage = new Uint8Array(85);
	preimage[0] = 0xff;
	preimage.set(deployer, 1);
	preimage.set(initHash, 53);

	const salt = opts.startSalt ? Uint8Array.from(opts.startSalt) : new Uint8Array(32);
	if (!opts.startSalt) crypto.getRandomValues(salt);
	preimage.set(salt, 21);

	// The counter lives in the salt's last eight bytes, leaving 24 bytes of the
	// caller's or the CSPRNG's entropy untouched.
	const counter = new DataView(preimage.buffer, preimage.byteOffset + 45, 8);
	const counterState = { hi: counter.getUint32(0, false), lo: counter.getUint32(4, false) };

	let attempts = 0;
	for (;;) {
		bumpCounter(counter, counterState);

		const address = `0x${bytesToHex(keccak_256(preimage)).slice(-40)}`;
		attempts++;

		if (addressMatchesPattern(address, pattern)) {
			return {
				found: true,
				salt: `0x${bytesToHex(preimage.subarray(21, 53))}`,
				address,
				addressChecksum: eip55Checksum(address),
				attempts,
				durationMs: Date.now() - started,
			};
		}

		if (attempts % CLOCK_INTERVAL === 0) {
			if (opts.onProgress) {
				const seconds = (Date.now() - started) / 1000;
				opts.onProgress({ attempts, rate: seconds > 0 ? Math.round(attempts / seconds) : 0 });
			}
			if (Date.now() - started >= timeBudgetMs) break;
		}
	}

	return { found: false, attempts, durationMs: Date.now() - started };
}

/**
 * Expected salts for a pattern, re-exported so a caller driving the grinder does
 * not need a second import for the ETA.
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} pattern
 * @returns {number}
 */
export function expectedSaltsFor(pattern) {
	return expectedAttempts(pattern);
}
