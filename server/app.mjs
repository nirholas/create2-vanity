/**
 * The create2-vanity HTTP API.
 *
 * One Fetch handler, two hosts (Node and Cloudflare Workers).
 *
 * The policy here is deliberately different from a wallet grinder's. A CREATE2
 * address involves no key material at all, and the caller re-derives it in one
 * keccak, so server-side grinding is **on by default**: there is nothing to
 * leak, and a service that refuses to do the work would be pure theatre. What
 * the server must never do is claim something the caller cannot check, which is
 * why every response carries the inputs that reproduce it.
 */

import { createRouter, json, text, body, assert, HttpError } from './router.mjs';
import { issuerKey, publicIssuers } from './keys.mjs';
import { difficulty, rarity, normalizePattern, expectedAttempts, DIFFICULTY_MODEL } from '../src/difficulty.js';
import { create2Address, createAddress, initCodeHash, describeDeployment, parseHex, randomSalt } from '../src/create2.js';
import { eip55Checksum, inspectAddress } from '../src/address.js';
import { validatePattern, validateAddress, validateInitCodeHash, MAX_PATTERN_LENGTH } from '../src/validation.js';
import { buildAttestation, signAttestation, verifyAttestation, TYPE_HASH, DOMAIN_SEPARATOR_HEX, ATTESTATION_TYPE, ATTESTATION_PROTOCOL } from '../src/attestation.js';
import { CHAINS, FACTORY_LABELS, getChain, hasCode } from '../src/chains.js';
import { agentCard, mcpDescriptor, llmsTxt, openApi, robotsTxt, sitemapXml } from './discovery.mjs';

export const SERVICE = {
	name: 'create2-vanity',
	version: '1.0.0',
	description: 'CREATE2 vanity address grinding, derivation, cross-chain availability and EIP-712 grind attestations.',
	repository: 'https://github.com/nirholas/create2-vanity',
	license: 'Apache-2.0',
};

/** Server-side grinds are bounded so one caller cannot hold a worker. */
const GRIND_MAX_MS = 20_000;
const GRIND_DEFAULT_MS = 8_000;
/** Availability probes are bounded so one caller cannot fan out unbounded RPC load. */
const MAX_CHAINS_PER_CHECK = 16;

const router = createRouter();

// ── Health ───────────────────────────────────────────────────────────────────
router.get('/api/health', ({ env }) => {
	const key = issuerKey(env);
	return json({
		ok: true,
		service: SERVICE.name,
		version: SERVICE.version,
		issuer: { address: key.address, ephemeral: key.ephemeral },
		difficultyModel: DIFFICULTY_MODEL,
		attestationProtocol: ATTESTATION_PROTOCOL,
		eip712: { typeHash: TYPE_HASH, domainSeparator: DOMAIN_SEPARATOR_HEX, type: ATTESTATION_TYPE },
		note: 'No endpoint on this service handles key material. A CREATE2 address is a pure function of a deployer, a salt and init code.',
	});
});

// ── Derivation ───────────────────────────────────────────────────────────────
router.post('/api/derive', async ({ req }) => {
	const b = await body(req);

	// Plain CREATE, for "which address will my next deploy land on".
	if (b.sender !== undefined || b.nonce !== undefined) {
		assert(b.sender, 'sender is required for a CREATE derivation');
		assert(Number.isInteger(Number(b.nonce)) && Number(b.nonce) >= 0, 'nonce must be a non-negative integer');
		let address;
		try {
			address = createAddress(String(b.sender), Number(b.nonce));
		} catch (err) {
			throw new HttpError(400, err.message);
		}
		return json({
			scheme: 'create',
			address: eip55Checksum(address),
			derivation: 'keccak256(rlp([sender, nonce]))[12:]',
			inputs: { sender: eip55Checksum(String(b.sender)), nonce: Number(b.nonce) },
		}, { cache: 'public, max-age=3600' });
	}

	const deployer = validateAddress(String(b.deployer || ''));
	assert(deployer.valid, `deployer: ${deployer.error || 'required'}`);
	assert(b.salt, 'salt is required');

	let hash;
	try {
		hash = b.initCodeHash ? `0x${Buffer.from(parseHex(b.initCodeHash, 'initCodeHash', 32)).toString('hex')}` : initCodeHash(String(b.initCode || ''));
	} catch (err) {
		throw new HttpError(400, err.message);
	}

	try {
		return json({
			scheme: 'create2',
			...describeDeployment({ deployer: deployer.normalized, salt: String(b.salt), initCodeHash: hash, initCode: b.initCode }),
			derivation: 'keccak256(0xff | deployer | salt | initCodeHash)[12:]',
		}, { cache: 'public, max-age=3600' });
	} catch (err) {
		throw new HttpError(400, err.message);
	}
});

// ── Quote ────────────────────────────────────────────────────────────────────
router.post('/api/quote', async ({ req }) => {
	const b = await body(req);
	const pattern = readPattern(b);
	const rate = positiveNumber(b.attemptsPerSecond, 0);
	const d = difficulty(pattern, rate > 0 ? { attemptsPerSecond: rate } : {});

	return json({
		pattern: d.pattern,
		difficulty: {
			model: d.model,
			probability: d.probability,
			expectedAttempts: d.expectedAttempts,
			p50: d.p50,
			p90: d.p90,
			p99: d.p99,
			caseSensitivityCost: d.caseCost,
		},
		rarity: rarity(pattern),
		eta: d.eta ?? null,
		note: 'Every nibble of an EVM address is uniform, so a prefix and a suffix cost the same. Only EIP-55 casing changes the price.',
		limits: { maxPatternLengthPerSide: MAX_PATTERN_LENGTH },
	}, { cache: 'public, max-age=3600' });
});

// ── Grind ────────────────────────────────────────────────────────────────────
router.post('/api/grind', async ({ req }) => {
	const b = await body(req);
	const pattern = readPattern(b);
	const deployer = validateAddress(String(b.deployer || ''));
	assert(deployer.valid, `deployer: ${deployer.error || 'required'}`);

	let hash;
	try {
		hash = b.initCodeHash
			? validateInitCodeHash(String(b.initCodeHash)).normalized
			: initCodeHash(String(b.initCode || ''));
	} catch (err) {
		throw new HttpError(400, err.message);
	}
	assert(hash, 'give initCodeHash or initCode');

	const budget = Math.min(GRIND_MAX_MS, positiveNumber(b.timeBudgetMs, GRIND_DEFAULT_MS));
	const { grindSaltNode } = await import('../src/grinder-node.js');
	const result = grindSaltNode({ deployer: deployer.normalized, initCodeHash: hash, ...pattern, timeBudgetMs: budget });

	if (!result.found) {
		return json({
			found: false,
			attempts: result.attempts,
			durationMs: result.durationMs,
			timeBudgetMs: budget,
			expectedAttempts: expectedAttempts(pattern),
			hint: `Call again to keep searching, or raise timeBudgetMs (capped at ${GRIND_MAX_MS}ms per request). Long patterns are faster to grind locally across every core: npx create2-vanity grind.`,
		});
	}

	return json({
		found: true,
		...describeDeployment({ deployer: deployer.normalized, salt: result.salt, initCodeHash: hash }),
		attempts: result.attempts,
		durationMs: result.durationMs,
		verify: 'Re-derive it yourself: keccak256(0xff | deployer | salt | initCodeHash)[12:]. Nothing here needs to be trusted.',
	});
});

// ── Availability ─────────────────────────────────────────────────────────────
router.post('/api/availability', async ({ req }) => {
	const b = await body(req);
	const address = String(b.address || '').trim();
	assert(/^0x[0-9a-fA-F]{40}$/.test(address), 'address must be a 20-byte 0x address');
	const deployer = b.deployer ? String(b.deployer).trim() : null;
	if (deployer) assert(/^0x[0-9a-fA-F]{40}$/.test(deployer), 'deployer must be a 20-byte 0x address');

	const requested = Array.isArray(b.chainIds) && b.chainIds.length
		? b.chainIds.slice(0, MAX_CHAINS_PER_CHECK).map((id) => getChain(id)).filter(Boolean)
		: CHAINS;

	const results = await Promise.all(requested.map(async (chain) => {
		try {
			const [occupied, factoryPresent] = await Promise.all([
				hasCode(chain.rpc, address, { timeoutMs: 10_000 }),
				deployer ? hasCode(chain.rpc, deployer, { timeoutMs: 10_000 }) : Promise.resolve(null),
			]);
			return {
				chainId: chain.id,
				name: chain.name,
				free: !occupied,
				deployerPresent: factoryPresent,
				explorer: `${chain.explorer}/address/${address}`,
			};
		} catch (err) {
			return { chainId: chain.id, name: chain.name, free: null, error: err.message };
		}
	}));

	const occupied = results.filter((r) => r.free === false);
	return json({
		address: eip55Checksum(address),
		checkedAt: new Date().toISOString(),
		free: occupied.length === 0,
		occupiedOn: occupied.map((r) => r.chainId),
		chains: results,
		note: 'A CREATE2 address is portable, but portability is not availability: somebody else can already occupy it on one chain while it is free on the rest.',
	});
});

// ── Attestations ─────────────────────────────────────────────────────────────
router.post('/api/attest', async ({ req, env }) => {
	const b = await body(req);
	const pattern = readPattern(b);
	const deployer = validateAddress(String(b.deployer || ''));
	assert(deployer.valid, `deployer: ${deployer.error || 'required'}`);
	assert(b.salt, 'salt is required');

	let hash;
	try {
		hash = b.initCodeHash ? validateInitCodeHash(String(b.initCodeHash)).normalized : initCodeHash(String(b.initCode || ''));
	} catch (err) {
		throw new HttpError(400, err.message);
	}
	assert(hash, 'give initCodeHash or initCode');

	const key = issuerKey(env);
	let core;
	try {
		core = buildAttestation({
			deployer: deployer.normalized,
			salt: String(b.salt),
			initCodeHash: hash,
			pattern,
			attempts: positiveNumber(b.attempts, 0),
		});
	} catch (err) {
		throw new HttpError(400, err.message);
	}

	return json({
		attestation: signAttestation({ core, signingKey: key.privateKey }),
		issuer: key.address,
		ephemeralKey: key.ephemeral,
		verify: '/api/verify',
		issuers: '/.well-known/create2-vanity.json',
		note: 'The central claim in this document is re-derived by any verifier in one keccak. The signature adds provenance, not authority.',
		...(key.ephemeral
			? { warning: 'This service is running with an ephemeral issuer key. The signature stops verifying when the process restarts; the derivation check never does.' }
			: {}),
	});
});

router.post('/api/verify', async ({ req, env }) => {
	const b = await body(req);
	const doc = b.attestation ?? b;
	assert(doc && typeof doc === 'object', 'send { "attestation": { … } }');
	return json(verifyAttestation(doc, { issuers: publicIssuers(env).map((i) => i.address) }));
});

// ── Chains ───────────────────────────────────────────────────────────────────
router.get('/api/chains', () => json({
	note: 'Same deployer, same init code, same salt gives the same address on every chain listed here.',
	verifiedAt: '2026-09-07',
	factories: Object.entries(FACTORY_LABELS).map(([address, label]) => ({ address, label })),
	chains: CHAINS.map((c) => ({
		id: c.id,
		name: c.name,
		shortName: c.shortName,
		rpc: c.rpc,
		explorer: c.explorer,
		currency: c.currency,
		testnet: !!c.testnet,
		factories: Object.keys(c.factories),
	})),
}, { cache: 'public, max-age=3600' }));

router.get('/api/salt', () => json({ salt: randomSalt(), note: 'A random 32-byte salt, for a deployment that needs no vanity at all.' }));

// ── Discovery ────────────────────────────────────────────────────────────────
router.get('/.well-known/create2-vanity.json', ({ env, url }) => json({
	service: SERVICE.name,
	version: SERVICE.version,
	description: SERVICE.description,
	repository: SERVICE.repository,
	license: SERVICE.license,
	protocols: { attestation: ATTESTATION_PROTOCOL, difficultyModel: DIFFICULTY_MODEL },
	eip712: { typeHash: TYPE_HASH, domainSeparator: DOMAIN_SEPARATOR_HEX, type: ATTESTATION_TYPE },
	issuers: publicIssuers(env),
	endpoints: {
		derive: `${url.origin}/api/derive`,
		quote: `${url.origin}/api/quote`,
		grind: `${url.origin}/api/grind`,
		availability: `${url.origin}/api/availability`,
		attest: `${url.origin}/api/attest`,
		verify: `${url.origin}/api/verify`,
		chains: `${url.origin}/api/chains`,
		openapi: `${url.origin}/openapi.json`,
	},
}, { cache: 'public, max-age=300' }));

router.get('/.well-known/agents.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/agent.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/mcp.json', ({ url }) => json(mcpDescriptor(url.origin), { cache: 'public, max-age=3600' }));
router.get('/openapi.json', ({ url }) => json(openApi(url.origin), { cache: 'public, max-age=3600' }));
router.get('/llms.txt', ({ url }) => text(llmsTxt(url.origin), { cache: 'public, max-age=3600' }));
router.get('/robots.txt', ({ url }) => text(robotsTxt(url.origin)));
router.get('/sitemap.xml', ({ url }) => text(sitemapXml(url.origin), { type: 'application/xml; charset=utf-8' }));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, any>} b
 * @returns {{ prefix: string, suffix: string, caseSensitive: boolean }}
 */
function readPattern(b) {
	const p = normalizePattern({
		prefix: String(b.prefix ?? '').trim(),
		suffix: String(b.suffix ?? '').trim(),
		...(typeof b.caseSensitive === 'boolean' ? { caseSensitive: b.caseSensitive } : {}),
	});
	assert(p.length > 0, 'give a prefix, a suffix, or both');
	for (const [side, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		assert(v.valid, `${side}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/** @param {any} value @param {number} fallback @returns {number} */
function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The application handler. Returns `null` when nothing matched so a host can
 * serve static assets from the same origin.
 * @param {Request} req
 * @param {any} [env]
 * @returns {Promise<Response|null>}
 */
export function handle(req, env) {
	return router.handle(req, env);
}
