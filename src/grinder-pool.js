/**
 * Multi-core salt grinder for Node.
 *
 * `grinder-node.js` hashes on the calling thread, which is right for a request
 * handler and wrong for a CLI: a laptop has eight cores and a salt search is
 * embarrassingly parallel. This module spawns one `worker_threads` worker per
 * requested core, each starting from its own random salt, and resolves on the
 * first hit.
 *
 * Workers are always torn down: on a hit, on an abort, and on a throw. A grind
 * that leaves eight threads pinned after the process thinks it finished is the
 * kind of bug that only shows up on someone else's machine.
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validatePattern, validateAddress, validateInitCodeHash } from './validation.js';
import { normalizePattern, expectedAttempts } from './difficulty.js';

/**
 * @typedef {object} PoolResult
 * @property {string} salt             `0x…` 32 bytes
 * @property {string} address          lowercase `0x…`
 * @property {string} addressChecksum  EIP-55 `0x…`
 * @property {string} deployer
 * @property {string} initCodeHash
 * @property {boolean} caseSensitive
 * @property {number} attempts         across every worker
 * @property {number} durationMs
 * @property {number} workers
 */

/**
 * @param {object} opts
 * @param {string} opts.deployer `0x…` 20 bytes
 * @param {string} opts.initCodeHash `0x…` 32 bytes
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.caseSensitive] inferred from the pattern's casing when omitted
 * @param {number} [opts.workers] defaults to every available core
 * @param {AbortSignal} [opts.signal]
 * @param {(p: { attempts: number, rate: number, workers: number }) => void} [opts.onProgress]
 * @returns {Promise<PoolResult>}
 */
export function grindSaltPool(opts = {}) {
	const pattern = normalizePattern(opts);
	if (!pattern.length) return Promise.reject(new Error('prefix or suffix is required'));
	for (const [label, side] of [['prefix', pattern.prefix], ['suffix', pattern.suffix]]) {
		if (!side) continue;
		const v = validatePattern(side);
		if (!v.valid) return Promise.reject(new Error(`invalid ${label}: ${v.errors.join('; ')}`));
	}
	const deployer = validateAddress(opts.deployer || '');
	if (!deployer.valid) return Promise.reject(new Error(`deployer: ${deployer.error}`));
	const initHash = validateInitCodeHash(opts.initCodeHash || '');
	if (!initHash.valid) return Promise.reject(new Error(`initCodeHash: ${initHash.error}`));

	const cores = Math.max(1, Math.min(opts.workers || availableParallelism(), 64));
	const workerPath = fileURLToPath(new URL('./node-worker.js', import.meta.url));
	const started = Date.now();

	return new Promise((resolve, reject) => {
		/** @type {Worker[]} */
		const pool = [];
		/** @type {number[]} */
		const attemptsPer = new Array(cores).fill(0);
		let settled = false;
		let progressTimer = null;

		const total = () => attemptsPer.reduce((a, b) => a + b, 0);

		function cleanup() {
			if (progressTimer) clearInterval(progressTimer);
			progressTimer = null;
			for (const w of pool) w.terminate();
			pool.length = 0;
			opts.signal?.removeEventListener('abort', onAbort);
		}

		function finish(fn, value) {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		}

		function onAbort() {
			finish(reject, Object.assign(new Error('grind aborted'), { name: 'AbortError' }));
		}

		if (opts.signal) {
			if (opts.signal.aborted) return onAbort();
			opts.signal.addEventListener('abort', onAbort, { once: true });
		}

		for (let i = 0; i < cores; i++) {
			const worker = new Worker(workerPath, { workerData: {
				deployer: deployer.normalized,
				initCodeHash: initHash.normalized,
				prefix: pattern.prefix,
				suffix: pattern.suffix,
				caseSensitive: pattern.caseSensitive,
			} });
			pool.push(worker);
			worker.on('message', (msg) => {
				if (msg.type === 'progress') {
					attemptsPer[i] = msg.attempts;
					return;
				}
				if (msg.type === 'error') {
					finish(reject, new Error(msg.message));
					return;
				}
				if (msg.type === 'hit') {
					attemptsPer[i] = msg.attempts;
					finish(resolve, {
						salt: msg.salt,
						address: msg.address,
						addressChecksum: msg.addressChecksum,
						deployer: deployer.normalized,
						initCodeHash: initHash.normalized,
						caseSensitive: pattern.caseSensitive,
						attempts: total(),
						durationMs: Date.now() - started,
						workers: cores,
					});
				}
			});
			worker.on('error', (err) => finish(reject, err));
		}

		if (opts.onProgress) {
			progressTimer = setInterval(() => {
				const attempts = total();
				const seconds = (Date.now() - started) / 1000;
				opts.onProgress({ attempts, rate: seconds > 0 ? attempts / seconds : 0, workers: cores });
			}, 250);
			// A progress timer must never be the reason the process refuses to exit.
			progressTimer.unref?.();
		}
	});
}

/**
 * Expected attempts for a pattern, re-exported so a caller driving the pool does
 * not need a second import for the ETA.
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} pattern
 * @returns {number}
 */
export function poolExpectedAttempts(pattern) {
	return expectedAttempts(pattern);
}
