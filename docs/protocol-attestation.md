# CREATE2 grind attestations

> `create2-vanity-attestation/v1`. A signed record of a salt grind, whose central
> claim any verifier recomputes without needing the signature at all.

## The document

```json
{
  "protocol": "create2-vanity-attestation/v1",
  "account": "0x00000000D49195AE81759cd247cFeDD9D0B479df",
  "deployment": {
    "deployer": "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    "salt": "0xfc1ecd1953bb17cf798c1eaeed287873008f3a3038f438e9e74c3b33ce370ef5",
    "initCodeHash": "0x30f9d9020bf9622bbe7f8a1625d447efe350dfafd0a91e6dbd62d56547db835f",
    "derivation": "keccak256(0xff | deployer | salt | initCodeHash)[12:]"
  },
  "pattern": { "prefix": "00000000", "suffix": "", "caseSensitive": false },
  "attempts": 4294967296,
  "difficulty": { "expectedAttempts": 4294967296, "model": "hex-uniform/v1" },
  "freshness": { "nonce": "0x…", "issuedAt": "2026-09-07T07:10:26.303Z" },
  "digest": "0x…",
  "signature": "0x…",
  "issuer": "0x…",
  "signatureScheme": "eip712-ecdsa-secp256k1"
}
```

## Why this one is unusually honest

An attestation about a *wallet* can only ever be a claim: nobody outside can
check that the issuer kept no copy of the key. A CREATE2 address has no key, and
its derivation is public, so the verifier does not have to trust the issuer
about the central fact. It recomputes the address from the attested salt, and a
lie fails in one keccak.

The signature adds **provenance**, not authority: who ground it, when, and how
many attempts it took. Losing the issuer key would cost the service its identity
and cost users nothing.

## The typed data

```
Create2Attestation(
  address account,
  address deployer,
  bytes32 salt,
  bytes32 initCodeHash,
  string prefix,
  string suffix,
  bool caseSensitive,
  uint256 expectedAttempts,
  uint256 attempts,
  bytes32 nonce,
  uint256 issuedAt
)
```

The domain is `EIP712Domain(string name,string version)` with
`name = "Create2VanityAttestation"` and `version = "1"`. No `chainId` and no
`verifyingContract`: a CREATE2 address is the same on every chain with the
deployer, and pinning one would make a true statement fail elsewhere.

The type hash and domain separator are served at
`/.well-known/create2-vanity.json` and exported as `TYPE_HASH` and
`DOMAIN_SEPARATOR_HEX`, so a deployed Solidity verifier and this library cannot
drift apart. `tests/attestation.test.js` pins both.

## Verifying on chain

```solidity
bytes32 constant DOMAIN_SEPARATOR = /* from /.well-known/create2-vanity.json */;
bytes32 constant TYPE_HASH = keccak256(
    "Create2Attestation(address account,address deployer,bytes32 salt,bytes32 initCodeHash,"
    "string prefix,string suffix,bool caseSensitive,uint256 expectedAttempts,"
    "uint256 attempts,bytes32 nonce,uint256 issuedAt)"
);

function check(Attestation calldata a, bytes calldata sig) internal pure returns (address issuer) {
    // The part that needs no signature: re-derive the address.
    address predicted = address(uint160(uint256(keccak256(
        abi.encodePacked(bytes1(0xff), a.deployer, a.salt, a.initCodeHash)
    ))));
    require(predicted == a.account, "salt does not produce this address");

    bytes32 structHash = keccak256(abi.encode(
        TYPE_HASH, a.account, a.deployer, a.salt, a.initCodeHash,
        keccak256(bytes(a.prefix)), keccak256(bytes(a.suffix)), a.caseSensitive,
        a.expectedAttempts, a.attempts, a.nonce, a.issuedAt
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    (bytes32 r, bytes32 s, uint8 v) = split(sig);   // r ‖ s ‖ v, v in {27, 28}
    issuer = ecrecover(digest, v, r, s);
}
```

## Verifying off chain

```js
import { verifyAttestation } from 'create2-vanity/attestation';

const issuers = (await (await fetch(BASE + '/.well-known/create2-vanity.json')).json()).issuers.map((i) => i.address);
const result  = verifyAttestation(attestation, { issuers });
```

| Check | What it recomputes |
| --- | --- |
| `protocol` | The document declares a supported protocol. |
| `derivation` | **The attested salt really produces the attested address.** Needs no issuer. |
| `account` | A well-formed, correctly checksummed address. |
| `pattern` | The address actually matches the claimed pattern. |
| `difficulty` | The expected attempts equal what the named model produces. |
| `freshness` | The nonce is well-formed and the issue time is not in the future. |
| `signature` | The EIP-712 digest recovers a signer, matching the stated one. |
| `issuerPinned` | The signer is on the published issuer list. |

Verifying with no issuer list is still useful here, unlike in a wallet-grinding
tool: the derivation check passes or fails on its own, and the audit says which
guarantees you did and did not get.

## Rotation

The issuer list is an array. Publish the new address alongside the old, sign new
attestations with the new key, and drop the old one once every attestation
signed with it has aged out.
