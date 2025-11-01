// Centralized runtime type guards used across the codebase

// True for plain object-like records (not null, not arrays)
export function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Narrow a value to an object with a string `name` property
export function hasName(
  v: unknown
): v is Record<string, unknown> & { name: string } {
  return isObjectRecord(v) && typeof v["name"] === 'string'
}
