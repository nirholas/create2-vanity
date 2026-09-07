/**
 * Verification page.
 *
 * Two independent things: re-deriving a CREATE2 address (which needs nobody's
 * signature and nobody's permission) and checking a signed grind attestation
 * against the issuer list this service publishes.
 *
 * The first is the one that matters. A claim about a CREATE2 address is either
 * true or provably false in one keccak, which is a guarantee no wallet-grinding
 * tool can offer.
 */

import { create2Address } from '../create2.js';
import { eip55Checksum } from '../address.js';
import { verifyAttestation } from '../attestation.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @type {string[] | null} */
let issuers = null;
let issuerError = '';
loadIssuers();

async function loadIssuers() {
	try {
		const r = await fetch('/.well-known/create2-vanity.json');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		issuers = Array.isArray(data.issuers) ? data.issuers.map((i) => i.address) : null;
		if (!issuers?.length) throw new Error('no issuers published');
	} catch (e) {
		issuerError = e.message;
	}
}

// ── Derivation ───────────────────────────────────────────────────────────────
$('derive').addEventListener('click', () => {
	$('derive-err').hidden = true;
	$('derive-out').hidden = true;
	try {
		const address = create2Address($('deployer').value.trim(), $('salt').value.trim(), $('ich').value.trim());
		const expected = $('expected').value.trim();
		const matches = expected ? expected.toLowerCase() === address.toLowerCase() : null;

		$('derive-out').hidden = false;
		$('derive-out').innerHTML = `
			<div class="result" style="border-color:${matches === false ? 'rgba(248,113,113,.35)' : 'rgba(52,211,153,.3)'};background:${matches === false ? 'rgba(248,113,113,.05)' : 'rgba(52,211,153,.05)'}">
				<h3>${matches === false ? '✗ These inputs do not produce that address' : '✓ Derived'}</h3>
				<div class="out-row"><span class="k">Address</span><span class="v">${esc(eip55Checksum(address))}</span></div>
				${expected ? `<div class="out-row"><span class="k">Expected</span><span class="v">${esc(expected)}</span></div>` : ''}
				<div class="meta">keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)[12:]</div>
			</div>`;
	} catch (err) {
		$('derive-err').textContent = err.message;
		$('derive-err').hidden = false;
	}
});

// ── Attestation ──────────────────────────────────────────────────────────────
$('file').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	$('cert').value = await file.text();
	verify();
});

$('verify').addEventListener('click', verify);

function verify() {
	$('err').hidden = true;
	$('out').hidden = true;

	let doc;
	try {
		doc = JSON.parse($('cert').value);
	} catch {
		$('err').textContent = 'That is not valid JSON. Paste the whole attestation, including the outer braces.';
		$('err').hidden = false;
		return;
	}
	if (doc && doc.attestation && typeof doc.attestation === 'object') doc = doc.attestation;

	const result = verifyAttestation(doc, issuers ? { issuers } : {});
	const passed = result.checks.filter((c) => c.pass).length;
	const derivation = result.checks.find((c) => c.id === 'derivation');

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result" style="border-color:${result.valid ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.35)'};background:${result.valid ? 'rgba(52,211,153,.05)' : 'rgba(248,113,113,.05)'}">
			<h3 style="color:${result.valid ? '#34d399' : '#f87171'}">
				${result.valid ? `✓ Valid: ${passed}/${result.checks.length} checks passed` : `✗ Not valid: ${result.checks.length - passed} check${result.checks.length - passed === 1 ? '' : 's'} failed`}
			</h3>
			<div class="out-row"><span class="k">Account</span><span class="v">${esc(result.account || 'not present')}</span></div>
			<div class="out-row"><span class="k">Signer</span><span class="v">${esc(result.issuer || 'not recovered')}</span></div>
			${derivation ? `<p class="desc" style="margin:.7rem 0 .3rem">
				The derivation check is the one that needs no trust at all, and it ${derivation.pass ? 'passed' : '<strong style="color:#f87171">failed</strong>'}.
			</p>` : ''}
			${result.checks.map((c) => `
				<div class="kv">
					<span class="k">${c.pass ? '<span style="color:#34d399">✓</span>' : '<span style="color:#f87171">✗</span>'} ${esc(c.label)}</span>
					<span class="v" style="font-weight:400;font-size:.74rem;color:#999;text-align:right;max-width:58%">${esc(c.detail)}</span>
				</div>`).join('')}
			${issuers ? '' : `<p class="desc" style="color:var(--warn-fg);margin-top:.7rem">
				The published issuer list could not be loaded${issuerError ? ` (${esc(issuerError)})` : ''}, so the signature was checked without a pin.
				The derivation check above is unaffected: it needs no issuer.
			</p>`}
		</div>`;
}
