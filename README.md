# @sitetus/collector (Node.js)

Read-only collector for the [Sitetus](https://sitetus.com) monitoring panel. It lets the panel read a package inventory and a few health rows from **inside** a Node.js project, through signed requests the panel sends. It is optional: the panel works without it; the collector only adds inventory and inside-the-server health data.

```bash
npm install @sitetus/collector
npx @sitetus/collector pair <pairing-code>
```

## What this package will not do

A public commitment, enforced by the code and its tests:

- It never reads or transmits `.env` files or configuration values. Environment variables are reported as classes and flags only: `NODE_ENV` is production / development / test / unset / other, `DEBUG` is set or not, the inspector is on or off — never a value.
- It never transmits file contents or absolute paths — only counts, flags, hashes and the directory names `public`, `static`, `dist`, `build`, `out`.
- It never reads a database and never collects personal data.
- It never makes outbound requests on its own.
- It never stores a secret on the server: the configuration holds a public key and an identifier.
- It never writes anything except its optional nonce file.
- It never uses a request parameter as a path, command or import target, and never runs project code (lockfiles are parsed as text).
- Unsigned or invalid requests get an empty `404`, exactly as if the route did not exist.
- The code is open source (MIT).

## How it works

- Your app mounts the collector on a **random path** (`/<path>`) that comes from the pairing code.
- The panel sends a **signed** `GET` request there a few times a day; the collector verifies the signature with the embedded **public key** (Ed25519, or RSA-SHA256 as fallback) and answers with a read-only JSON envelope.
- Every unsigned or invalid request gets a bodyless `404`. No secret lives on your server.
- The collector serves `GET`, `HEAD` and `POST` on its own path only, and reads at most 1 MiB of request body (`MAX_BODY`): the method and the path are decided before a byte is read, and a larger body — announced or streamed — gets the same bodyless `404`.
- Panel requests come from fixed IPs: `https://sitetus.com/ips.txt`

The signed material, the header set, the 404/403 policy, expiry and the 90-day sleep rule are the same as the PHP collector's. Level 1 only: file system and process state, no framework bootstrap.

## Install and pair

```bash
npm install @sitetus/collector
npx @sitetus/collector pair <pairing-code>
```

`pair` writes `sitetus.collector.json` next to your `package.json` (public key, project key, algorithm, path, expiry, modules). Commit it or ship it with the deployment — it contains nothing secret. On hosts without a writable file system, put the same JSON into the `SITETUS_COLLECTOR_CONFIG` environment variable instead.

### Express / Connect

```ts
import express from 'express';
import { createCollector } from '@sitetus/collector';

const app = express();
const sitetusCollector = createCollector();

app.use(sitetusCollector.express()); // answers only on /<path>, calls next() otherwise
```

### Next.js (App Router)

`app/<path>/route.ts` — the folder name is the path from `sitetus.collector.json`:

```ts
import { createCollector } from '@sitetus/collector';

export const { GET, dynamic } = createCollector().nextRouteHandler();
```

### Next.js (Pages Router)

`pages/api/<path>.ts`:

```ts
import { createCollector } from '@sitetus/collector';

export default createCollector().nextPagesHandler();
```

The signed path is then `/api/<path>`; enter the URL with the `/api/` prefix in the panel.

### Fastify

```ts
await app.register(createCollector().fastify());
```

### Node `http`, Hono, Remix, SvelteKit, edge functions

```ts
const handler = createCollector().nodeHttp(); // (req, res) => Promise<boolean>: false = not my path
const fetchHandler = createCollector().fetch(); // (request: Request) => Promise<Response>
```

`fetch()` is the web-standard form; wire it into whatever routes a `Request` to your random path. It needs a runtime with `node:crypto` (`crypto.verify`): Node, Vercel/Netlify Node functions, Cloudflare Workers with `nodejs_compat`.

## Static hosting and serverless: the manifest

When the file system is not readable at request time (edge functions, bundled serverless, static export with a tiny API route), the inventory is taken **at build time**:

```bash
npx @sitetus/collector manifest   # writes sitetus.manifest.json next to package.json
```

Bundle the file with the deployment, or put its JSON into `SITETUS_COLLECTOR_MANIFEST`. At request time the collector prefers live reads and falls back to the manifest; the envelope says so (`meta.warnings: ["msg.manifest_used"]`), and the health rows that need the file system are reported as `unknown` instead of guessed.

## Nonce store

Replays are refused with `403` + `X-Sitetus-Error: nonce`. By default the seen nonces live **in memory** (last 1000, pruned after twice the clock-skew window). That store cannot see other instances: with several containers, a cluster or serverless functions, a nonce accepted by one instance is unknown to the next one — the ±10-minute timestamp window the panel and the verifier enforce is the real guard there. Set `SITETUS_NONCE_FILE=/var/lib/myapp/.sitetus-nonce.json` (a path outside the web root, writable by the app) to persist nonces across restarts in a single-host deployment; this also enables the 90-day sleep rule (no valid request for 90 days → `404` until re-paired), which is otherwise not applicable.

## What the envelope contains

`collector` (name, version, SHA-256 of the running entry file), `runtime` (Node version, platform), `framework` (next/nuxt/remix/sveltekit/astro/nestjs/hono/fastify/koa/express/unknown, from `package.json` and the lockfile), `packages` (npm, from `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` — name and exact version, production first; declared ranges from `package.json` when no lockfile exists), and `health.checks`: `node_env`, `inspector_enabled`, `debug_env`, `source_maps`, `env_in_public`, `lockfile_missing`, `outdated_lockfile`, `git_dir_in_root`. Each row is a status plus numbers and flags.

## Uninstall

Remove the package and `sitetus.collector.json`; the panel side can also revoke the collector with one click.

## Verification

The envelope reports the SHA-256 of the running entry file (`collector.file_hash`); the panel compares it with the official hashes of the published build (one per shipped entry file: `dist/index.js`, `dist/index.cjs`, `dist/cli.js`, `dist/cli.cjs`). You can compute them yourself from the npm tarball with `sha256sum`.

## Requirements

Node ≥ 18, zero runtime dependencies. Ed25519 and RSA-SHA256 signatures are verified with `node:crypto`.

## Development

```bash
npm install
npm test          # build + typecheck + node:test (130 tests, incl. an HTTP end-to-end pull of examples/express)
npm run fixture   # regenerates test/fixtures/envelope-express.json from a real pull
npm pack          # the tarball the owner publishes
```

Security reports: write to **security@sitetus.com**; please do not open a public issue.

## License

MIT — `LICENSE`.
