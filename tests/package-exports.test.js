import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/index.js';

test('package root exports the supported library surface', () => {
  assert.equal(typeof api.create2Address, 'function');
  assert.equal(typeof api.randomSalt, 'function');
  assert.equal(typeof api.address.inspectAddress, 'function');
  assert.equal(typeof api.attestation.verifyAttestation, 'function');
  assert.equal(typeof api.chains.getChain, 'function');
  assert.equal(typeof api.difficulty.expectedAttempts, 'function');
  assert.equal(typeof api.validation.validatePattern, 'function');
});
