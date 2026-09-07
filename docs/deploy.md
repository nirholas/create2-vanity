# Deploying

One Fetch handler (`server/app.mjs`) with two hosts. Pick either; the API is
identical apart from one endpoint noted below.

## Node (Docker, Cloud Run, a VM, anything)

```bash
npm ci
npm run build                       # static site into dist/
node server/keygen.mjs              # mint a durable attestation key
ATTESTATION_KEY=<hex> npm start    # serves the API and dist/ on :8789
```

The Dockerfile builds exactly this in two stages:

```bash
docker build -t create2-vanity .
docker run -p 8789:8789 -e ATTESTATION_KEY=<hex> create2-vanity
```

For Google Cloud Run:

```bash
gcloud run deploy create2-vanity \
  --source . --region us-central1 --allow-unauthenticated \
  --set-secrets ATTESTATION_KEY=create2-vanity-attestation:latest
```

## Cloudflare Workers

```bash
npm run build
npx wrangler secret put ATTESTATION_KEY
npx wrangler deploy
```

`wrangler.toml` binds `dist/` as the assets directory, so the Worker serves the
site and the API from one origin.

**No endpoint differs on the edge.** The grinder is pure keccak with no
filesystem or WebAssembly dependency, so the Worker runs the same code as Node,
`/api/grind` included.

## Static-only

The browser grinder, the derivation and attestation verification are all
client-side. `dist/` on any static host gives you a fully working grinder; the
pages degrade honestly when the API is absent (the attestation button reports
that provenance is unavailable, and the grinder is unaffected).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `ATTESTATION_KEY` | for durable attestations | 32-byte secp256k1 key, hex. Without it the service mints an ephemeral key, says so in every response, and its attestations stop verifying on restart. |
| `PORT` | no | Node listen port. Default 8789. |

## After deploying

```bash
curl -s https://your-host/api/health
curl -s https://your-host/.well-known/create2-vanity.json    # your published issuer list
curl -s https://your-host/openapi.json | head
```

`/api/health` reports whether the issuer key is ephemeral. If it says
`"ephemeral": true` on a production deployment, `ATTESTATION_KEY` did not reach
the process.

The issuer key is a signing identity, not a wallet. It never sends a transaction
and never needs gas: do not fund it.
