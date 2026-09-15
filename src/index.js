/**
 * Public library entry point for create2-vanity.
 *
 * The CREATE2 helpers are exported directly for the common case. The other
 * modules are namespaced so similarly named helpers (for example address
 * checksum functions) cannot collide at the package root.
 */
export * from './create2.js';
export * as address from './address.js';
export * as attestation from './attestation.js';
export * as chains from './chains.js';
export * as difficulty from './difficulty.js';
export * as validation from './validation.js';
