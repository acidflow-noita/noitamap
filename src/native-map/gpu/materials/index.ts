export { createCertifiedMaterialEngine, prepareCertifiedMaterialSetup } from './certified-engine.ts';
export { materialAxisCacheStatistics } from './axis-cache.mjs';
export type CertifiedMaterialEngine = Awaited<ReturnType<typeof import('./certified-engine.ts').createCertifiedMaterialEngine>>;
