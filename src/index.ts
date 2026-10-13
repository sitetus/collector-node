import { express, fastify, fetchHandler, nextPagesHandler, nextRouteHandler, nodeHttp } from './adapters.js';
import { createCollector as createCore, type Collector, type CollectorOptions } from './collector.js';

export interface SitetusCollector extends Collector {
  express: () => ReturnType<typeof express>;
  nodeHttp: () => ReturnType<typeof nodeHttp>;
  fetch: () => ReturnType<typeof fetchHandler>;
  nextRouteHandler: () => ReturnType<typeof nextRouteHandler>;
  nextPagesHandler: () => ReturnType<typeof nextPagesHandler>;
  fastify: () => ReturnType<typeof fastify>;
}

/**
 * Creates the collector and binds the transport adapters to it:
 *
 *   const sitetusCollector = createCollector();
 *   app.use(sitetusCollector.express());
 */
export function createCollector(options: CollectorOptions = {}): SitetusCollector {
  const core = createCore(options);

  return {
    ...core,
    express: () => express(core),
    nodeHttp: () => nodeHttp(core),
    fetch: () => fetchHandler(core),
    nextRouteHandler: () => nextRouteHandler(core),
    nextPagesHandler: () => nextPagesHandler(core),
    fastify: () => fastify(core),
  };
}

export { ALLOWED_METHODS, MAX_BODY, readNodeBody, readWebBody, serveRequest, type BodyReader, type RequestHead } from './body.js';
export { buildEnvelope, type Collector, type CollectorOptions } from './collector.js';
export { CONFIG_ENV, CONFIG_FILE, PATH_PATTERN, configFromPairing, decodePairingCode, loadConfig, normalizeConfig, type PairingPayload } from './config.js';
export { MANIFEST_ENV, MANIFEST_FILE, buildManifest, loadManifest, parseManifest } from './manifest.js';
export { FileNonceStore, MAX_ENTRIES, MemoryNonceStore, WINDOW_SECONDS } from './nonce.js';
export { RequestVerifier, SKEW_SECONDS, SLEEP_AFTER_SECONDS, normalizeHeaders, sha256Hex, signatureMaterial, signatureValid } from './verify.js';
export { BUDGET_MS, COLLECTOR_NAME, SCHEMA_VERSION, VERSION } from './version.js';
export { express, fastify, fetchHandler, nextPagesHandler, nextRouteHandler, nodeHttp, pathOf } from './adapters.js';
export * from './types.js';
