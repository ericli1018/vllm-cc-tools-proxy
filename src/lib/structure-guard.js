import { HttpError } from './http.js';

export const MAX_REQUEST_STRUCTURE_DEPTH = 128;

export function assertRequestStructureDepth(depth, maxDepth = MAX_REQUEST_STRUCTURE_DEPTH) {
  if (!Number.isInteger(depth) || depth < 0) return;
  if (depth <= maxDepth) return;
  throw new HttpError(422, 'Request content nesting exceeds the supported depth.', {
    code: 'request_structure_too_deep',
    details: { max_depth: maxDepth },
  });
}

export function enterRequestStructure(value, ancestors, depth, maxDepth = MAX_REQUEST_STRUCTURE_DEPTH) {
  assertRequestStructureDepth(depth, maxDepth);
  if (!value || typeof value !== 'object') return () => {};
  if (ancestors.has(value)) {
    throw new HttpError(422, 'Request content contains a cyclic structure.', {
      code: 'request_structure_cycle',
    });
  }
  ancestors.add(value);
  return () => ancestors.delete(value);
}
