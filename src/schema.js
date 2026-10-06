import { readFileSync } from 'node:fs';
import { parse } from 'graphql';
import { composeServices } from '@apollo/composition';

const shared = readFileSync(new URL('../schema/agent.graphql', import.meta.url), 'utf8');
export const names = ['products', 'orders', 'approvals'];
export const definitions = Object.fromEntries(names.map(name => [name,
  parse(shared + '\n' + readFileSync(new URL(`../schema/${name}.graphql`, import.meta.url), 'utf8')),
]));
export function compose(urls) {
  const result = composeServices(names.map(name => ({ name, url: urls[name], typeDefs: definitions[name] })));
  if (result.errors) throw new AggregateError(result.errors, 'Federation composition failed');
  return result.supergraphSdl;
}
