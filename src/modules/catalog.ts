import type { Module } from '../core/registry.js';

// Late-bound module catalogue. Modules and the lifecycle actions need to look up each other without
// creating import cycles, so the catalogue is registered once by modules/index.ts.
let catalog: Module[] = [];
export function setModuleCatalog(next: Module[]) { catalog = next; }
export function moduleCatalog() { return catalog; }
