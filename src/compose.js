import { mkdir, writeFile } from 'node:fs/promises';
import { compose } from './schema.js';
const sdl = compose({ products: 'http://127.0.0.1:4001/graphql', orders: 'http://127.0.0.1:4002/graphql', approvals: 'http://127.0.0.1:4003/graphql' });
await mkdir(new URL('../generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../generated/supergraph.graphql', import.meta.url), sdl);
console.log('Composed generated/supergraph.graphql (custom directives preserved).');
