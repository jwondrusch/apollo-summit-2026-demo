import assert from 'node:assert/strict';
import { startDemo } from './server.js';
import { registry } from './registry.js';

const demo = await startDemo({ port: 0, subgraphPorts: { products: 0, orders: 0, approvals: 0 }, writeSchema: false });
const variables = { products: [
  { id: 'PRODUCT_002', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_003', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_004', reason: 'Discontinued product' },
] };
async function gql(body, headers = {}) {
  return (await fetch(`${demo.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': 'editor', ...headers }, body: JSON.stringify(body) })).json();
}
function show(title, value) { console.log(`\n${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`); }
try {
  show('1. Find the duplicates through a registered, federated operation', await gql({ extensions: { registeredOperation: 'ProductsByName' }, variables: { term: 'Lamp' } }));
  const before = { ...demo.stats };
  const preview = await gql({ query: registry.ArchiveProducts.document, variables }, { 'Apollo-Expose-Query-Plan': 'dry-run' });
  assert.deepEqual(demo.stats, before);
  show('2. Ask the operation before running it (zero subgraph calls)', preview.extensions.operationMeta);
  show('Real query plan', preview.extensions.apolloQueryPlan.text);
  const permissions = await gql({ query: registry.ComparePermissions.document, variables: { ...variables, ids: ['PRODUCT_002'] } }, { 'Apollo-Expose-Query-Plan': 'dry-run' });
  show('3. Archive is allowed; delete is admin-only', permissions.extensions.operationMeta);
  show('4. A write without reviewer approval is rejected', await gql({ query: registry.ArchiveProducts.document, variables }));
  const requested = await gql({ query: 'mutation($d: String!, $v: JSON!) { requestApproval(document: $d, variables: $v) { id status preview } }', variables: { d: registry.ArchiveProducts.document, v: variables } });
  const id = requested.data.requestApproval.id;
  show('5. Request a reviewer preview', requested);
  // This walkthrough explicitly simulates the human decision. The browser demo
  // waits for the presenter to click Reviewer: approve instead.
  await fetch(`${demo.url}/api/approvals/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': 'admin' }, body: JSON.stringify({ approved: true }) });
  const approved = await gql({ query: 'query($id: ID!) { approval(id: $id) { token } }', variables: { id } });
  const result = await gql({ query: registry.ArchiveProducts.document, variables }, { 'x-approval': approved.data.approval.token });
  assert.equal(result.data.archiveProducts.archived, 2);
  assert.equal(result.data.archiveProducts.skipped, 1);
  show('6. Simulated reviewer says yes → 2 archived, 1 skipped, with an actionable error', result);
  show('7. Verify the resulting products', await gql({ extensions: { registeredOperation: 'ProductsByName' }, variables: { term: '' } }));
  console.log('\nWalkthrough passed. No external service or model was called.');
} finally { await demo.stop(); }
