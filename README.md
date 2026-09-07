# create2-vanity

**Grind a deterministic contract address by searching CREATE2 salts, in your
browser, then check it is actually free on every chain before you deploy.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-43%20passing-brightgreen.svg)](./tests)
[![No keys](https://img.shields.io/badge/keys-none%20involved-34d399.svg)](#there-is-no-key-here)

**Try it without installing anything:** `npx wrangler deploy --temporary` puts this
whole thing (site, API and discovery documents) on a Cloudflare Workers URL in
about thirty seconds and needs no account, no token and no configuration. That
preview is disposable and gets a fresh subdomain every time; `npx wrangler deploy`
with a Workers-scoped token puts it somewhere permanent.

```bash
npx create2-vanity grind --init-code-hash 0x30f9… --prefix beef
npx create2-vanity available 0xBEEF…
```

A complete tool for deterministic deployments: the browser grinder, the site, an
HTTP API, a CLI, an MCP server, cross-chain availability checks, a one-click
deploy through the Arachnid proxy, and EIP-712 grind attestations whose central
claim any verifier recomputes.

---

## There is no key here

EIP-1014 defines the address:

```
address = keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))[12:]
```

Four public inputs, one hash, twenty bytes out. **No private key appears
anywhere in that expression**, and that single fact changes the whole risk model
compared with a wallet grinder:

- a hostile grinder's worst case is a salt that does not work, disproved by one
  keccak;
- the work can be delegated to anyone, on any machine, with nothing to protect;
- **server-side grinding is on by default here**, because refusing to do it would
  be theatre (the wallet-side sibling, [evm-vanity](https://github.com/nirholas/evm-vanity),
  disables its equivalent endpoint for exactly the opposite reason);
- an attestation about the address is *checkable*, not merely signed.

---

## Three things this does that other CREATE2 tools do not

### 1. It refuses to let you hash the wrong thing

**Init code is the deploy bytecode with the ABI-encoded constructor arguments
appended.** Hashing the bytecode alone is the most common reason a predicted
address turns out wrong, and it is discovered after the grind, after the
deployment, and after the money.

Drop a Foundry or Hardhat artifact onto the grinder page, or point the CLI at
it, and the tool reads the bytecode, reads the ABI, and tells you in red exactly
which constructor arguments are still missing:

```
$ create2-vanity hash --artifact out/Token.sol/Token.json
✦ 0x9c2f…
  Token, 4210 bytes of deploy code

  This contract takes 2 constructor arguments:
    address owner
    uint256 cap
  The hash above covers the deploy code alone. Append the ABI-encoded arguments
  before grinding, or the address you find is not the address you deploy to.
```

### 2. It knows that portability is not availability

The same deployer, init code and salt give the same address on every chain where
that deployer exists. That is the reason to use CREATE2, and it comes with a
failure mode nobody warns about: **the address can already be occupied on one
chain while it is free on the rest.**

```
$ create2-vanity available 0x00000000D49195AE81759cd247cFeDD9D0B479df
  Ethereum                   free
  Base                       occupied
  Arbitrum One               occupied
  Robinhood Chain            free
  …
  occupied on 2 chains: deploying there would fail or hit someone else's contract.
```

That is a real address with a real split. The [deploy page](deploy.html) checks
every chain first, and re-checks the chain you picked immediately before signing,
because a table can be minutes old by the time anyone clicks.

### 3. Its attestations do not ask to be trusted

A grind attestation records who ground a salt, when, and how many attempts it
took, signed as EIP-712 typed data so a contract can recover the signer with
`ecrecover`. Its central claim is not a claim at all: the verifier re-derives the
address from the attested deployer, salt and init-code hash, so a lie fails in
one keccak with or without the signature.

```js
const result = verifyAttestation(attestation, { issuers });
result.checks.find((c) => c.id === 'derivation').pass;  // needs no issuer at all
```

Losing the issuer key would cost this service its identity and cost users
nothing. That is the correct amount of authority for a tool like this to hold.

---

## Install and run

```bash
git clone https://github.com/nirholas/create2-vanity
cd create2-vanity
npm install
npm run dev            # site on http://localhost:5182, API on http://localhost:8789
npm test               # 43 tests
```

Production, Cloudflare Workers, Docker and Cloud Run: [docs/deploy.md](docs/deploy.md).

---

## Chains

| Chain | Id | Deterministic deployers |
| --- | --- | --- |
| Ethereum | 1 | all four |
| Base | 8453 | all four |
| Arbitrum One | 42161 | all four |
| Robinhood Chain | 4663 | all four |
| OP Mainnet | 10 | all four |
| Polygon | 137 | all four |
| BNB Chain | 56 | all four |
| Avalanche C-Chain | 43114 | all four |
| Sepolia, Base Sepolia | 11155111, 84532 | all four |
| Robinhood Chain Testnet | 46630 | three (no Coinbase Smart Wallet factory) |

The four are the Arachnid deterministic-deployment-proxy, CreateX, the Safe
proxy factory v1.4.1 and the Coinbase Smart Wallet factory. Every row was
confirmed with `eth_getCode` against the listed public RPC, and `npm test`
re-confirms it rather than asking you to take it on faith.

---

## The pieces

| Surface | Where | What it is |
| --- | --- | --- |
| Browser grinder | [`index.html`](index.html), [`src/ui/app.js`](src/ui/app.js) | One Web Worker per core over the CREATE2 preimage, with artifact loading. |
| Deploy | [`deploy.html`](deploy.html) | Availability across every chain, then a one-click deploy through the Arachnid proxy. |
| Verify | [`verify.html`](verify.html) | Re-derive an address, verify an attestation, and the Solidity to do it on chain. |
| Derivation | [`src/create2.js`](src/create2.js) | CREATE2, CREATE, init-code hashing, artifact reading, deploy calldata. |
| Attestations | [`src/attestation.js`](src/attestation.js) | EIP-712 issue and verify, with the type hash a contract needs. |
| Chains | [`src/chains.js`](src/chains.js) | The registry, and the probe that re-verifies it. |
| HTTP API | [`server/`](server) | One Fetch handler, identical on Node and Cloudflare. |
| CLI | [`cli/create2-vanity.js`](cli/create2-vanity.js) | `grind`, `derive`, `hash`, `quote`, `available`, `verify`, `chains`. |
| MCP server | [`mcp/index.js`](mcp/index.js) | Six tools for AI assistants, none of which touch key material. |

---

## CLI

```bash
create2-vanity hash --artifact out/Token.sol/Token.json
create2-vanity grind --init-code-hash 0x30f9… --prefix beef --out found.json
create2-vanity derive --deployer 0x4e59… --salt 0xfc1e… --init-code-hash 0x30f9…
create2-vanity derive --sender 0x6ac7… --nonce 3
create2-vanity quote --prefix Beef --rate 700000
create2-vanity available 0xBEEF… --deployer 0x4e59…
create2-vanity verify attestation.json
create2-vanity chains
```

`available` exits non-zero when the address is occupied somewhere, so it drops
straight into CI. Add `--json` to anything for machine-readable output.

## MCP

```json
{
  "mcpServers": {
    "create2-vanity": { "command": "npx", "args": ["-y", "create2-vanity", "mcp"] }
  }
}
```

| Tool | Does |
| --- | --- |
| `create2_derive` | CREATE2 or CREATE address derivation. |
| `create2_quote` | Difficulty and rarity for a pattern. |
| `create2_grind` | Grind a salt across every core. |
| `create2_availability` | Is the address free, chain by chain. |
| `create2_verify_attestation` | Verify an attestation offline. |
| `create2_chains` | Chains and their deployers. |

## HTTP API

Full schema at `/openapi.json`; agent card at `/.well-known/agents.json`.

| Endpoint | Does |
| --- | --- |
| `POST /api/derive` | CREATE2 from deployer, salt and init code; CREATE from sender and nonce. |
| `POST /api/quote` | Expected salts, p50/p90/p99, rarity, EIP-55 case multiplier. |
| `POST /api/grind` | Search salts server-side. |
| `POST /api/availability` | Is the address still free, chain by chain. |
| `POST /api/attest` | Sign an EIP-712 grind attestation. |
| `POST /api/verify` | Verify one, derivation check included. |
| `GET /api/chains` | The chain and deployer registry. |
| `GET /api/salt` | A random 32-byte salt. |

---

## Documentation

| Document | Covers |
| --- | --- |
| [docs/derivation.md](docs/derivation.md) | CREATE2, CREATE, init code, and the constructor-argument trap. |
| [docs/protocol-attestation.md](docs/protocol-attestation.md) | The EIP-712 format, every verifier check, and the Solidity. |
| [docs/deploy.md](docs/deploy.md) | Node, Docker, Cloud Run, Cloudflare Workers. |
| [docs/discoverability.md](docs/discoverability.md) | The documents crawlers, assistants and agent runtimes read, and where to submit the project. |
| [SECURITY.md](SECURITY.md) | What this promises, and the two things it explicitly does not. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it and the quality bar. |

The site ships its own documentation page at `/docs.html`.

## Environment

| Variable | Meaning |
| --- | --- |
| `ATTESTATION_KEY` | 32-byte secp256k1 key (hex) for signing attestations. Unset means an ephemeral per-process key, reported in every response. A signing identity, not a wallet: do not fund it. |
| `PORT` | Node listen port. Default 8789. |
| `CREATE2_VANITY_API` | Default remote API for `verify`. |

## Provenance

The browser grinder, its worker, the pattern validation and the hex wordlist
were first built inside [three.ws](https://github.com/nirholas/three.ws) and are
re-licensed here under Apache-2.0. The derivation and artifact modules, the
availability checks, the deployment flow, the attestation format, the Node
grinders, the API, the CLI and the MCP server are new in this repository.

## Licence

[Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
