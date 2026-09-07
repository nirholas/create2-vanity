# Being found

This project is meant to be usable by three audiences that do not read READMEs:
search crawlers, AI assistants, and agent runtimes. Everything below is served
by the application itself and derived from the request origin, so a fork
deployed anywhere publishes correct documents with no configuration.

## What the service publishes

| Path | Audience | Format |
| --- | --- | --- |
| `/robots.txt` | search crawlers | robots exclusion standard, pointing at the sitemap |
| `/sitemap.xml` | search crawlers | every page, with change frequency |
| `/llms.txt` | AI assistants reading the site | the [llmstxt.org](https://llmstxt.org) convention: what the tool is, the facts worth getting right, the endpoints |
| `/openapi.json` | API catalogues, codegen, tool-calling agents | OpenAPI 3.1, every endpoint with request and response schemas |
| `/.well-known/agents.json` | agent runtimes | an agent card: skills, tags, examples, and the endpoint for each |
| `/.well-known/agent.json` | agent runtimes | the same card, at the older path |
| `/.well-known/mcp.json` | MCP hosts | the server descriptor, including the stdio command to install it |
| `/.well-known/create2-vanity.json` | verifiers | protocol versions, issuer keys, and every endpoint URL |
| `<script type="application/ld+json">` | search engines | schema.org `SoftwareApplication` on the landing page |

Check them against the live deployment:

```bash
curl -s https://create2-vanity.global-gargoyle.workers.dev/llms.txt
curl -s https://create2-vanity.global-gargoyle.workers.dev/.well-known/agents.json | jq '.skills[].id'
curl -s https://create2-vanity.global-gargoyle.workers.dev/openapi.json | jq '.paths | keys'
```

## Where to submit it

None of these are automatic. Each is a one-time submission, and each expects the
documents above to already be live.

| Registry | What it wants | Notes |
| --- | --- | --- |
| [npm](https://www.npmjs.com) | `npm publish` | The package name is the discovery surface. Keywords in `package.json` are what people search. |
| [MCP Registry](https://github.com/modelcontextprotocol/registry) | a `server.json` pointing at the npm package | The canonical index MCP hosts read. |
| [Smithery](https://smithery.ai) | the GitHub repository | Indexes MCP servers and runs them hosted. |
| [Glama](https://glama.ai/mcp/servers) | the GitHub repository | Crawls repositories for MCP servers automatically; a `/.well-known/mcp.json` helps. |
| [PulseMCP](https://www.pulsemcp.com) | a submission form | Human-curated directory. |
| [mcp.so](https://mcp.so) | a submission form | Directory with search. |
| [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | a pull request | The list most people actually browse. |
| GitHub topics | repository settings | The topics on the repository are what GitHub search matches. |

## Keeping it honest

Every document is generated from one module (`server/discovery.mjs`) and the
tests assert that the skills in the agent card point at endpoints that exist and
that the MCP descriptor lists the tools the server actually registers. A stale
discovery document is worse than none: it sends an agent to a path that 404s.
