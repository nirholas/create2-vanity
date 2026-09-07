#!/usr/bin/env node
/**
 * Mint a durable issuer key.
 *
 * Prints the private key once, on stdout, and writes it nowhere: put it in your
 * secret manager (or `.env`) as ATTESTATION_KEY and keep it out of the
 * repository. The address is what you publish.
 *
 *   node server/keygen.mjs
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils';

import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';

const key = secp256k1.utils.randomSecretKey();

console.log('ATTESTATION_KEY=0x%s', bytesToHex(key));
console.log('');
console.log('issuer address: %s', eip55Checksum(addressFromPrivateKey(key)));
console.log('');
console.log('Store the key in a secret manager. Anyone holding it can sign attestations as');
console.log('this service; nobody holding it can touch a ground wallet, because the service');
console.log('never sees one. It is a signing identity, not a wallet: do not fund it.');
