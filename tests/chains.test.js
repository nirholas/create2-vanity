/**
 * The chain registry claims which deterministic deployers are live where. A
 * claim nobody checks rots, so this test asks the chains themselves.
 *
 * It needs network access. When an RPC is unreachable the test reports that and
 * passes, because a public endpoint being rate-limited is not a defect in this
 * repository; a chain that answers and *disagrees* is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAINS, getChain, chainsWithFactory, probeFactories, addressUrl, txUrl, ARACHNID_PROXY } from '../src/chains.js';

test('the registry is well-formed', () => {
	const ids = new Set();
	for (const chain of CHAINS) {
		assert.ok(Number.isInteger(chain.id) && chain.id > 0, `${chain.name} has a bad id`);
		assert.ok(!ids.has(chain.id), `duplicate chain id ${chain.id}`);
		ids.add(chain.id);
		assert.match(chain.rpc, /^https:\/\//);
		assert.match(chain.explorer, /^https:\/\//);
		assert.ok(!chain.explorer.endsWith('/'), `${chain.name} explorer has a trailing slash`);
		assert.ok(Object.keys(chain.factories).length > 0);
		for (const key of Object.keys(chain.factories)) {
			assert.equal(key, key.toLowerCase(), 'factory keys must be lowercase for lookup');
		}
	}
	assert.ok(ids.has(4663), 'Robinhood Chain must be in the registry');
	assert.equal(getChain(8453).name, 'Base');
	assert.ok(chainsWithFactory(ARACHNID_PROXY).length >= 10);
	assert.equal(addressUrl(1, '0xabc'), 'https://etherscan.io/address/0xabc');
	assert.equal(txUrl(4663, '0xdef'), 'https://robinhoodchain.blockscout.com/tx/0xdef');
	assert.equal(addressUrl(999999, '0xabc'), '');
});

test('the deployer table agrees with the live chains', { timeout: 120_000 }, async () => {
	const unreachable = [];
	const disagreements = [];

	for (const chain of [getChain(8453), getChain(42161), getChain(4663)]) {
		let rows;
		try {
			rows = await probeFactories(chain, { timeoutMs: 15_000 });
		} catch (err) {
			unreachable.push(`${chain.name}: ${err.message}`);
			continue;
		}
		for (const row of rows) {
			if (row.actual === null) unreachable.push(`${chain.name}/${row.label}: ${row.error}`);
			else if (!row.agrees) disagreements.push(`${chain.name}: ${row.label} claimed ${row.claimed}, chain says ${row.actual}`);
		}
	}

	if (unreachable.length) console.log(`  (${unreachable.length} probes could not reach an RPC: ${unreachable[0]})`);
	assert.deepEqual(disagreements, [], 'the registry disagrees with a live chain');
});
