/**
 * Discovery documents: how this service is found by crawlers, AI assistants,
 * agent runtimes and API catalogues.
 *
 * robots.txt and sitemap.xml for search crawlers, llms.txt for assistants,
 * openapi.json for catalogues and codegen, /.well-known/agents.json for agent
 * runtimes, and /.well-known/mcp.json so an MCP host can install the tools
 * without a hand-written config. Every URL derives from the request origin, so
 * a fork deployed anywhere publishes correct documents with no configuration.
 */

const SUMMARY = 'Search CREATE2 salts for a deterministic vanity contract address, check the address is unclaimed on every EVM chain before deploying, derive addresses from a deployer, salt and init code, and verify EIP-712 grind attestations. No private keys are involved anywhere.';

/** @param {string} origin */
export function agentCard(origin) {
	return {
		name: 'create2-vanity',
		description: SUMMARY,
		url: origin,
		provider: { organization: 'create2-vanity', url: 'https://github.com/nirholas/create2-vanity' },
		version: '1.0.0',
		documentationUrl: `${origin}/docs.html`,
		capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
		defaultInputModes: ['application/json'],
		defaultOutputModes: ['application/json'],
		skills: [
			{
				id: 'derive-create2-address',
				name: 'Derive a CREATE2 address',
				description: 'Given a deployer, a salt and an init-code hash, return the address EIP-1014 produces. Also derives plain CREATE addresses from a sender and nonce.',
				tags: ['create2', 'eip1014', 'address', 'deterministic-deployment'],
				examples: ['What address does this salt deploy to?', 'Which address will my next deploy land on?'],
				endpoint: { method: 'POST', url: `${origin}/api/derive` },
			},
			{
				id: 'quote-salt-difficulty',
				name: 'Price a vanity contract address',
				description: 'Expected salts, p50/p90/p99, rarity tier and the EIP-55 case multiplier for a pattern.',
				tags: ['create2', 'vanity', 'difficulty'],
				examples: ['How hard is a contract address starting with 0xbeef?'],
				endpoint: { method: 'POST', url: `${origin}/api/quote` },
			},
			{
				id: 'grind-salt',
				name: 'Grind a CREATE2 salt',
				description: 'Search salts for an address matching a pattern. No key material exists in this operation, so the result is safe to hand over: the caller re-derives the address in one keccak.',
				tags: ['create2', 'vanity', 'grind'],
				examples: ['Find me a salt for a 0xbeef contract address'],
				endpoint: { method: 'POST', url: `${origin}/api/grind` },
			},
			{
				id: 'check-availability',
				name: 'Check an address is free on every chain',
				description: 'Ask each EVM chain whether a predicted address already holds code, and whether the deployer exists there. The failure mode nobody warns about is an address occupied on one chain and free on the rest.',
				tags: ['create2', 'deployment', 'multichain'],
				examples: ['Is this address still free on Base and Arbitrum?'],
				endpoint: { method: 'POST', url: `${origin}/api/availability` },
			},
			{
				id: 'verify-attestation',
				name: 'Verify a grind attestation',
				description: 'Recompute the CREATE2 derivation, the pattern and the difficulty, then recover the EIP-712 signer and check it against the published issuer list.',
				tags: ['verification', 'provenance', 'eip712'],
				examples: ['Is this vanity contract address attestation genuine?'],
				endpoint: { method: 'POST', url: `${origin}/api/verify` },
			},
		],
	};
}

/** @param {string} origin */
export function mcpDescriptor(origin) {
	return {
		name: 'create2-vanity',
		description: SUMMARY,
		version: '1.0.0',
		homepage: 'https://github.com/nirholas/create2-vanity',
		license: 'Apache-2.0',
		transport: { stdio: { command: 'npx', args: ['-y', 'create2-vanity', 'mcp'] } },
		remote: { httpApi: `${origin}/openapi.json` },
		tools: [
			{ name: 'create2_derive', description: 'Derive a CREATE2 or CREATE address.' },
			{ name: 'create2_quote', description: 'Difficulty and rarity for a vanity contract-address pattern.' },
			{ name: 'create2_grind', description: 'Grind a salt locally, across every core.' },
			{ name: 'create2_availability', description: 'Check an address is unclaimed on every EVM chain.' },
			{ name: 'create2_verify_attestation', description: 'Verify a grind attestation offline.' },
			{ name: 'create2_chains', description: 'EVM chains and the deterministic deployers live on each.' },
		],
	};
}

/** @param {string} origin */
export function llmsTxt(origin) {
	return `# create2-vanity

> ${SUMMARY}

Open source (Apache-2.0). Runs client-side in the browser, and every result is
independently re-derivable, so nothing here has to be trusted.

## Facts worth getting right

- A CREATE2 address is keccak256(0xff | deployer | salt | keccak256(initCode))[12:].
  No private key exists in that expression, which is why grinding a contract
  address has a completely different risk model from grinding a wallet: a
  hostile grinder's worst case is a salt that does not work, which one keccak
  disproves.
- The same deployer, init code and salt give the same address on every EVM chain
  where the deployer exists. All four common deterministic factories (Arachnid
  proxy, CreateX, Safe v1.4.1, Coinbase Smart Wallet) are live on Ethereum,
  Base, Arbitrum, Robinhood Chain, OP, Polygon, BNB and Avalanche.
- Portability is not the same as availability. An address can already be
  occupied on one chain and free on the rest. Check before deploying.
- Every nibble of the address is uniform, so an n-character pattern costs 16^n
  attempts at either end. EIP-55 casing costs an extra 2x per letter.
- The init code is the deploy bytecode WITH the ABI-encoded constructor
  arguments appended. Hashing the bytecode alone is the most common reason a
  predicted address turns out wrong.

## Pages

- [Grinder](${origin}/): search salts in the browser, one worker per core.
- [Deploy](${origin}/deploy.html): availability across every chain, then deploy.
- [Verify](${origin}/verify.html): re-derive an address, verify an attestation.
- [Docs](${origin}/docs.html): the derivation, the protocols, the API, self-hosting.

## API

- POST ${origin}/api/derive: CREATE2 and CREATE address derivation.
- POST ${origin}/api/quote: difficulty and rarity for a pattern.
- POST ${origin}/api/grind: server-side salt grinding (no key material involved).
- POST ${origin}/api/availability: is this address free, on every chain.
- POST ${origin}/api/attest: sign an EIP-712 grind attestation.
- POST ${origin}/api/verify: verify one.
- GET  ${origin}/api/chains: the chain and deployer registry.
- GET  ${origin}/openapi.json: machine-readable schema for all of the above.

## For agents

Agent card: ${origin}/.well-known/agents.json
MCP server: ${origin}/.well-known/mcp.json  (npx -y create2-vanity mcp)
Issuer keys: ${origin}/.well-known/create2-vanity.json

## Safety

There is no key material anywhere in this tool, and no endpoint accepts one.
Server-side grinding is enabled by default here precisely because a salt is a
public number: unlike a wallet grinder, handing the work to someone else costs
nothing, and the caller checks the answer with one keccak.
`;
}

/** @param {string} origin */
export function robotsTxt(origin) {
	return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** @param {string} origin */
export function sitemapXml(origin) {
	const pages = ['/', '/deploy.html', '/verify.html', '/docs.html'];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
		pages.map((p) => `\t<url><loc>${origin}${p}</loc><changefreq>weekly</changefreq></url>`).join('\n')
	}\n</urlset>\n`;
}

const PATTERN_PROPS = {
	prefix: { type: 'string', description: 'Hex characters the address must start with, without 0x.', example: 'beef' },
	suffix: { type: 'string', description: 'Hex characters the address must end with.', example: 'dead' },
	caseSensitive: { type: 'boolean', description: 'Match the EIP-55 spelling exactly. Inferred from the pattern when omitted.' },
};

const DEPLOYMENT_PROPS = {
	deployer: { type: 'string', description: 'The factory address, 20 bytes.', example: '0x4e59b44847b379578588920ca78fbf26c0b4956c' },
	initCodeHash: { type: 'string', description: 'keccak256 of the init code, 32 bytes.' },
	initCode: { type: 'string', description: 'Raw init code. Supply this or initCodeHash; this one is hashed for you.' },
};

/** @param {string} origin */
export function openApi(origin) {
	return {
		openapi: '3.1.0',
		info: {
			title: 'create2-vanity',
			version: '1.0.0',
			summary: 'CREATE2 vanity address grinding, derivation, cross-chain availability and EIP-712 grind attestations.',
			description: SUMMARY,
			license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
			contact: { url: 'https://github.com/nirholas/create2-vanity' },
		},
		servers: [{ url: origin }],
		paths: {
			'/api/health': { get: { summary: 'Service health and issuer identity', operationId: 'health', responses: { 200: { description: 'Status' } } } },
			'/api/derive': {
				post: {
					summary: 'Derive a CREATE2 or CREATE address',
					operationId: 'derive',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								...DEPLOYMENT_PROPS,
								salt: { type: 'string', description: 'The 32-byte salt, for a CREATE2 derivation.' },
								sender: { type: 'string', description: 'For a plain CREATE derivation, the deploying account.' },
								nonce: { type: 'integer', description: 'For a plain CREATE derivation, that account’s nonce.' },
							},
						} } },
					},
					responses: { 200: { description: 'The derived address and the inputs that produce it' }, 400: { description: 'Malformed inputs' } },
				},
			},
			'/api/quote': {
				post: {
					summary: 'Difficulty and rarity for a pattern',
					operationId: 'quote',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ...PATTERN_PROPS, attemptsPerSecond: { type: 'number' } } } } } },
					responses: { 200: { description: 'Quote' }, 400: { description: 'Invalid pattern' } },
				},
			},
			'/api/grind': {
				post: {
					summary: 'Grind a salt server-side',
					description: 'Enabled by default: a salt is a public number and the caller re-derives the address in one keccak, so there is nothing to leak.',
					operationId: 'grind',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ...DEPLOYMENT_PROPS, ...PATTERN_PROPS, timeBudgetMs: { type: 'integer' } } } } } },
					responses: { 200: { description: 'A salt and the address it produces, or found:false when the budget ran out' } },
				},
			},
			'/api/availability': {
				post: {
					summary: 'Is this address free, on every chain',
					operationId: 'availability',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['address'], properties: { address: { type: 'string' }, deployer: { type: 'string' }, chainIds: { type: 'array', items: { type: 'integer' } } } } } } },
					responses: { 200: { description: 'Per-chain availability' } },
				},
			},
			'/api/attest': {
				post: {
					summary: 'Sign an EIP-712 grind attestation',
					operationId: 'attest',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['deployer', 'salt'], properties: { ...DEPLOYMENT_PROPS, salt: { type: 'string' }, ...PATTERN_PROPS, attempts: { type: 'integer' } } } } } },
					responses: { 200: { description: 'Signed attestation' }, 400: { description: 'The derived address does not match the claimed pattern' } },
				},
			},
			'/api/verify': {
				post: {
					summary: 'Verify a grind attestation',
					operationId: 'verifyAttestation',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { attestation: { type: 'object' } } } } } },
					responses: { 200: { description: 'Per-check audit, including the trust-free derivation check' } },
				},
			},
			'/api/chains': { get: { summary: 'Chain and deterministic-deployer registry', operationId: 'chains', responses: { 200: { description: 'Registry' } } } },
		},
	};
}
