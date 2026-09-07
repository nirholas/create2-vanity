# Deterministic contract addresses

> How CREATE2 and CREATE addresses are computed, what init code actually is, and
> the one mistake that wastes a whole grind.

## CREATE2 (EIP-1014)

```
address = keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))[12:]
```

| Input | Size | Who chooses it |
| --- | --- | --- |
| `0xff` | 1 byte | the specification, as a domain separator |
| `deployer` | 20 bytes | the factory you deploy through |
| `salt` | 32 bytes | **you** |
| `keccak256(initCode)` | 32 bytes | your contract and its constructor arguments |

Only the salt is free, which is what makes the address searchable. Everything in
that expression is public, so the result is verifiable by anyone and there is no
secret to protect at any point.

## CREATE

The address an ordinary deployment lands on:

```
address = keccak256(rlp([sender, nonce]))[12:]
```

Included here because "which address will my next deploy get" is the same
question one step earlier. The RLP encoding is the part hand-rolled
implementations get wrong: nonce 0 encodes as `0x80`, nonces below 128 encode as
a single byte, and above that as a length prefix plus minimal big-endian bytes.
`tests/create2.test.js` covers the boundary.

## Init code, and the constructor-argument trap

**Init code is the deploy bytecode with the ABI-encoded constructor arguments
appended.** It is not the runtime bytecode, and it is not the deploy bytecode
alone unless the constructor takes no arguments.

This is the single most common reason a predicted CREATE2 address turns out
wrong, and the discovery order is brutal: you grind for hours, you deploy, and
the contract lands somewhere else entirely.

```bash
# Foundry
forge inspect Token bytecode                     # deploy bytecode
cast abi-encode "constructor(address,uint256)" 0xOwner 1000000
# concatenate, drop the second 0x

create2-vanity hash --init-code 0x60806040…0000000f4240
```

Point the tool at the artifact instead and it reads the ABI, sees the
constructor, and refuses to let the mistake pass silently:

```bash
create2-vanity hash --artifact out/Token.sol/Token.json
```

It reads Foundry (`bytecode.object`), Hardhat (`bytecode` as a string) and raw
solc (`evm.bytecode.object`) shapes, and distinguishes "no bytecode field" from
"empty bytecode", because the second one means the artifact is an interface or
an abstract contract.

## Deploying

The Arachnid deterministic-deployment-proxy takes `salt ‖ initCode` as raw
calldata, with no function selector, which is why it is the default here: any
wallet, script or multisig can send the transaction with no ABI.

```
to     0x4e59b44847b379578588920cA78FbF26c0B4956C
data   <32-byte salt><init code>
value  0
```

Other factories (CreateX, Safe, the Coinbase Smart Wallet factory) need their
own ABI. The address you grind is still correct for them; only the deploy call
differs, and the grinder says so when you pick one.

## Portability, and its limit

Same deployer, same init code, same salt, same address, on every chain where
that deployer exists. All four common factories are live on Ethereum, Base,
Arbitrum, Robinhood Chain, OP, Polygon, BNB and Avalanche.

Portability is not availability. An address can already be occupied on one chain
while free on the rest, and deploying into it fails and costs the fee. Check
first:

```bash
create2-vanity available 0xBEEF… --deployer 0x4e59…
```

Nor is portability ownership. Anyone with the same deployer, init code and salt
can deploy to the same address anywhere it is still free. If that matters, use a
factory that authenticates the caller rather than the open proxy.
