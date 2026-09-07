/**
 * EVM chain registry.
 *
 * A vanity EOA works on every EVM chain at once, because the address is derived
 * from the key and nothing else: one grind, every network. What differs per
 * chain is where you look the address up, and which deterministic deployers are
 * present if you later want a *contract* at a vanity address too.
 *
 * `factories` records which CREATE2 deployers are live on each chain, so the UI
 * can tell you the truth instead of assuming. Every entry was confirmed by an
 * `eth_getCode` against the listed RPC on 2026-09-07, and `probeFactories`
 * re-runs that check, so the claim can be re-verified rather than trusted.
 * `tests/chains.test.js` runs it against Base, Arbitrum and Robinhood Chain.
 */

/** The Arachnid deterministic-deployment-proxy: `salt ‖ initCode` as calldata. */
export const ARACHNID_PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
/** CreateX, a richer deterministic factory with guarded and permissioned modes. */
export const CREATEX = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed';
/** Safe (Gnosis) proxy factory v1.4.1. */
export const SAFE_FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
/** Coinbase Smart Wallet factory. */
export const COINBASE_SW = '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a';

export const FACTORY_LABELS = Object.freeze({
	[ARACHNID_PROXY]: 'Arachnid deterministic-deployment-proxy',
	[CREATEX]: 'CreateX',
	[SAFE_FACTORY]: 'Safe proxy factory v1.4.1',
	[COINBASE_SW]: 'Coinbase Smart Wallet factory',
});

/**
 * @typedef {object} ChainMeta
 * @property {number} id EIP-155 chain id
 * @property {string} name
 * @property {string} shortName matches the eip155 chain registry
 * @property {string} rpc a public endpoint
 * @property {string} explorer base URL, no trailing slash
 * @property {string} currency native symbol
 * @property {boolean} [testnet]
 * @property {Record<string, boolean>} factories deployer presence, keyed by lowercase address
 */

/** @type {ChainMeta[]} */
export const CHAINS = [
	{
		id: 1, name: 'Ethereum', shortName: 'eth',
		rpc: 'https://ethereum-rpc.publicnode.com',
		explorer: 'https://etherscan.io',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 8453, name: 'Base', shortName: 'base',
		rpc: 'https://mainnet.base.org',
		explorer: 'https://basescan.org',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 42161, name: 'Arbitrum One', shortName: 'arb1',
		rpc: 'https://arb1.arbitrum.io/rpc',
		explorer: 'https://arbiscan.io',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 4663, name: 'Robinhood Chain', shortName: 'rhc',
		rpc: 'https://rpc.mainnet.chain.robinhood.com',
		explorer: 'https://robinhoodchain.blockscout.com',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 10, name: 'OP Mainnet', shortName: 'oeth',
		rpc: 'https://mainnet.optimism.io',
		explorer: 'https://optimistic.etherscan.io',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 137, name: 'Polygon', shortName: 'matic',
		rpc: 'https://polygon-bor-rpc.publicnode.com',
		explorer: 'https://polygonscan.com',
		currency: 'POL',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 56, name: 'BNB Chain', shortName: 'bnb',
		rpc: 'https://bsc-dataseed.bnbchain.org',
		explorer: 'https://bscscan.com',
		currency: 'BNB',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 43114, name: 'Avalanche C-Chain', shortName: 'avax',
		rpc: 'https://api.avax.network/ext/bc/C/rpc',
		explorer: 'https://snowtrace.io',
		currency: 'AVAX',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 11155111, name: 'Sepolia', shortName: 'sep', testnet: true,
		rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
		explorer: 'https://sepolia.etherscan.io',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 84532, name: 'Base Sepolia', shortName: 'basesep', testnet: true,
		rpc: 'https://sepolia.base.org',
		explorer: 'https://sepolia.basescan.org',
		currency: 'ETH',
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true, [COINBASE_SW]: true },
	},
	{
		id: 46630, name: 'Robinhood Chain Testnet', shortName: 'rhc-test', testnet: true,
		rpc: 'https://rpc.testnet.chain.robinhood.com',
		explorer: 'https://explorer.testnet.chain.robinhood.com',
		currency: 'ETH',
		// The Coinbase Smart Wallet factory is the one deployer missing here.
		factories: { [ARACHNID_PROXY]: true, [CREATEX]: true, [SAFE_FACTORY]: true },
	},
];

/** @param {number} id @returns {ChainMeta|undefined} */
export function getChain(id) {
	return CHAINS.find((c) => c.id === Number(id));
}

/** Chains where a given factory is deployed. @param {string} factory @returns {ChainMeta[]} */
export function chainsWithFactory(factory) {
	const key = String(factory || '').toLowerCase();
	return CHAINS.filter((c) => c.factories[key]);
}

/** @param {number} id @param {string} address @returns {string} */
export function addressUrl(id, address) {
	const chain = getChain(id);
	return chain ? `${chain.explorer}/address/${address}` : '';
}

/** @param {number} id @param {string} hash @returns {string} */
export function txUrl(id, hash) {
	const chain = getChain(id);
	return chain ? `${chain.explorer}/tx/${hash}` : '';
}

/**
 * Ask a chain whether an address holds code.
 *
 * Used to re-verify the `factories` table above rather than asking anyone to
 * take it on faith, and to check for a collision before deploying to a
 * predicted CREATE2 address.
 *
 * @param {string} rpc
 * @param {string} address
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<boolean>}
 */
export async function hasCode(rpc, address, opts = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
	try {
		const res = await (opts.fetchImpl || fetch)(rpc, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`RPC ${res.status}`);
		const data = await res.json();
		if (data.error) throw new Error(data.error.message || 'RPC error');
		return typeof data.result === 'string' && data.result !== '0x' && data.result.length > 2;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Re-verify the factory table for one chain against its live RPC.
 *
 * @param {ChainMeta} chain
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ factory: string, label: string, claimed: boolean, actual: boolean|null, agrees: boolean, error?: string }>>}
 */
export async function probeFactories(chain, opts = {}) {
	const results = [];
	for (const factory of Object.keys(FACTORY_LABELS)) {
		const claimed = !!chain.factories[factory];
		try {
			const actual = await hasCode(chain.rpc, factory, opts);
			results.push({ factory, label: FACTORY_LABELS[factory], claimed, actual, agrees: claimed === actual });
		} catch (err) {
			results.push({ factory, label: FACTORY_LABELS[factory], claimed, actual: null, agrees: false, error: err.message });
		}
	}
	return results;
}
