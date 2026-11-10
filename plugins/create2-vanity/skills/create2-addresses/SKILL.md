---
name: create2-addresses
description: Derive CREATE2 and CREATE contract addresses, estimate and grind vanity salts, and check an address is free on every EVM chain with the create2-vanity MCP server or CLI. Use when planning a deterministic multi-chain deployment.
---

# create2-vanity

CREATE2 addresses are `keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]`. No private key is involved, so grinding and checking are safe to run anywhere. The npm package `create2-vanity` provides an MCP server and a CLI.

## MCP server

The plugin's `.mcp.json` launches `npx -y create2-vanity mcp` (stdio). Tools:

| Tool | Use |
|---|---|
| `create2_derive` | CREATE2 from deployer, salt and init code or init-code hash. CREATE from `sender` and `nonce`. |
| `create2_quote` | Expected salts, difficulty and rarity for a pattern. Optional `attemptsPerSecond` converts to time. |
| `create2_grind` | Search salts across cores. Optional `cores` and `timeBudgetMs`. |
| `create2_availability` | Is `address` free, chain by chain. Optional `deployer` and `chainIds`. |
| `create2_verify_attestation` | Verify a grind attestation offline. |
| `create2_chains` | The chain and deployer registry. |

## CLI

```bash
npx create2-vanity hash --artifact out/Token.sol/Token.json
npx create2-vanity quote --prefix beef --rate 700000
npx create2-vanity grind --init-code-hash 0x30f9... --prefix beef --out found.json
npx create2-vanity derive --deployer 0x4e59... --salt 0xfc1e... --init-code-hash 0x30f9...
npx create2-vanity derive --sender 0x6ac7... --nonce 3
npx create2-vanity available 0xBEEF... --deployer 0x4e59...
npx create2-vanity verify attestation.json
npx create2-vanity chains
npx create2-vanity salt
```

Add `--json` for machine-readable output. `available` exits non-zero when the address is occupied on any chain, so it works in CI.

## Rules that prevent wrong addresses

- Init code is the deploy bytecode with the ABI-encoded constructor arguments appended. Hashing the bytecode alone gives an address that will not match the deployment. `hash --artifact` reads a Foundry or Hardhat artifact and lists the constructor arguments still missing.
- The same deployer, init code and salt give the same address only where that deployer contract exists. Run `available` before deploying: an address can be occupied on one chain and free on the rest.
- Registered chains include Ethereum, Base, Arbitrum One, Robinhood Chain, OP Mainnet, Polygon, BNB Chain, Avalanche C-Chain and several testnets. Run `chains` for the live list.

## Worked example

1. `npx create2-vanity hash --artifact out/Token.sol/Token.json` and append the constructor arguments it asks for.
2. `npx create2-vanity quote --prefix beef` to see how long the pattern takes.
3. `npx create2-vanity grind --init-code-hash <hash> --prefix beef --out found.json`.
4. `npx create2-vanity available <address> --deployer <deployer>` to confirm it is free everywhere.

## HTTP API

A hosted or local server exposes `POST /api/derive`, `/api/quote`, `/api/grind`, `/api/availability`, `/api/attest`, `/api/verify`, and `GET /api/chains`, `/api/salt`. The schema is at `/openapi.json`. Run it locally with `npm start` from a clone (port 8789 by default, or `PORT`).
