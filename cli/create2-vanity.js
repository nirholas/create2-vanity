#!/usr/bin/env node
/**
 * create2-vanity CLI.
 *
 *   create2-vanity grind --deployer 0x… --init-code-hash 0x… --prefix beef
 *   create2-vanity derive --deployer 0x… --salt 0x… --init-code-hash 0x…
 *   create2-vanity derive --sender 0x… --nonce 3
 *   create2-vanity hash --artifact out/Token.sol/Token.json [--args '["a",1]']
 *   create2-vanity quote --prefix beef --rate 700000
 *   create2-vanity available 0x… [--deployer 0x…]
 *   create2-vanity verify attestation.json
 *   create2-vanity chains
 *   create2-vanity serve --port 8789
 *   create2-vanity mcp
 *
 * Everything except `available`, `verify --api` and `serve` works offline.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import process from 'node:process';

import { grindSaltPool } from '../src/grinder-pool.js';
import { create2Address, createAddress, initCodeHash, describeDeployment, readArtifact, constructorInputs, randomSalt } from '../src/create2.js';
import { difficulty, rarity, formatAttempts, formatDuration, normalizePattern } from '../src/difficulty.js';
import { validatePattern, validateAddress, validateInitCodeHash } from '../src/validation.js';
import { eip55Checksum } from '../src/address.js';
import { verifyAttestation } from '../src/attestation.js';
import { CHAINS, getChain, hasCode, ARACHNID_PROXY, FACTORY_LABELS } from '../src/chains.js';

const DEFAULT_API = process.env.CREATE2_VANITY_API || 'https://create2-vanity.dev';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
	dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
	mint: (s) => (tty ? `\x1b[38;5;79m${s}\x1b[0m` : s),
	green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

try {
	await main();
} catch (err) {
	console.error(c.red(`error: ${err.message}`));
	process.exitCode = 1;
}

async function main() {
	switch (command) {
		case 'grind': return cmdGrind();
		case 'derive': return cmdDerive();
		case 'hash': return cmdHash();
		case 'quote': return cmdQuote();
		case 'available': return cmdAvailable();
		case 'verify': return cmdVerify();
		case 'chains': return cmdChains();
		case 'salt': return console.log(randomSalt());
		case 'serve': return cmdServe();
		case 'mcp': return cmdMcp();
		case 'help': case '--help': case '-h': case undefined: return usage();
		case 'version': case '--version': case '-v': {
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
			console.log(pkg.version);
			return;
		}
		default:
			usage();
			throw new Error(`unknown command "${command}"`);
	}
}

function usage() {
	console.log(`${c.mint('create2-vanity')} ${c.dim('- grind, derive and verify deterministic contract addresses')}

${c.bold('Commands')}
  grind       Search salts for a vanity address, across every core.
  derive      CREATE2 (deployer + salt + init code) or CREATE (sender + nonce).
  hash        keccak256 of init code, read from a Foundry or Hardhat artifact.
  quote       Difficulty, rarity and ETA for a pattern.
  available   Ask every chain whether an address is still free.
  verify      Verify a grind attestation.
  chains      EVM chains and their deterministic deployers.
  salt        Print a random 32-byte salt.
  serve       Run the HTTP API and, if built, the site.
  mcp         Run the Model Context Protocol server on stdio.

${c.bold('grind')}
  --deployer <0x…>          Factory address (default: the Arachnid proxy)
  --init-code-hash <0x…>    keccak256 of the init code
  --init-code <0x…>         Raw init code; hashed for you
  --artifact <file.json>    Foundry or Hardhat artifact to read bytecode from
  --prefix <hex>            Characters the address must start with, after 0x
  --suffix <hex>            Characters the address must end with
  --cores <n>               Workers to use (default: every core, ${availableParallelism()} here)
  --out <file>              Write the result as JSON
  --json                    Machine-readable output

${c.dim('An uppercase letter in a pattern (Beef) requests that EIP-55 spelling and costs 2x per letter.')}

${c.bold('Examples')}
  create2-vanity hash --artifact out/Token.sol/Token.json
  create2-vanity grind --init-code-hash 0x30f9… --prefix beef
  create2-vanity derive --deployer 0x4e59… --salt 0xfc1e… --init-code-hash 0x30f9…
  create2-vanity available 0x00000000D49195AE81759cd247cFeDD9D0B479df
`);
}

// ── grind ────────────────────────────────────────────────────────────────────
async function cmdGrind() {
	const pattern = readPattern();
	const deployer = readDeployer();
	const hash = readInitCodeHash();
	const cores = flags.cores ? Number(flags.cores) : availableParallelism();
	const d = difficulty(pattern);
	const r = rarity(pattern);

	if (!flags.json) {
		console.log(`${c.mint('✦')} grinding ${c.bold(describe(pattern))} for ${c.dim(deployer)} ${c.dim(`(${r.label})`)}`);
		console.log(c.dim(`  ${formatAttempts(d.p50)} salts for an even chance, across ${cores} cores`));
	}

	const result = await grindSaltPool({
		deployer,
		initCodeHash: hash,
		...pattern,
		workers: cores,
		onProgress: flags.json ? undefined : ({ attempts, rate }) => {
			const eta = rate > 0 ? formatDuration(Math.max(0, d.p50 - attempts) / rate) : 'unknown';
			process.stderr.write(`\r  ${attempts.toLocaleString('en-US')} tried · ${Math.round(rate).toLocaleString('en-US')}/s · eta ${eta}   `);
		},
	});

	if (!flags.json) process.stderr.write('\r' + ' '.repeat(78) + '\r');

	const described = describeDeployment({ deployer, salt: result.salt, initCodeHash: hash, initCode: readInitCode() });
	if (flags.out) writeFileSync(String(flags.out), JSON.stringify({ ...described, attempts: result.attempts, durationMs: result.durationMs }, null, 2));

	if (flags.json) {
		console.log(JSON.stringify({ ...described, attempts: result.attempts, durationMs: result.durationMs, workers: result.workers, rarity: r }, null, 2));
		return;
	}

	console.log(`${c.green('✓')} ${c.bold(described.addressChecksum)}`);
	console.log(`  salt  ${described.salt}`);
	console.log(c.dim(`  ${result.attempts.toLocaleString('en-US')} salts in ${(result.durationMs / 1000).toFixed(1)}s across ${result.workers} cores · ${r.label}`));
	if (flags.out) console.log(`${c.mint('→')} written to ${flags.out}`);
	console.log('');
	console.log(c.dim('  Re-derive it yourself:'));
	console.log(c.dim(`  create2-vanity derive --deployer ${described.deployer} --salt ${described.salt} --init-code-hash ${described.initCodeHash}`));
}

// ── derive ───────────────────────────────────────────────────────────────────
function cmdDerive() {
	if (flags.sender !== undefined || flags.nonce !== undefined) {
		const sender = String(flags.sender || '');
		const nonce = Number(flags.nonce ?? 0);
		const address = createAddress(sender, nonce);
		if (flags.json) {
			console.log(JSON.stringify({ scheme: 'create', address: eip55Checksum(address), sender: eip55Checksum(sender), nonce }, null, 2));
			return;
		}
		console.log(`${c.mint('✦')} ${c.bold(eip55Checksum(address))}`);
		console.log(c.dim(`  keccak256(rlp([${eip55Checksum(sender)}, ${nonce}]))[12:]`));
		return;
	}

	const deployer = readDeployer();
	const hash = readInitCodeHash();
	const salt = String(flags.salt || '');
	if (!salt) throw new Error('give --salt, or --sender and --nonce for a plain CREATE derivation');

	const described = describeDeployment({ deployer, salt, initCodeHash: hash, initCode: readInitCode() });
	if (flags.json) {
		console.log(JSON.stringify(described, null, 2));
		return;
	}
	console.log(`${c.mint('✦')} ${c.bold(described.addressChecksum)}`);
	console.log(c.dim(`  keccak256(0xff | ${described.deployer} | ${described.salt.slice(0, 12)}… | ${described.initCodeHash.slice(0, 12)}…)[12:]`));
	if (described.calldata) {
		console.log('');
		console.log(c.dim('  deploy through the Arachnid proxy with:'));
		console.log(c.dim(`    to    ${described.deployer}`));
		console.log(c.dim(`    data  ${described.calldata.slice(0, 74)}… (${(described.calldata.length - 2) / 2} bytes)`));
	}
}

// ── hash ─────────────────────────────────────────────────────────────────────
function cmdHash() {
	let bytecode = readInitCode();
	let inputs = [];
	let name = null;

	if (flags.artifact) {
		const artifact = JSON.parse(readFileSync(String(flags.artifact), 'utf8'));
		const read = readArtifact(artifact);
		bytecode = read.bytecode;
		name = read.contractName;
		inputs = constructorInputs(read.abi);
	}
	if (!bytecode) throw new Error('give --init-code or --artifact');

	const hash = initCodeHash(bytecode);
	if (flags.json) {
		console.log(JSON.stringify({ contractName: name, initCodeHash: hash, bytes: (bytecode.length - 2) / 2, constructorInputs: inputs }, null, 2));
		return;
	}
	console.log(`${c.mint('✦')} ${c.bold(hash)}`);
	console.log(c.dim(`  ${name ? `${name}, ` : ''}${(bytecode.length - 2) / 2} bytes of deploy code`));
	if (inputs.length) {
		console.log('');
		console.log(c.red(`  This contract takes ${inputs.length} constructor argument${inputs.length === 1 ? '' : 's'}:`));
		for (const input of inputs) console.log(c.red(`    ${input.type}${input.name ? ` ${input.name}` : ''}`));
		console.log(c.dim('  The hash above covers the deploy code alone. Append the ABI-encoded arguments'));
		console.log(c.dim('  before grinding, or the address you find is not the address you deploy to.'));
	}
}

// ── quote ────────────────────────────────────────────────────────────────────
function cmdQuote() {
	const pattern = readPattern();
	const rate = Number(flags.rate || 0);
	const d = difficulty(pattern, rate > 0 ? { attemptsPerSecond: rate } : {});
	const r = rarity(pattern);

	if (flags.json) {
		console.log(JSON.stringify({ pattern: d.pattern, difficulty: d, rarity: r }, null, 2));
		return;
	}
	console.log(`${c.mint('✦')} ${c.bold(describe(pattern))}`);
	console.log(`  expected salts     ${Math.round(d.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  even chance (p50)  ${Math.round(d.p50).toLocaleString('en-US')}`);
	console.log(`  90% chance         ${Math.round(d.p90).toLocaleString('en-US')}`);
	console.log(`  rarity             ${r.label} · score ${r.score}`);
	if (d.caseCost > 1) console.log(`  EIP-55 spelling    ${d.caseCost}x harder than the any-case pattern`);
	if (d.eta) console.log(`  eta at ${Number(rate).toLocaleString('en-US')}/s  ${d.eta.p50Human} (p50), ${d.eta.p90Human} (p90)`);
}

// ── available ────────────────────────────────────────────────────────────────
async function cmdAvailable() {
	const address = argv[1] && !argv[1].startsWith('--') ? argv[1] : String(flags.address || '');
	if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('usage: create2-vanity available <address>');
	const deployer = flags.deployer ? String(flags.deployer) : null;

	const rows = [];
	for (const chain of CHAINS) {
		process.stderr.write(`\r  checking ${chain.name}…${' '.repeat(30)}`);
		try {
			const occupied = await hasCode(chain.rpc, address, { timeoutMs: 12_000 });
			const deployerPresent = deployer ? await hasCode(chain.rpc, deployer, { timeoutMs: 12_000 }) : null;
			rows.push({ chain, free: !occupied, deployerPresent });
		} catch (err) {
			rows.push({ chain, free: null, error: err.message });
		}
	}
	process.stderr.write('\r' + ' '.repeat(60) + '\r');

	if (flags.json) {
		console.log(JSON.stringify(rows.map((r) => ({ chainId: r.chain.id, name: r.chain.name, free: r.free, deployerPresent: r.deployerPresent, error: r.error })), null, 2));
		return;
	}
	console.log(`${c.mint('✦')} ${c.bold(eip55Checksum(address))}`);
	for (const row of rows) {
		const state = row.free === true ? c.green('free') : row.free === false ? c.red('occupied') : c.dim(`unreachable (${row.error})`);
		const dep = row.deployerPresent === false ? c.dim(' · deployer missing') : '';
		console.log(`  ${row.chain.name.padEnd(26)} ${state}${dep}`);
	}
	const occupied = rows.filter((r) => r.free === false);
	console.log('');
	console.log(occupied.length
		? c.red(`  occupied on ${occupied.length} chain${occupied.length === 1 ? '' : 's'}: deploying there would fail or hit someone else's contract.`)
		: c.green('  free everywhere checked.'));
	process.exitCode = occupied.length ? 1 : 0;
}

// ── verify ───────────────────────────────────────────────────────────────────
async function cmdVerify() {
	const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : String(flags.file || '');
	if (!file) throw new Error('usage: create2-vanity verify <attestation.json>');
	const raw = JSON.parse(await readFile(file, 'utf8'));
	const doc = raw.attestation ?? raw;

	let issuers = null;
	const api = String(flags.api || DEFAULT_API).replace(/\/$/, '');
	try {
		const r = await fetch(`${api}/.well-known/create2-vanity.json`);
		if (r.ok) issuers = ((await r.json()).issuers || []).map((i) => i.address);
	} catch {
		issuers = null;
	}

	const result = verifyAttestation(doc, issuers?.length ? { issuers } : {});
	if (flags.json) {
		console.log(JSON.stringify({ ...result, issuersPinned: !!issuers?.length }, null, 2));
		process.exitCode = result.valid ? 0 : 1;
		return;
	}
	console.log(result.valid ? c.green('✓ attestation is valid') : c.red('✗ attestation is NOT valid'));
	console.log(c.dim(`  account ${result.account}`));
	console.log(c.dim(`  signer  ${result.issuer || 'not recovered'}`));
	console.log('');
	for (const check of result.checks) {
		console.log(`  ${check.pass ? c.green('✓') : c.red('✗')} ${check.label}`);
		console.log(c.dim(`     ${check.detail}`));
	}
	console.log('');
	console.log(c.dim('  The derivation check needs no issuer and no trust: it re-runs CREATE2 over the attested inputs.'));
	process.exitCode = result.valid ? 0 : 1;
}

// ── chains ───────────────────────────────────────────────────────────────────
function cmdChains() {
	if (flags.json) {
		console.log(JSON.stringify(CHAINS, null, 2));
		return;
	}
	console.log(`${c.mint('✦')} ${CHAINS.length} chains. Same deployer, init code and salt gives the same address on all of them.`);
	console.log('');
	for (const chain of CHAINS) {
		console.log(`  ${String(chain.id).padStart(9)}  ${chain.name.padEnd(26)} ${c.dim(`${Object.keys(chain.factories).length}/4 deployers`)}${chain.testnet ? c.dim(' · testnet') : ''}`);
	}
	console.log('');
	for (const [address, label] of Object.entries(FACTORY_LABELS)) {
		console.log(c.dim(`  ${address}  ${label}`));
	}
}

// ── serve / mcp ──────────────────────────────────────────────────────────────
async function cmdServe() {
	if (flags.port) process.env.PORT = String(flags.port);
	await import('../server/index.mjs');
}

async function cmdMcp() {
	const [{ buildServer, TOOLS }, { StdioServerTransport }] = await Promise.all([
		import('../mcp/index.js'),
		import('@modelcontextprotocol/sdk/server/stdio.js'),
	]);
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[create2-vanity] MCP server on stdio with ${TOOLS.length} tools`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** @returns {{ prefix: string, suffix: string, caseSensitive: boolean }} */
function readPattern() {
	const p = normalizePattern({ prefix: String(flags.prefix || ''), suffix: String(flags.suffix || '') });
	if (!p.length) throw new Error('give --prefix, --suffix, or both');
	for (const [label, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/** The Arachnid proxy is the default because it is live everywhere and needs no ABI. */
function readDeployer() {
	const value = String(flags.deployer || ARACHNID_PROXY);
	const v = validateAddress(value);
	if (!v.valid) throw new Error(`deployer: ${v.error}`);
	return v.normalized;
}

/** @returns {string|null} */
function readInitCode() {
	if (flags['init-code']) return String(flags['init-code']);
	if (flags.artifact) return readArtifact(JSON.parse(readFileSync(String(flags.artifact), 'utf8'))).bytecode;
	return null;
}

/** @returns {string} */
function readInitCodeHash() {
	if (flags['init-code-hash']) {
		const v = validateInitCodeHash(String(flags['init-code-hash']));
		if (!v.valid) throw new Error(`init code hash: ${v.error}`);
		return v.normalized;
	}
	const code = readInitCode();
	if (!code) throw new Error('give --init-code-hash, --init-code, or --artifact');
	return initCodeHash(code);
}

/** @param {{prefix:string,suffix:string}} pattern @returns {string} */
function describe(pattern) {
	return `0x${pattern.prefix || ''}…${pattern.suffix || ''}`;
}

/**
 * `--key value` and `--flag` into an object.
 * @param {string[]} args
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(args) {
	/** @type {Record<string, string|boolean>} */
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else { out[key] = next; i++; }
	}
	return out;
}
