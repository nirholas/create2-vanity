# Contributing

## Running it

```bash
npm install
npm run dev     # site on :5182, API on :8789
npm test        # 43 tests; the chain test needs network access
npm run build   # static site into dist/
```

## The bar

- **No mocks, no placeholder data, no TODO comments.** If a path exists it works.
- **Every address is re-derivable.** Anything this tool reports must be
  reproducible from the inputs it returns, and there is a test that does so from
  first principles against an address that exists on chain.
- **Every claim about a chain is verifiable.** The registry is checked against
  live RPCs by `tests/chains.test.js`. Add a chain and add it to that check.
- **Counters get a regression test.** The salt counter broke once in a way that
  is invisible from the outside (`++buf[i]` on a `Uint8Array` returns 256, not 0,
  so the carry never propagated and the search covered 256 salts). A grinder
  that reports a healthy rate and finds nothing is the worst kind of bug, so
  `tests/grinder.test.js` asserts the counter reaches past one byte.

## Where things live

| Layer | Directory |
| --- | --- |
| Derivation and protocols | `src/*.js` |
| Browser UI | `index.html`, `*.html`, `src/ui/` |
| HTTP API | `server/` (Node) and `worker/` (Cloudflare) |
| CLI | `cli/` |
| MCP server | `mcp/` |
| Tests | `tests/` |

## Licence

Contributions are accepted under the Apache License 2.0.
