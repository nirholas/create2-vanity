# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/nirholas/create2-vanity/security/advisories/new).

## The short version: there is no key here

A CREATE2 address is `keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)[12:]`. No
private key appears in that expression, so this tool holds no secret at any
point, and neither does anyone you delegate to. The worst outcome of a hostile
or broken grinder is a salt that does not produce the claimed address, which one
keccak disproves.

That is why server-side grinding is on by default here, and why the wallet-side
sibling of this tool ([evm-vanity](https://github.com/nirholas/evm-vanity))
disables its equivalent endpoint.

## What this project does promise

| Claim | Enforced by |
| --- | --- |
| Every address it reports is re-derivable from the inputs it returns. | `create2Address`, and `create2-vanity derive` for checking by hand. |
| An attestation cannot state a false derivation. | The verifier recomputes the address from the attested salt before looking at the signature. |
| An attestation cannot claim a pattern the address lacks. | `/api/attest` refuses to sign one. |
| The deploy flow will not send into an occupied address. | The availability check is repeated immediately before signing, not only when the table was drawn. |

## What it does not promise

- **That an address is yours.** Anyone with the same deployer, init code and
  salt can deploy to the same address on any chain where it is still free. If
  that matters, use a factory that authenticates the caller (CreateX's
  permissioned modes, or your own), not the Arachnid proxy.
- **That the init code is what you think.** If the constructor arguments are
  missing from the init code you hashed, the address you ground is not the
  address you will deploy to. The tool warns loudly when it can see a
  constructor in the ABI, and cannot when it only has a hash.
- **That an ephemeral issuer key is an identity.** When `ATTESTATION_KEY` is
  unset the service mints a per-process key and says so. The derivation check in
  every attestation is unaffected.

## Cryptographic dependencies

Keccak-256 and secp256k1 come from
[@noble/hashes](https://github.com/paulmillr/noble-hashes) and
[@noble/curves](https://github.com/paulmillr/noble-curves). Nothing in this
repository implements a cryptographic primitive itself.
