import { readFileSync } from 'node:fs';
export const registry = Object.fromEntries([
  ['ProductsByName', 'Find products and services by name. Read-only. Use before cleanup.'],
  ['ArchiveProducts', 'Archive up to 25 products. Reversible write. Requires reviewer approval.'],
  ['DeleteProducts', 'Permanent deletion. Admin only. Never use for cleanup.'],
  ['ComparePermissions', 'Preview archive and delete permissions together. Use dry-run.'],
].map(([name, description]) => [name, { name, description,
  document: readFileSync(new URL(`../operations/${name}.graphql`, import.meta.url), 'utf8'),
}]));
