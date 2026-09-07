/**
 * Grinder page controller.
 *
 * Owns the deployer and init-code inputs, the pattern, the core selector and
 * the salt search. The search itself runs in `../grinder.js`, which races one
 * Web Worker per selected core over the CREATE2 preimage.
 *
 * Nothing here is secret. A salt is a public number, and the address it produces
 * is one keccak away, which is why this page can hand the result straight to the
 * deploy page and to an attestation without any of the custody hedging a wallet
 * grinder needs.
 */

import { grindCreate2Vanity } from '../grinder.js';
import { validatePattern, validateAddress, validateInitCodeHash, MAX_PATTERN_LENGTH } from '../validation.js';
import { PRESET_CHIPS } from '../wordlist.js';
import { difficulty, rarity, formatAttempts, normalizePattern } from '../difficulty.js';
import { initCodeHash, readArtifact, constructorInputs, describeDeployment } from '../create2.js';
import { FACTORY_LABELS, ARACHNID_PROXY, CREATEX, SAFE_FACTORY, COINBASE_SW } from '../chains.js';
import { setGrindActivity } from './activity.js';
import { mountHero } from './hero.js';

const $ = (id) => document.getElementById(id);
const HEX_ALPHA = '0123456789abcdef';

/**
 * The hero strip: a candidate address, one quad per character, driven by the
 * same pattern and rate as the read-outs beside it. The cells the pattern covers
 * hold the characters that were asked for; the rest churn at the measured attempt
 * rate and lock to the real address when one is found.
 */
const heroStrip = mountHero(document.getElementById('hero'), {
	alphabet: HEX_ALPHA,
	length: 40,
	accent: '#34d399',
	accentAlt: '#2dd4bf',
});

/** Measured order of magnitude for one keccak over 85 bytes in a worker. */
const RATE_PER_CORE = 60_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Deployer presets ─────────────────────────────────────────────────────────
const DEPLOYERS = [
	{ address: ARACHNID_PROXY, label: 'Arachnid proxy', deployable: true },
	{ address: CREATEX, label: 'CreateX', deployable: false },
	{ address: SAFE_FACTORY, label: 'Safe v1.4.1', deployable: false },
	{ address: COINBASE_SW, label: 'Coinbase Smart Wallet', deployable: false },
];

$('deployer-presets').innerHTML = DEPLOYERS
	.map((d) => `<button class="preset" type="button" data-deployer="${d.address}" title="${esc(FACTORY_LABELS[d.address] || d.label)}">${esc(d.label)}</button>`)
	.join('');
$('deployer-presets').querySelectorAll('.preset').forEach((b) => {
	b.addEventListener('click', () => {
		$('deployer').value = b.dataset.deployer;
		$('deployer').dispatchEvent(new Event('input'));
	});
});

function describeDeployer(value) {
	const known = DEPLOYERS.find((d) => d.address.toLowerCase() === value.toLowerCase());
	if (!known) return '';
	return known.deployable
		? 'Any wallet can deploy through this one: the calldata is just <code>salt ‖ initCode</code>, no ABI needed.'
		: `This factory needs its own ABI to deploy through. The address you grind is still correct; the deploy call is not <code>salt ‖ initCode</code>.`;
}

// ── Core selection ───────────────────────────────────────────────────────────
const HW_CORES = Math.max(1, navigator.hardwareConcurrency || 4);
const DEFAULT_CORES = Math.max(1, Math.min(HW_CORES, Math.round(HW_CORES / 2) || 1));
let cores = DEFAULT_CORES;

const coreSlider = $('core-count');
coreSlider.max = String(HW_CORES);
coreSlider.value = String(DEFAULT_CORES);
$('core-max').textContent = HW_CORES;
$('core-count-val').textContent = DEFAULT_CORES;
$('cores2').textContent = DEFAULT_CORES;

const presetVals = [...new Set([1, DEFAULT_CORES, HW_CORES])].sort((a, b) => a - b);
$('core-ticks').innerHTML = presetVals
	.map((n) => `<button type="button" data-cores="${n}" aria-pressed="${n === DEFAULT_CORES}">${n === 1 ? '1 core' : n === HW_CORES ? `Max (${n})` : n}</button>`)
	.join('');

function setCores(n) {
	cores = Math.max(1, Math.min(HW_CORES, n | 0));
	coreSlider.value = String(cores);
	$('core-count-val').textContent = cores;
	$('cores2').textContent = cores;
	$('core-ticks').querySelectorAll('button').forEach((b) => {
		b.setAttribute('aria-pressed', String(Number(b.dataset.cores) === cores));
	});
	refreshChipEstimates();
	update();
}
coreSlider.addEventListener('input', () => setCores(Number(coreSlider.value)));
$('core-ticks').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setCores(Number(b.dataset.cores))));

// ── Formatting ───────────────────────────────────────────────────────────────
function sample(prefix = '', suffix = '') {
	const fill = Math.max(0, 40 - prefix.length - suffix.length);
	let mid = '';
	for (let i = 0; i < fill; i++) mid += HEX_ALPHA[Math.floor(Math.random() * 16)];
	return prefix + mid + suffix;
}

function fmtTime(seconds) {
	if (!Number.isFinite(seconds)) return 'never';
	if (seconds < 1) return '<1s';
	if (seconds < 60) return `~${Math.round(seconds)}s`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)}h`;
	if (seconds < 31536000) return `~${Math.round(seconds / 86400)}d`;
	return '>1y';
}

function estSeconds(pattern) {
	const p = normalizePattern(pattern);
	if (!p.length) return 0;
	const d = difficulty(pattern);
	// EIP-55 mode pays an extra keccak per attempt, so the hot loop is ~30% slower.
	return d.p50 / ((p.caseSensitive ? RATE_PER_CORE * 0.7 : RATE_PER_CORE) * cores);
}

function heatLevel(seconds) {
	if (seconds <= 0) return 0;
	if (seconds < 5) return 1;
	if (seconds < 30) return 2;
	if (seconds < 120) return 3;
	if (seconds < 600) return 4;
	if (seconds < 3600) return 5;
	return 6;
}

// ── Wordlist chips ───────────────────────────────────────────────────────────
const chipsEl = $('word-chips');
PRESET_CHIPS.forEach((w) => {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'preset';
	b.dataset.word = w;
	b.innerHTML = `${esc(w)}<span class="chip-est"></span>`;
	b.addEventListener('click', () => {
		$('prefix').value = w;
		$('prefix').dispatchEvent(new Event('input'));
		$('prefix').focus();
	});
	chipsEl.appendChild(b);
});

function refreshChipEstimates() {
	chipsEl.querySelectorAll('.preset').forEach((c) => {
		const est = c.querySelector('.chip-est');
		if (est) est.textContent = ' ' + fmtTime(estSeconds({ prefix: c.dataset.word || '' }));
	});
}

// ── Init code ────────────────────────────────────────────────────────────────
$('initcode-raw').addEventListener('input', () => {
	const raw = $('initcode-raw').value.trim();
	if (!raw) return;
	try {
		$('initcode-hash').value = initCodeHash(raw);
		$('initcode-hash').classList.remove('invalid');
	} catch (err) {
		$('initcode-hash').value = '';
		$('artifact-note').textContent = err.message;
	}
	update();
});

$('artifact').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	try {
		const artifact = JSON.parse(await file.text());
		const { bytecode, contractName, abi } = readArtifact(artifact);
		$('initcode-raw').value = bytecode;
		$('initcode-hash').value = initCodeHash(bytecode);

		const inputs = constructorInputs(abi);
		$('ctor-host').innerHTML = inputs.length
			? `<div class="warnbox show" style="margin-top:.7rem">
					<strong>${esc(contractName || 'This contract')} takes ${inputs.length} constructor argument${inputs.length === 1 ? '' : 's'}</strong>
					(${inputs.map((i) => `<code>${esc(i.type)}${i.name ? ` ${esc(i.name)}` : ''}</code>`).join(', ')}).
					The bytecode above is the deploy code alone. Append the ABI-encoded arguments before grinding, or the address you find
					will not be the address you deploy to.
				</div>`
			: '';
		$('artifact-note').textContent = `${contractName || 'contract'}: ${(bytecode.length - 2) / 2} bytes of deploy code${inputs.length ? ', constructor arguments still needed' : ''}`;
		update();
	} catch (err) {
		$('artifact-note').textContent = err.message;
	}
});

// ── Validation and preview ───────────────────────────────────────────────────
function readPattern() {
	return { prefix: $('prefix').value.trim().replace(/^0x/i, ''), suffix: $('suffix').value.trim() };
}

let previewLoop = null;
function startPreviewLoop() {
	stopPreviewLoop();
	previewLoop = setInterval(() => {
		const { prefix, suffix } = readPattern();
		if (!prefix && !suffix) return;
		if ($('prefix').classList.contains('invalid') || $('suffix').classList.contains('invalid')) return;
		const rest = $('preview').querySelector('.rest:last-of-type');
		if (rest) rest.textContent = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
	}, 700);
}
function stopPreviewLoop() {
	if (previewLoop) clearInterval(previewLoop);
	previewLoop = null;
}

function inputsReady() {
	const deployer = validateAddress($('deployer').value);
	const hash = validateInitCodeHash($('initcode-hash').value);
	$('deployer').classList.toggle('invalid', !!$('deployer').value.trim() && !deployer.valid);
	$('initcode-hash').classList.toggle('invalid', !!$('initcode-hash').value.trim() && !hash.valid);
	return { deployer, hash };
}

function update() {
	const { prefix, suffix } = readPattern();
	const patternOk = [prefix, suffix].every((v) => !v || (v.length <= MAX_PATTERN_LENGTH && /^[0-9a-fA-F]+$/.test(v)));
	$('prefix').classList.toggle('invalid', !!prefix && !(prefix.length <= MAX_PATTERN_LENGTH && /^[0-9a-fA-F]+$/.test(prefix)));
	$('suffix').classList.toggle('invalid', !!suffix && !(suffix.length <= MAX_PATTERN_LENGTH && /^[0-9a-fA-F]+$/.test(suffix)));

	$('deployer-note').innerHTML = describeDeployer($('deployer').value.trim());

	const p = normalizePattern({ prefix, suffix });
	const seconds = estSeconds({ prefix, suffix });
	const heat = heatLevel(seconds);
	document.querySelectorAll('.meter .seg').forEach((seg, i) => {
		seg.className = 'seg' + (i < heat ? ` lit-${heat}` : '');
	});

	$('case-tag').innerHTML = p.length && patternOk
		? (p.caseSensitive
			? `<span class="case-tag case-cs">EIP-55 · ${Math.pow(2, p.letters)}x harder</span>`
			: '<span class="case-tag case-ci">case-insensitive</span>')
		: '';

	if (!p.length) {
		heroStrip.setPattern('', '');
		$('preview').innerHTML = `<span class="rest">0x</span><span class="rest">${esc(sample())}</span>`;
		$('est').textContent = 'type a pattern to see estimated time';
		$('tier').innerHTML = '';
		$('grind').disabled = true;
		return;
	}
	if (!patternOk) {
		$('preview').textContent = `invalid: hex only (0-9, a-f), max ${MAX_PATTERN_LENGTH} characters each`;
		$('est').textContent = '';
		$('tier').innerHTML = '';
		$('grind').disabled = true;
		return;
	}

	const mid = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
	$('preview').innerHTML =
		'<span class="rest">0x</span>' +
		(prefix ? `<span class="pfx">${esc(prefix)}</span>` : '') +
		`<span class="rest">${esc(mid)}</span>` +
		(suffix ? `<span class="sfx">${esc(suffix)}</span>` : '');

	heroStrip.setPattern(prefix, suffix);
	const d = difficulty({ prefix, suffix });
	const r = rarity({ prefix, suffix });
	$('est').textContent = `${formatAttempts(d.p50)} salts for an even chance · ${fmtTime(seconds)} on ${cores} cores`;
	$('tier').innerHTML = `<span class="tier-tag ${heat >= 4 ? 'tier-paid' : 'tier-free'}">${esc(r.label)}</span>`;

	const { deployer, hash } = inputsReady();
	$('grind').disabled = !(deployer.valid && hash.valid);
	if (!deployer.valid || !hash.valid) {
		$('est').textContent += deployer.valid ? ' · needs an init-code hash' : ' · needs a deployer address';
	}
}

['deployer', 'initcode-hash', 'prefix', 'suffix'].forEach((id) => $(id).addEventListener('input', update));
[$('prefix'), $('suffix')].forEach((el) => el.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !$('grind').disabled) $('grind').click();
}));
refreshChipEstimates();
update();
startPreviewLoop();

// ── Grind ────────────────────────────────────────────────────────────────────
let abort = null;
let controls = null;
let scanLoop = null;

function setPaused(paused) {
	$('pause').textContent = paused ? 'Resume' : 'Pause';
	$('pause').classList.toggle('primary', paused);
	$('paused-tag').hidden = !paused;
	$('progress').classList.toggle('paused', paused);
	setGrindActivity(paused ? 0 : 1);
}

function endGrindUI() {
	if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	$('pause').hidden = true;
	$('cancel').hidden = true;
	setPaused(false);
	coreSlider.disabled = false;
	$('core-ticks').querySelectorAll('button').forEach((b) => { b.disabled = false; });
	setGrindActivity(0);
	heroStrip.setActivity(0);
}

function showError(message) {
	$('error').textContent = message;
	$('error').hidden = false;
}

$('grind').addEventListener('click', async () => {
	const { prefix, suffix } = readPattern();
	const deployer = validateAddress($('deployer').value);
	const hash = validateInitCodeHash($('initcode-hash').value);
	if (!deployer.valid) return showError(`deployer: ${deployer.error}`);
	if (!hash.valid) return showError(`init code hash: ${hash.error}`);
	if (prefix) { const v = validatePattern(prefix); if (!v.valid) return showError(`prefix: ${v.errors.join('; ')}`); }
	if (suffix) { const v = validatePattern(suffix); if (!v.valid) return showError(`suffix: ${v.errors.join('; ')}`); }

	$('grind').hidden = true;
	$('pause').hidden = false;
	$('cancel').hidden = false;
	setPaused(false);
	coreSlider.disabled = true;
	$('core-ticks').querySelectorAll('button').forEach((b) => { b.disabled = true; });
	$('progress').hidden = false;
	$('result').hidden = true;
	$('error').hidden = true;
	$('attempts').textContent = '0';
	$('rate').textContent = '0/s';
	$('cores2').textContent = cores;
	$('eta').textContent = fmtTime(estSeconds({ prefix, suffix }));
	stopPreviewLoop();

	scanLoop = setInterval(() => {
		if (controls?.paused) return;
		const mid = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
		$('scan').innerHTML =
			'<span style="color:#555">0x</span>' +
			(prefix ? `<span class="pfx">${esc(prefix)}</span>` : '') +
			`<span style="color:#555">${esc(mid)}</span>` +
			(suffix ? `<span class="sfx">${esc(suffix)}</span>` : '');
	}, 100);

	abort = new AbortController();
	controls = {};
	heroStrip.reset();
	heroStrip.setPattern(prefix, suffix);
	try {
		const result = await grindCreate2Vanity({
			deployer: deployer.normalized,
			initCodeHash: hash.normalized,
			prefix: prefix || undefined,
			suffix: suffix || undefined,
			maxWorkers: cores,
			controller: controls,
			signal: abort.signal,
			onProgress: ({ attempts, rate, eta, paused }) => {
				$('attempts').textContent = attempts.toLocaleString();
				$('rate').textContent = paused ? 'paused' : `${Math.round(rate).toLocaleString()}/s`;
				$('eta').textContent = eta;
				const load = paused ? 0 : Math.min(1, rate / (RATE_PER_CORE * cores));
				setGrindActivity(load);
				heroStrip.setActivity(load);
			},
		});
		renderResult(result, { prefix, suffix }, deployer.normalized, hash.normalized);
	} catch (err) {
		endGrindUI();
		if (err?.name !== 'AbortError') showError(`Grind failed: ${err.message || err}`);
		$('grind').hidden = false;
		$('progress').hidden = true;
		startPreviewLoop();
	} finally {
		controls = null;
		if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	}
});

$('pause').addEventListener('click', () => {
	if (!controls) return;
	if (controls.paused) { controls.resume(); setPaused(false); }
	else { controls.pause(); setPaused(true); }
});
$('cancel').addEventListener('click', () => abort?.abort());

// ── Result ───────────────────────────────────────────────────────────────────
function renderResult(result, pattern, deployer, hash) {
	endGrindUI();
	$('grind').hidden = false;
	$('grind').textContent = 'Grind another';
	$('progress').hidden = true;

	const initCode = $('initcode-raw').value.trim();
	const deployment = describeDeployment({
		deployer,
		salt: result.salt,
		initCodeHash: hash,
		initCode: initCode || undefined,
	});

	const body = deployment.addressChecksum.slice(2);
	const head = pattern.prefix ? `<span class="pfx">${esc(body.slice(0, pattern.prefix.length))}</span>` : '';
	const tail = pattern.suffix ? `<span class="sfx">${esc(body.slice(body.length - pattern.suffix.length))}</span>` : '';
	const mid = body.slice(pattern.prefix.length, body.length - pattern.suffix.length);
	const rate = Math.round(result.attempts / (result.durationMs / 1000));
	const r = rarity(pattern);
	// The strip stops being a simulation the moment there is an answer.
	heroStrip.lock(deployment.addressChecksum);
	$('hero-caption').textContent = `${deployment.addressChecksum.slice(0, 8)}…${deployment.addressChecksum.slice(-4)} · found in ${result.attempts.toLocaleString()} salts`;

	const deployHref = `/deploy.html#${new URLSearchParams({
		deployer,
		salt: deployment.salt,
		...(initCode ? { initCode } : { initCodeHash: hash }),
	})}`;

	$('result').hidden = false;
	$('result').innerHTML = `
		<div class="result">
			<h3>✦ Salt found</h3>
			<div class="out-row"><span class="k">Address</span><span class="v">0x${head}${esc(mid)}${tail}</span></div>
			<div class="out-row"><span class="k">Salt</span><span class="v" style="font-size:.72rem">${esc(deployment.salt)}</span></div>
			<div class="meta">
				${result.attempts.toLocaleString()} salts in ${(result.durationMs / 1000).toFixed(1)}s across ${result.workers} cores
				(${rate.toLocaleString()}/s) · <strong>${esc(r.label)}</strong>
			</div>
			<div class="export-grid">
				<a class="btn primary" href="${esc(deployHref)}">Check availability and deploy →</a>
				<button id="copy-salt" class="btn" type="button">Copy salt</button>
				<button id="copy-addr" class="btn" type="button">Copy address</button>
				<button id="attest" class="btn" type="button">Get an attestation</button>
			</div>
			<div id="attest-host"></div>
			<details style="margin-top:.9rem">
				<summary>Re-derive this yourself</summary>
				<pre style="margin-top:.6rem"><code>keccak256(0xff ‖ ${esc(deployment.deployer)}
          ‖ ${esc(deployment.salt)}
          ‖ ${esc(deployment.initCodeHash)})[12:]
= ${esc(deployment.address)}</code></pre>
			</details>
		</div>`;

	$('copy-salt').addEventListener('click', () => copy(deployment.salt, 'copy-salt', 'Copy salt'));
	$('copy-addr').addEventListener('click', () => copy(deployment.addressChecksum, 'copy-addr', 'Copy address'));
	$('attest').addEventListener('click', () => requestAttestation({ deployment, pattern, attempts: result.attempts }));
}

/**
 * Ask the API to sign an attestation for this grind.
 *
 * Everything sent is public and everything in the response is checkable: the
 * verifier re-derives the address from the salt, so the signature adds
 * provenance rather than authority.
 * @param {{ deployment: any, pattern: any, attempts: number }} ctx
 */
async function requestAttestation({ deployment, pattern, attempts }) {
	const host = $('attest-host');
	const btn = $('attest');
	btn.disabled = true;
	host.innerHTML = '<div class="okbox show" style="margin-top:.7rem">requesting a signed attestation…</div>';
	try {
		const r = await fetch('/api/attest', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				deployer: deployment.deployer,
				salt: deployment.salt,
				initCodeHash: deployment.initCodeHash,
				prefix: pattern.prefix,
				suffix: pattern.suffix,
				attempts,
			}),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		const url = URL.createObjectURL(new Blob([JSON.stringify(data.attestation, null, 2)], { type: 'application/json' }));
		host.innerHTML = `
			<div class="okbox show" style="margin-top:.7rem">
				Signed by ${esc(data.attestation.issuer)}.
				<div class="actions" style="margin-top:.5rem">
					<a class="btn" href="${url}" download="${esc(deployment.address.slice(2, 10))}-attestation.json">⬇ Download</a>
					<a class="btn" href="/verify.html">Verify it →</a>
				</div>
			</div>`;
	} catch (e) {
		host.innerHTML = `<div class="errbox show" style="margin-top:.7rem">Attestation unavailable: ${esc(e.message)}. The salt above is unaffected, and anyone can re-derive the address without it.</div>`;
		btn.disabled = false;
	}
}

/** @param {string} text @param {string} btnId @param {string} label */
async function copy(text, btnId, label) {
	try {
		await navigator.clipboard.writeText(text);
		$(btnId).textContent = 'Copied!';
	} catch {
		$(btnId).textContent = 'Copy failed';
	}
	setTimeout(() => { $(btnId).textContent = label; }, 1500);
}
