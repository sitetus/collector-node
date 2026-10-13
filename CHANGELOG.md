# Changelog

## 0.1.3 — 2026-10-13

Packaging only; the code is identical to 0.1.2. The tarball carries the build, README, changelog and licence, nothing else.

## 0.1.2 — 2026-10-13

First release on npm, as **`@sitetus/collector`** (organisation scope; the unscoped name was never used). The code is identical to 0.1.1. The CLI command is `sitetus-collector`; call it as `npx @sitetus/collector pair …`.

- README in one language (English); the duplicated Turkish install section is gone — the panel carries the Turkish steps.
- The verification section no longer refers to a CI job; the official hash of every shipped entry file is published with the panel.
- `package.json`: `bin` path without the `./` prefix (npm 11 dropped the entry on publish); repository `github.com/sitetus/collector-node`.

## 0.1.1 — 2026-10-05

Hardening before the first publish. Envelope, signature material and the 404/403 policy are unchanged.

- One request-body policy for every adapter (`src/body.ts`, exported `MAX_BODY` = 1 MiB, the Python collector's figure): method and path are decided before a byte is read, a `Content-Length` above the cap is refused without reading, a body of unknown length is read up to the cap and cancelled there, and anything over the cap, cut short or already consumed by the host is the same bodyless `404` as an unknown route — the signature is never checked against a partial body. The `fetch` / Next.js App Router adapter used to buffer the whole body with `arrayBuffer()` before any decision.
- Express, Node `http`, Next.js Pages and Fastify adapters now read the request stream themselves (capped); before, they verified against an empty body unless the host supplied `rawBody`. A body the host already consumed is a `404` unless it kept the bytes in `rawBody`.
- Only `GET`, `HEAD` and `POST` are served (`ALLOWED_METHODS`); any other method on the collector path is a `404` without reading, also when signed. `Collector.handle()` applies the same method, path and size rules to direct callers; `Collector.admits()` and `Collector.serves()` expose the gate.
- Express adapter: an error after the response has started is passed to `next(error)` instead of being swallowed.
- Configuration: the pairing code and a hand-written configuration (file, `SITETUS_COLLECTOR_CONFIG`, object) pass through one validation. A malformed `nonce_file` is now an error on the manual path too (it was dropped silently), and on both paths the public key must be usable for the declared algorithm (raw 32-byte Ed25519 key in base64, or an RSA PEM).

## 0.1.0 — 2026-10-03

First release. Level 1 only (file system and process state, no framework bootstrap).

- Signed pull verification identical to the PHP collector 0.7.0 (`RequestVerifier`): Ed25519 and RSA-SHA256 through `node:crypto`, constant-time comparisons, 404 / 403 skew / 403 nonce / 403 nonce-store, `expires_at`, 90-day sleep with the file nonce store.
- Nonce stores: in-memory (default, last 1000, window-pruned) and file (`SITETUS_NONCE_FILE`, PHP JSON layout).
- Pairing: `npx sitetus-collector pair <code>` decodes the panel's base64url pairing code (WordPress plugin rules, optional `path`) into `sitetus.collector.json`; `SITETUS_COLLECTOR_CONFIG` for hosts without a file system.
- Envelope: `sitetus-node`, `runtime.node_version`, framework detection (nextjs, nuxt, remix, sveltekit, astro, nestjs, hono, fastify, koa, express), npm inventory from package-lock.json v1/v2/v3, yarn classic and berry, pnpm v5/v6/v9, package.json ranges as the last resort; health rows `node_env`, `inspector_enabled`, `debug_env`, `source_maps`, `env_in_public`, `lockfile_missing`, `outdated_lockfile`, `git_dir_in_root`.
- Build-time manifest: `npx sitetus-collector manifest` → `sitetus.manifest.json` / `SITETUS_COLLECTOR_MANIFEST`, used when the file system is not readable at request time.
- Adapters: Express/Connect middleware, Node `http`, web `Request → Response`, Next.js App Router route handler, Next.js Pages API handler, Fastify plugin.
- ESM + CJS builds, zero runtime dependencies, Node ≥ 18.
