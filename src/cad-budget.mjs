import { MiB } from '../public/cad-limits.mjs';

export const dwgSectionLimit = 256 * MiB;
export const dxfExportBytes = 256 * MiB;
export const dwgIndexLimit = 1_000_000;
export const modelRecordLimit = 300_000;
export const sceneLimits = { entityLimit: 300_000, geometryLimit: 1_000_000, textLimit: 1_200_000 };
export const exbLimits = { expandedBytes: 256 * MiB, records: 150_000, items: 100_000, segments: 450_000, characters: 750_000 };
export const dwfxLimits = { expandedBytes: 256 * MiB, pages: 64, elementsPerPart: 100_000 };
export const meshLimits = { triangles: 500_000, vertices: 750_000, instances: 200_000 };
