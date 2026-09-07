#!/usr/bin/env node
/**
 * create2-vanity MCP server.
 *
 * Six tools over stdio. Five of them are pure computation on the machine
 * running the server; only `create2_availability` touches the network, and it
 * only reads.
 *
 * There is no key material anywhere in this server, which is what makes it safe
 * to let an assistant drive: the worst possible outcome of a wrong answer is a
 * salt that does not produce the claimed address, and `create2_derive` proves
 * that in one keccak.
 *
 *   { "mcpServers": { "create2-vanity": { "command": "npx", "args": ["-y", "create2-vanity", "mcp"] } } }
 */

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { grindSaltPool } from '../src/grinder-pool.js';
import { create2Address, createAddress, initCodeHash, describeDeployment, readArtifact, constructorInputs } from '../src/create2.js';
import { difficulty, rarity, normalizePattern } from '../src/difficulty.js';
import { validatePattern, validateAddress, validateInitCodeHash, MAX_PATTERN_LENGTH } from '../src/validation.js';
import { eip55Checksum } from '../src/address.js';
import { verifyAttestation } from '../src/attestation.js';
import { CHAINS, FACTORY_LABELS, getChain, hasCode, ARACHNID_PROXY } from '../src/chains.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_API = process.env.CREATE2_VANITY_API || 'https://create2-vanity.dev';
const GRIND_MAX_MS = Number(process.env.CREATE2_VANITY_MAX_GRIND_MS || 120_000);

const PATTERN_SHAPE = {
	prefix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Hex characters the address must start with, without 0x. An uppercase letter requests that EIP-55 spelling and costs 2x per letter.'),
	suffix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Hex characters the address must end with.'),
	caseSensitive: z.boolean().optional().describe('Force EIP-55 case matching. Inferred from the pattern when omitted.'),
};

const DEPLOYMENT_SHAPE = {
	deployer: z.string().optional().describe(`The factory address. Defaults to the Arachnid deterministic-deployment-proxy (${ARACHNID_PROXY}), which is live on every chain in the registry.`),
	initCodeHash: z.string().optional().describe('keccak256 of the init code, 32 bytes.'),
	initCode: z.string().optional().describe('Raw init code: deploy bytecode WITH the ABI-encoded constructor arguments appended. Hashed for you.'),
};

/** @type {Array<{name:string,title:string,description:string,annotations:object,inputSchema:object,handler:Function}>} */
const TOOLS = [
	{
		name: 'create2_derive',
		title: 'Derive a deterministic contract address',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Derive a CREATE2 address from a deployer, a salt and an init-code hash, or a plain CREATE address from a sender and a nonce. ' +
			'Pure arithmetic and completely verifiable: this is the check that makes every other claim about a CREATE2 address falsifiable.',
		inputSchema: {
			...DEPLOYMENT_SHAPE,
			salt: z.string().optional().describe('The 32-byte salt, for a CREATE2 derivation.'),
			sender: z.string().optional().describe('For a plain CREATE derivation, the deploying account.'),
			nonce: z.number().int().min(0).optional().describe('For a plain CREATE derivation, that account’s nonce.'),
		},
		handler(args) {
			if (args?.sender !== undefined || args?.nonce !== undefined) {
				const address = createAddress(String(args.sender), Number(args.nonce ?? 0));
				return { scheme: 'create', address: eip55Checksum(address), derivation: 'keccak256(rlp([sender, nonce]))[12:]' };
			}
			const { deployer, hash } = readDeployment(args);
			if (!args?.salt) throw new Error('give a salt, or a sender and a nonce');
			return {
				scheme: 'create2',
				...describeDeployment({ deployer, salt: String(args.salt), initCodeHash: hash, initCode: args?.initCode }),
				derivation: 'keccak256(0xff | deployer | salt | initCodeHash)[12:]',
			};
		},
	},
	{
		name: 'create2_quote',
		title: 'Price a vanity contract-address pattern',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Difficulty for a CREATE2 vanity pattern: probability, expected salts, p50/p90/p99, rarity tier and the EIP-55 case multiplier. ' +
			'Every nibble of an address is uniform, so a prefix costs the same as a suffix; the only free variable is casing, at 2x per letter.',
		inputSchema: { ...PATTERN_SHAPE, attemptsPerSecond: z.number().positive().optional().describe('Your measured rate, to turn salts into wall-clock time.') },
		handler(args) {
			const pattern = readPattern(args);
			return { difficulty: difficulty(pattern, args?.attemptsPerSecond ? { attemptsPerSecond: args.attemptsPerSecond } : {}), rarity: rarity(pattern) };
		},
	},
	{
		name: 'create2_grind',
		title: 'Grind a CREATE2 salt',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			'Search salts for an address matching a pattern, using every core of the machine running this server. No key material is involved: ' +
			'the result is a public salt, and the caller confirms it with create2_derive in one keccak.',
		inputSchema: {
			...DEPLOYMENT_SHAPE,
			...PATTERN_SHAPE,
			cores: z.number().int().min(1).max(64).optional().describe(`Workers to use. Defaults to every core (${availableParallelism()} here).`),
			timeBudgetMs: z.number().int().positive().optional().describe(`Give up after this long. Capped at ${GRIND_MAX_MS}ms.`),
		},
		async handler(args) {
			const pattern = readPattern(args);
			const { deployer, hash } = readDeployment(args);
			const budget = Math.min(GRIND_MAX_MS, args?.timeBudgetMs || GRIND_MAX_MS);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), budget);
			try {
				const result = await grindSaltPool({ deployer, initCodeHash: hash, ...pattern, workers: args?.cores, signal: controller.signal });
				return {
					...describeDeployment({ deployer, salt: result.salt, initCodeHash: hash, initCode: args?.initCode }),
					attempts: result.attempts,
					durationMs: result.durationMs,
					workers: result.workers,
					rarity: rarity(pattern),
					verify: 'Confirm with create2_derive: nothing here has to be trusted.',
				};
			} catch (err) {
				if (err?.name === 'AbortError') {
					const d = difficulty(pattern);
					throw new Error(`no match within ${budget}ms. This pattern needs about ${Math.round(d.p50).toLocaleString('en-US')} salts for an even chance; raise timeBudgetMs, shorten the pattern, or drop the uppercase letters.`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	},
	{
		name: 'create2_availability',
		title: 'Check an address is free on every chain',
		annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
		description:
			'Ask each EVM chain whether a predicted address already holds code, and whether the deployer exists there. ' +
			'A CREATE2 address is portable but not automatically available: it can be occupied on one chain and free on the rest, ' +
			'and finding that out after sending a deployment is expensive.',
		inputSchema: {
			address: z.string().describe('The predicted address.'),
			deployer: z.string().optional().describe('Also check the deployer is present on each chain.'),
			chainIds: z.array(z.number().int()).optional().describe('Limit the check to these chain ids.'),
		},
		async handler(args) {
			const address = String(args?.address || '').trim();
			if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('address must be a 20-byte 0x address');
			const chains = args?.chainIds?.length ? args.chainIds.map((id) => getChain(id)).filter(Boolean) : CHAINS;

			const results = await Promise.all(chains.map(async (chain) => {
				try {
					const occupied = await hasCode(chain.rpc, address, { timeoutMs: 10_000 });
					const deployerPresent = args?.deployer ? await hasCode(chain.rpc, String(args.deployer), { timeoutMs: 10_000 }) : null;
					return { chainId: chain.id, name: chain.name, free: !occupied, deployerPresent, explorer: `${chain.explorer}/address/${address}` };
				} catch (err) {
					return { chainId: chain.id, name: chain.name, free: null, error: err.message };
				}
			}));
			const occupied = results.filter((r) => r.free === false);
			return { address: eip55Checksum(address), free: occupied.length === 0, occupiedOn: occupied.map((r) => r.chainId), chains: results };
		},
	},
	{
		name: 'create2_verify_attestation',
		title: 'Verify a grind attestation',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		description:
			'Verify a CREATE2 grind attestation: re-derive the address from the attested deployer, salt and init-code hash, check the pattern and the ' +
			'difficulty, then recover the EIP-712 signer and check it against the published issuer list. The derivation check needs no issuer at all.',
		inputSchema: {
			attestation: z.record(z.string(), z.unknown()).describe('The attestation document.'),
			api: z.string().url().optional().describe('Issuer base URL for the published issuer list.'),
		},
		async handler(args) {
			const doc = args?.attestation?.attestation ?? args?.attestation;
			if (!doc || typeof doc !== 'object') throw new Error('attestation must be an object');
			const api = String(args?.api || DEFAULT_API).replace(/\/$/, '');
			let issuers = null;
			try {
				const r = await fetch(`${api}/.well-known/create2-vanity.json`);
				if (r.ok) issuers = ((await r.json()).issuers || []).map((i) => i.address);
			} catch {
				issuers = null;
			}
			return { ...verifyAttestation(doc, issuers?.length ? { issuers } : {}), issuersPinned: !!issuers?.length };
		},
	},
	{
		name: 'create2_chains',
		title: 'EVM chains and deterministic deployers',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'The EVM chain registry, including Ethereum, Base, Arbitrum and Robinhood Chain, with the deterministic CREATE2 deployers live on each. ' +
			'Same deployer, init code and salt gives the same address on all of them.',
		inputSchema: {},
		handler() {
			return {
				factories: Object.entries(FACTORY_LABELS).map(([address, label]) => ({ address, label })),
				chains: CHAINS.map((c) => ({ id: c.id, name: c.name, rpc: c.rpc, explorer: c.explorer, testnet: !!c.testnet, factories: Object.keys(c.factories) })),
			};
		},
	},
];

/** @param {any} args @returns {{ prefix: string, suffix: string, caseSensitive: boolean }} */
function readPattern(args) {
	const p = normalizePattern({
		prefix: String(args?.prefix ?? '').trim(),
		suffix: String(args?.suffix ?? '').trim(),
		...(typeof args?.caseSensitive === 'boolean' ? { caseSensitive: args.caseSensitive } : {}),
	});
	if (!p.length) throw new Error('give a prefix, a suffix, or both');
	for (const [label, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/** @param {any} args @returns {{ deployer: string, hash: string }} */
function readDeployment(args) {
	const deployer = validateAddress(String(args?.deployer || ARACHNID_PROXY));
	if (!deployer.valid) throw new Error(`deployer: ${deployer.error}`);
	let hash;
	if (args?.initCodeHash) {
		const v = validateInitCodeHash(String(args.initCodeHash));
		if (!v.valid) throw new Error(`initCodeHash: ${v.error}`);
		hash = v.normalized;
	} else if (args?.initCode) {
		hash = initCodeHash(String(args.initCode));
	} else {
		throw new Error('give initCodeHash or initCode');
	}
	return { deployer: deployer.normalized, hash };
}

/**
 * Build a fully registered server without connecting a transport, so tests can
 * drive it in-process.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'create2-vanity', title: 'CREATE2 Vanity', version: PKG.version },
		{
			capabilities: { tools: {} },
			instructions:
				'Deterministic contract addresses. create2_derive computes an address from a deployer, salt and init-code hash (or from a sender and ' +
				'nonce for plain CREATE), and is the check that makes every other claim here falsifiable. create2_grind searches salts across every core; ' +
				'no key material is involved, so its output is safe to hand around. create2_quote prices a pattern (16^n per character, plus 2x per letter ' +
				'for EIP-55 casing). create2_availability checks the predicted address is still unclaimed on each chain, which is the failure mode people ' +
				'discover too late. create2_verify_attestation checks a signed grind document. Note that the init code must include the ABI-encoded ' +
				'constructor arguments: hashing the deploy bytecode alone is the most common reason a predicted address turns out wrong.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
				} catch (err) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

/** Tool definitions, exported so tests and docs stay in sync with the server. */
export { TOOLS };

async function main() {
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[create2-vanity@${PKG.version}] MCP server on stdio with ${TOOLS.length} tools`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
