/**
 * How hard is an EVM vanity pattern, honestly.
 *
 * An EVM address is not a numeral. It is the low 20 bytes of a Keccak-256
 * digest, rendered as a fixed 40-character hex string with no length variance
 * and no leading-zero stripping, so every nibble is independently uniform at
 * both ends. Unlike Base58 on Solana, the honest model here really is 16⁻ⁿ, and
 * `0x0000…` costs exactly as much as `0xdead…`.
 *
 * The number people do get wrong is casing. EIP-55 re-cases the hex letters
 * using bits of keccak256 of the lowercase address, which behave as fair coin
 * flips, so asking for a *specific* spelling costs an extra factor of two per
 * letter: `dEaD` is sixteen times harder than any-case `dead`. Digits carry no
 * case and cost nothing extra.
 *
 * Grinding is geometric, so the expected value is not a deadline: at the
 * expected attempt count you have had a 63.2% chance of finishing. Every quote
 * here reports p50/p90/p99 next to the mean.
 */

/** Every EVM address is 20 bytes, so 40 hex nibbles. */
export const ADDRESS_NIBBLES = 40;

/** The model identifier named in quotes and attestations. */
export const DIFFICULTY_MODEL = 'hex-uniform/v1';

const HEX_RE = /^[0-9a-fA-F]*$/;
const LETTER_RE = /[a-fA-F]/;

/**
 * @typedef {object} Pattern
 * @property {string} [prefix] hex characters, with or without `0x`
 * @property {string} [suffix] hex characters
 * @property {boolean} [caseSensitive] match the EIP-55 spelling exactly
 */

/** Count the case-carrying characters (a-f) in a pattern. */
export function letterCount(pattern) {
	let n = 0;
	for (const ch of pattern || '') if (LETTER_RE.test(ch)) n++;
	return n;
}

/**
 * Normalize a pattern: strip `0x`, and infer case-sensitivity from the spelling
 * when the caller did not state it. A pattern containing an uppercase letter is
 * a request for that spelling; an all-lowercase one is not.
 * @param {Pattern} pattern
 * @returns {{ prefix: string, suffix: string, caseSensitive: boolean, letters: number, length: number }}
 */
export function normalizePattern(pattern = {}) {
	let prefix = String(pattern.prefix ?? '').trim().replace(/^0x/i, '');
	let suffix = String(pattern.suffix ?? '').trim().replace(/^0x/i, '');
	const caseSensitive = typeof pattern.caseSensitive === 'boolean'
		? pattern.caseSensitive
		: /[A-F]/.test(prefix + suffix);
	if (!caseSensitive) {
		prefix = prefix.toLowerCase();
		suffix = suffix.toLowerCase();
	}
	return {
		prefix,
		suffix,
		caseSensitive,
		letters: letterCount(prefix) + letterCount(suffix),
		length: prefix.length + suffix.length,
	};
}

/**
 * Probability that one random address matches.
 * @param {Pattern} pattern
 * @returns {number} in [0, 1]; 0 when the pattern is unreachable
 */
export function probability(pattern) {
	const p = normalizePattern(pattern);
	if (!HEX_RE.test(p.prefix) || !HEX_RE.test(p.suffix)) return 0;
	if (p.length === 0) return 1;
	if (p.length > ADDRESS_NIBBLES) return 0;
	const base = Math.pow(16, -p.length);
	return p.caseSensitive ? base * Math.pow(2, -p.letters) : base;
}

/**
 * Mean attempts before a hit.
 * @param {Pattern} pattern
 * @returns {number}
 */
export function expectedAttempts(pattern) {
	const p = probability(pattern);
	return p > 0 ? 1 / p : Infinity;
}

/**
 * Attempts needed for a given chance of having found a match.
 * @param {number} probabilityPerAttempt
 * @param {number} confidence in (0, 1)
 * @returns {number}
 */
export function attemptsForConfidence(probabilityPerAttempt, confidence) {
	if (!(probabilityPerAttempt > 0)) return Infinity;
	if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be in (0, 1)');
	if (probabilityPerAttempt >= 1) return 1;
	return Math.log(1 - confidence) / Math.log(1 - probabilityPerAttempt);
}

/**
 * How much more a case-sensitive spelling costs than the any-case one.
 * @param {Pattern} pattern
 * @returns {number} multiplier, at least 1
 */
export function caseSensitivityCost(pattern) {
	const p = normalizePattern(pattern);
	return p.caseSensitive ? Math.pow(2, p.letters) : 1;
}

/**
 * The whole difficulty picture, ready to render.
 * @param {Pattern} pattern
 * @param {{ attemptsPerSecond?: number }} [opts]
 * @returns {object}
 */
export function difficulty(pattern, opts = {}) {
	const p = normalizePattern(pattern);
	const prob = probability(pattern);
	const out = {
		model: DIFFICULTY_MODEL,
		pattern: p,
		probability: prob,
		expectedAttempts: expectedAttempts(pattern),
		p50: attemptsForConfidence(prob, 0.5),
		p90: attemptsForConfidence(prob, 0.9),
		p99: attemptsForConfidence(prob, 0.99),
		caseCost: caseSensitivityCost(pattern),
	};
	const rate = opts.attemptsPerSecond;
	if (rate > 0) {
		out.eta = {
			attemptsPerSecond: rate,
			p50Seconds: out.p50 / rate,
			p90Seconds: out.p90 / rate,
			p99Seconds: out.p99 / rate,
			p50Human: formatDuration(out.p50 / rate),
			p90Human: formatDuration(out.p90 / rate),
		};
	}
	return out;
}

/** Rarity tiers, in expected attempts. Ordered hardest first. */
export const TIERS = Object.freeze([
	{ tier: 'mythic', label: 'Mythic', minAttempts: 1e12 },
	{ tier: 'legendary', label: 'Legendary', minAttempts: 1e9 },
	{ tier: 'epic', label: 'Epic', minAttempts: 1e7 },
	{ tier: 'rare', label: 'Rare', minAttempts: 1e5 },
	{ tier: 'uncommon', label: 'Uncommon', minAttempts: 1e3 },
	{ tier: 'common', label: 'Common', minAttempts: 0 },
]);

/**
 * Tier and a 0-100 score for a pattern. The score is logarithmic because the
 * underlying quantity is: each extra nibble multiplies the work by sixteen.
 * 100 is pinned at 10¹⁸ expected attempts, where a single machine cannot finish
 * within a human lifetime.
 * @param {Pattern} pattern
 * @returns {{ tier: string, label: string, score: number, expectedAttempts: number }}
 */
export function rarity(pattern) {
	const attempts = expectedAttempts(pattern);
	const tier = Number.isFinite(attempts)
		? TIERS.find((t) => attempts >= t.minAttempts) || TIERS[TIERS.length - 1]
		: TIERS[0];
	const score = Number.isFinite(attempts) && attempts > 1
		? Math.round(Math.min(100, (Math.log10(attempts) / 18) * 100) * 10) / 10
		: 0;
	return { tier: tier.tier, label: tier.label, score, expectedAttempts: attempts };
}

const UNITS = [
	[1, 'second'], [60, 'minute'], [3600, 'hour'], [86400, 'day'], [86400 * 365.25, 'year'],
];

/**
 * Human duration.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
	if (!Number.isFinite(seconds)) return 'never';
	if (seconds < 1) return 'under a second';
	if (seconds > 86400 * 365.25 * 1e6) return 'longer than any machine will run';
	let unit = UNITS[0];
	for (const u of UNITS) if (seconds >= u[0]) unit = u;
	const value = seconds / unit[0];
	const rounded = value >= 100 ? Math.round(value) : Number(value.toPrecision(2));
	return `${rounded.toLocaleString('en-US')} ${unit[1]}${rounded === 1 ? '' : 's'}`;
}

/**
 * Human attempt count.
 * @param {number} n
 * @returns {string}
 */
export function formatAttempts(n) {
	if (!Number.isFinite(n)) return 'unreachable';
	for (const [size, label] of [[1e18, 'quintillion'], [1e15, 'quadrillion'], [1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
		if (n >= size) return `${Number((n / size).toPrecision(3)).toLocaleString('en-US')} ${label}`;
	}
	return Math.round(n).toLocaleString('en-US');
}
