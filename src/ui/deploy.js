/**
 * Deploy page.
 *
 * Two jobs the rest of the CREATE2 tooling ecosystem skips:
 *
 *  1. **Availability, before you spend anything.** The same address exists on
 *     every chain with your deployer, but it can already be occupied on one of
 *     them by somebody else's deployment. This checks all of them with
 *     `eth_getCode` first and shows which are free.
 *  2. **A transaction you can inspect.** Deployment through the Arachnid proxy
 *     is `salt ‖ initCode` as raw calldata, so the whole transaction is two
 *     fields, rendered here in full before anything is signed.
 *
 * Wallet access uses the EIP-1193 provider the browser already has. Nothing is
 * signed without an explicit confirmation in the wallet, and this page never
 * asks for, stores or transmits a key.
 */

import { create2Address, arachnidDeployCalldata, initCodeHash, parseHex } from '../create2.js';
import { CHAINS, getChain, hasCode, ARACHNID_PROXY, FACTORY_LABELS } from '../chains.js';
import { eip55Checksum } from '../address.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @type {{ address: string, deployer: string, salt: string, initCode: string|null, initCodeHash: string } | null} */
let deployment = null;
/** An init-code hash handed over without the code behind it. */
let knownHash = null;
/** @type {Map<number, { free: boolean|null, error?: string }>} */
const availability = new Map();
/** @type {any} */
let provider = null;
let account = '';

// The grinder hands the deployment over in the fragment, which never reaches a
// server, so a large init code stays entirely inside the browser.
hydrateFromHash();
['deployer', 'salt', 'initcode'].forEach((id) => $(id).addEventListener('input', recompute));
recompute();

function hydrateFromHash() {
	if (!location.hash.length) return;
	const params = new URLSearchParams(location.hash.slice(1));
	if (params.get('deployer')) $('deployer').value = params.get('deployer');
	if (params.get('salt')) $('salt').value = params.get('salt');
	if (params.get('initCode')) $('initcode').value = params.get('initCode');
	else if (params.get('initCodeHash')) {
		// Arriving with only a hash is normal: the grinder needs nothing more.
		// The address, and therefore the whole availability check, is computable
		// from it; only the deployment itself needs the code behind it.
		knownHash = params.get('initCodeHash');
		$('initcode').placeholder = `optional here: the address is already known from its hash ${knownHash.slice(0, 14)}…, but deploying needs the code itself`;
	}
}

function recompute() {
	const deployer = $('deployer').value.trim();
	const salt = $('salt').value.trim();
	const initCode = $('initcode').value.trim();
	if (initCode) knownHash = null;

	deployment = null;
	$('check').disabled = true;
	$('tx-to').textContent = 'the deployer address';
	$('tx-data').textContent = 'salt ‖ initCode';

	if (!deployer || !salt || (!initCode && !knownHash)) {
		$('derived').textContent = 'enter a deployer, a salt, and either the init code or its hash';
		return;
	}
	try {
		parseHex(deployer, 'deployer', 20);
		parseHex(salt, 'salt', 32);
		const hash = initCode ? initCodeHash(initCode) : knownHash;
		const address = create2Address(deployer, salt, hash);
		deployment = { address, deployer: eip55Checksum(deployer), salt, initCode: initCode || null, initCodeHash: hash };
		$('derived').innerHTML = `<strong>${esc(eip55Checksum(address))}</strong> <span style="color:var(--muted)">from keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)</span>`;
		$('check').disabled = false;
		$('tx-to').textContent = deployment.deployer;
		if (initCode) {
			const calldata = arachnidDeployCalldata(salt, initCode);
			$('tx-data').textContent = calldata.length > 140 ? `${calldata.slice(0, 130)}… (${(calldata.length - 2) / 2} bytes)` : calldata;
		} else {
			$('tx-data').textContent = 'salt ‖ initCode (paste the init code above to build it)';
		}
		renderDeployTargets();
	} catch (err) {
		$('derived').innerHTML = `<span style="color:var(--bad-fg)">${esc(err.message)}</span>`;
	}
}

// ── Availability ─────────────────────────────────────────────────────────────
$('check').addEventListener('click', async () => {
	if (!deployment) return;
	const btn = $('check');
	btn.disabled = true;
	availability.clear();
	let done = 0;
	for (const chain of CHAINS) {
		$('check-status').textContent = `checking ${chain.name}… (${done}/${CHAINS.length})`;
		try {
			const [addressTaken, factoryPresent] = await Promise.all([
				hasCode(chain.rpc, deployment.address, { timeoutMs: 12_000 }),
				hasCode(chain.rpc, deployment.deployer, { timeoutMs: 12_000 }),
			]);
			availability.set(chain.id, { free: !addressTaken, factoryPresent });
		} catch (err) {
			availability.set(chain.id, { free: null, error: err.message });
		}
		done++;
		renderChainTable();
	}
	const taken = [...availability.values()].filter((a) => a.free === false).length;
	$('check-status').textContent = taken
		? `${taken} chain${taken === 1 ? ' has' : 's have'} something at this address already.`
		: 'the address is free everywhere this deployer exists.';
	btn.disabled = false;
	renderDeployTargets();
});

function renderChainTable() {
	if (!deployment) return;
	$('chain-table').innerHTML = `
		<table class="api">
			<thead><tr><th>Chain</th><th>Address</th><th>Deployer</th><th></th></tr></thead>
			<tbody>
				${CHAINS.map((chain) => {
					const state = availability.get(chain.id);
					let status = '<span style="color:#666">not checked</span>';
					if (state?.free === true) status = '<span style="color:#4ade80">free</span>';
					else if (state?.free === false) status = '<span style="color:#f87171">occupied</span>';
					else if (state && state.free === null) status = `<span style="color:var(--warn-fg)">RPC unreachable</span>`;
					const factory = state?.factoryPresent === false
						? '<span style="color:var(--warn-fg)">deployer missing</span>'
						: state?.factoryPresent === true ? '<span style="color:#4ade80">present</span>' : '<span style="color:#666">-</span>';
					return `<tr>
						<td>${esc(chain.name)}${chain.testnet ? ' <span style="color:#666">(testnet)</span>' : ''}</td>
						<td>${status}</td>
						<td>${factory}</td>
						<td><a href="${esc(chain.explorer)}/address/${esc(deployment.address)}" rel="noopener">explorer</a></td>
					</tr>`;
				}).join('')}
			</tbody>
		</table>`;
}

// ── Wallet ───────────────────────────────────────────────────────────────────
$('connect').addEventListener('click', async () => {
	const injected = window.ethereum;
	if (!injected) {
		showDeployError('No EIP-1193 wallet found in this browser. The transaction fields below are complete: send it from any wallet, script or multisig.');
		return;
	}
	try {
		provider = injected;
		const accounts = await provider.request({ method: 'eth_requestAccounts' });
		account = accounts?.[0] || '';
		$('account').textContent = account ? eip55Checksum(account) : '';
		$('connect').textContent = 'Connected';
		renderDeployTargets();
	} catch (err) {
		showDeployError(err.message || 'the wallet refused the connection');
	}
});

function renderDeployTargets() {
	if (!deployment) {
		$('deploy-host').innerHTML = '';
		return;
	}
	const usesArachnid = deployment.deployer.toLowerCase() === ARACHNID_PROXY;
	if (!usesArachnid) {
		$('deploy-host').innerHTML = `
			<div class="warnbox show">
				<strong>${esc(FACTORY_LABELS[deployment.deployer.toLowerCase()] || 'This deployer')}</strong> is not the Arachnid proxy, so its deploy call is not
				<code>salt ‖ initCode</code>. The address above is still correct; use that factory's own ABI to deploy to it.
			</div>`;
		return;
	}
	if (!deployment.initCode) {
		$('deploy-host').innerHTML = `
			<div class="warnbox show">
				The address above is derived from the init-code <em>hash</em>, which is all the grinder needs. Deploying needs the code
				itself: paste the init code (deploy bytecode with the ABI-encoded constructor arguments appended) into the field above.
			</div>`;
		return;
	}
	if (!account) {
		$('deploy-host').innerHTML = '<p class="desc" style="margin:0">Connect a wallet to deploy from this page, or send the transaction below yourself.</p>';
		return;
	}

	$('deploy-host').innerHTML = `
		<div class="chain-grid">
			${CHAINS.filter((c) => c.factories[ARACHNID_PROXY]).map((chain) => {
				const state = availability.get(chain.id);
				const blocked = state?.free === false;
				return `<button class="btn deploy-target" type="button" data-chain="${chain.id}" ${blocked ? 'disabled' : ''}>
					${esc(chain.name)}${blocked ? ' <span style="color:#f87171">occupied</span>' : ''}
				</button>`;
			}).join('')}
		</div>
		<div id="deploy-log" style="margin-top:.8rem"></div>`;

	$('deploy-host').querySelectorAll('.deploy-target').forEach((b) => {
		b.addEventListener('click', () => deployTo(Number(b.dataset.chain)));
	});
}

/**
 * Switch the wallet to a chain and send the deployment.
 *
 * The availability check is repeated immediately before sending, because the
 * table can be minutes old by the time somebody clicks, and a deploy into an
 * occupied address is a wasted fee at best.
 * @param {number} chainId
 */
async function deployTo(chainId) {
	const chain = getChain(chainId);
	if (!chain || !deployment || !provider) return;
	$('deploy-error').hidden = true;
	const log = $('deploy-log');
	log.innerHTML = `<div class="okbox show">checking ${esc(chain.name)} one more time…</div>`;

	try {
		if (await hasCode(chain.rpc, deployment.address, { timeoutMs: 12_000 })) {
			log.innerHTML = `<div class="errbox show">${esc(chain.name)} already has code at ${esc(deployment.address)}. Nothing was sent.</div>`;
			availability.set(chainId, { free: false });
			renderChainTable();
			return;
		}

		const hexChainId = `0x${chainId.toString(16)}`;
		try {
			await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
		} catch (err) {
			// 4902 means the wallet does not know this chain yet; offer to add it
			// from the registry rather than dead-ending.
			if (err?.code === 4902) {
				await provider.request({
					method: 'wallet_addEthereumChain',
					params: [{
						chainId: hexChainId,
						chainName: chain.name,
						rpcUrls: [chain.rpc],
						blockExplorerUrls: [chain.explorer],
						nativeCurrency: { name: chain.currency, symbol: chain.currency, decimals: 18 },
					}],
				});
			} else {
				throw err;
			}
		}

		log.innerHTML = `<div class="okbox show">confirm the transaction in your wallet…</div>`;
		const hash = await provider.request({
			method: 'eth_sendTransaction',
			params: [{
				from: account,
				to: deployment.deployer,
				data: arachnidDeployCalldata(deployment.salt, deployment.initCode),
				value: '0x0',
			}],
		});

		log.innerHTML = `
			<div class="okbox show">
				Sent on ${esc(chain.name)}.
				<a href="${esc(chain.explorer)}/tx/${esc(hash)}" rel="noopener">${esc(hash.slice(0, 18))}…</a>
				<div style="margin-top:.4rem">Waiting for code at ${esc(eip55Checksum(deployment.address))}…</div>
			</div>`;

		// Confirm by looking for code at the predicted address rather than by
		// trusting the receipt: the point of the whole exercise is that address.
		const landed = await waitForCode(chain.rpc, deployment.address);
		log.innerHTML = landed
			? `<div class="okbox show">
					<strong>Deployed.</strong> ${esc(chain.name)} now has code at
					<a href="${esc(chain.explorer)}/address/${esc(deployment.address)}" rel="noopener">${esc(eip55Checksum(deployment.address))}</a>.
				</div>`
			: `<div class="warnbox show">
					Transaction sent, but no code at the address yet. It may still be pending:
					<a href="${esc(chain.explorer)}/tx/${esc(hash)}" rel="noopener">check the transaction</a>.
				</div>`;
		availability.set(chainId, { free: !landed, factoryPresent: true });
		renderChainTable();
		renderDeployTargets();
	} catch (err) {
		// 4001 is the user rejecting in the wallet, which is not an error worth
		// shouting about.
		if (err?.code === 4001) {
			log.innerHTML = '<div class="warnbox show">Cancelled in the wallet. Nothing was sent.</div>';
			return;
		}
		showDeployError(err?.message || String(err));
		log.innerHTML = '';
	}
}

/**
 * Poll for code at an address, for up to about a minute.
 * @param {string} rpc
 * @param {string} address
 * @returns {Promise<boolean>}
 */
async function waitForCode(rpc, address) {
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		try {
			if (await hasCode(rpc, address, { timeoutMs: 8000 })) return true;
		} catch {
			// A flaky public RPC mid-poll is not a failed deployment; keep trying.
		}
	}
	return false;
}

/** @param {string} message */
function showDeployError(message) {
	$('deploy-error').textContent = message;
	$('deploy-error').hidden = false;
}
