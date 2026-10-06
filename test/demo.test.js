import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDemo } from '../src/server.js';
import { registry } from '../src/registry.js';
import { createApprovals } from '../src/approvals.js';
import { identity, approvalBinding } from '../src/operation-meta.js';
import { createProducts } from '../src/products.js';

let demo;
const variables = { products: [
  { id: 'PRODUCT_002', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_003', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_004', reason: 'Discontinued product' },
] };
const archive = { query: registry.ArchiveProducts.document, variables, operationName: 'ArchiveProducts' };
const dry = { 'Apollo-Expose-Query-Plan': 'dry-run' };
async function gql(body, headers = {}, caller = 'editor') {
  const response = await fetch(`${demo.url}/graphql`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-demo-user': caller, ...headers,
  }, body: JSON.stringify(body) });
  return response.json();
}
async function request(body = archive, caller = 'editor') {
  const result = await gql({
    query: 'mutation($d: String!, $v: JSON!, $n: String) { requestApproval(document: $d, variables: $v, operationName: $n) { id status token preview } }',
    variables: { d: body.query, v: body.variables ?? {}, n: body.operationName },
  }, {}, caller);
  assert.equal(result.errors, undefined, JSON.stringify(result));
  return result.data.requestApproval;
}
async function decision(id, approved = true, caller = 'admin') {
  return fetch(`${demo.url}/api/approvals/${id}/decision`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-demo-user': caller,
  }, body: JSON.stringify({ approved }) });
}
async function approve(body = archive, caller = 'editor') {
  const approval = await request(body, caller);
  assert.equal(approval.status, 'PENDING'); assert.equal(approval.token, null);
  assert.equal((await decision(approval.id)).status, 200);
  const result = await gql({ query: 'query($id: ID!) { approval(id: $id) { token } }', variables: { id: approval.id } }, {}, caller);
  return result.data.approval.token;
}
before(async () => { demo = await startDemo({ port: 0, subgraphPorts: { products: 0, orders: 0, approvals: 0 }, writeSchema: false }); });
after(async () => { await demo?.stop(); });
beforeEach(() => { demo.products.reset(); demo.approvals.reset(); });

test('real federated registered query joins products to orders and resolves a union', async () => {
  const r = await gql({ extensions: { registeredOperation: 'ProductsByName' }, variables: { term: '' } });
  assert.equal(r.errors, undefined);
  assert.equal(r.data.searchOfferings.nodes.find(i => i.id === 'PRODUCT_004').openOrders[0].id, 'ORDER_001');
  assert.equal(r.data.searchOfferings.nodes.find(i => i.id === 'SERVICE_001').__typename, 'Service');
});
test('dry-run returns a real products → orders plan and composed metadata without subgraph calls', async () => {
  const before = { ...demo.stats };
  const r = await gql(archive, dry);
  assert.equal(r.errors, undefined, JSON.stringify(r));
  assert.equal(r.data, undefined);
  assert.match(r.extensions.apolloQueryPlan.text, /Fetch\(service: "products"\)/);
  assert.match(r.extensions.apolloQueryPlan.text, /Fetch\(service: "orders"\)/);
  assert.equal(r.extensions.operationMeta['Mutation.archiveProducts'].approval.required, true);
  assert.equal(r.extensions.operationMeta['Mutation.archiveProducts'].skill, 'products');
  assert.equal(r.extensions.operationMeta['Product.openOrders'].permissions[0], 'orders:read');
  assert.deepEqual(demo.stats, before);
  assert.equal(demo.products.products.get('PRODUCT_002').archived, false);
});
test('permission comparison previews both fields; execution rejects the entire operation before writes', async () => {
  const body = { extensions: { registeredOperation: 'ComparePermissions' }, variables: { ...variables, ids: ['PRODUCT_002'] } };
  const r = await gql(body, dry);
  assert.equal(r.extensions.operationMeta['Mutation.archiveProducts'].allowed, true);
  assert.equal(r.extensions.operationMeta['Mutation.deleteProducts'].allowed, false);
  assert.equal(r.extensions.operationMeta['Mutation.deleteProducts'].reason, 'admin only');
  const before = { ...demo.stats };
  const denied = await gql(body);
  assert.equal(denied.errors[0].extensions.code, 'UNAUTHORIZED_FIELD_OR_TYPE');
  assert.deepEqual(demo.stats, before);
});
test('missing approval and forged tokens cannot execute a write', async () => {
  const before = { ...demo.stats };
  for (const headers of [{}, { 'x-approval': 'forged' }]) {
    assert.equal((await gql(archive, headers)).errors[0].extensions.code, 'APPROVAL_REQUIRED');
  }
  assert.deepEqual(demo.stats, before);
});
test('reviewer approval enables partial success, honest input addressing, and blocks replay', async () => {
  const token = await approve();
  const r = await gql(archive, { 'x-approval': token });
  assert.equal(r.data.archiveProducts.archived, 2, JSON.stringify(r));
  assert.equal(r.data.archiveProducts.skipped, 1);
  assert.deepEqual(r.errors[0].path, ['archiveProducts']);
  assert.equal(r.errors[0].extensions.inputPath, 'products[2].id');
  assert.equal(r.errors[0].extensions.entityPath, 'variants[0]');
  assert.equal(r.errors[0].extensions.code, 'VARIANT_IN_OPEN_ORDER');
  assert.equal(r.errors[0].extensions.retryable, false);
  assert.equal(demo.products.products.get('PRODUCT_002').archived, true);
  assert.equal(demo.products.products.get('PRODUCT_004').archived, false);
  assert.equal((await gql(archive, { 'x-approval': token })).errors[0].extensions.code, 'APPROVAL_REQUIRED');
});
test('partial-success errors follow the response alias, not the schema field name', async () => {
  const body = { ...archive, query: archive.query.replace('  archiveProducts(', '  cleanup: archiveProducts(') };
  const token = await approve(body);
  const r = await gql(body, { 'x-approval': token });
  assert.equal(r.data.cleanup.archived, 2);
  assert.deepEqual(r.errors[0].path, ['cleanup']);
  assert.equal(r.errors[0].extensions.inputPath, 'products[2].id');
});
test('dry-run with an approval token does not consume it', async () => {
  const token = await approve();
  const before = { ...demo.stats };
  await gql(archive, { ...dry, 'x-approval': token });
  assert.deepEqual(demo.stats, before);
  assert.equal((await gql(archive, { 'x-approval': token })).data.archiveProducts.archived, 2);
});
test('standard schema introspection remains available and carries field descriptions', async () => {
  const r = await gql({ query: '{ __type(name: "Product") { fields { name description } } }' });
  assert.equal(r.errors, undefined);
  assert.match(r.data.__type.fields.find(f => f.name === 'variants').description, /Price lives here/);
});
test('approval is bound to caller, variables, and document; mismatches do not consume it', async () => {
  const token = await approve();
  for (const [body, caller] of [
    [{ ...archive, variables: { products: [variables.products[0]] } }, 'editor'],
    [{ ...archive, query: archive.query.replace('archived skipped', 'archived') }, 'editor'],
    [archive, 'admin'],
  ]) assert.equal((await gql(body, { 'x-approval': token }, caller)).errors[0].extensions.code, 'APPROVAL_REQUIRED');
  assert.equal((await gql(archive, { 'x-approval': token })).data.archiveProducts.archived, 2);
});
test('editor cannot self-approve; declined requests never produce a token', async () => {
  const a = await request();
  assert.equal((await decision(a.id, true, 'editor')).status, 403);
  assert.equal((await decision(a.id, false)).status, 200);
  const r = await gql({ query: 'query($id: ID!) { approval(id: $id) { status token } }', variables: { id: a.id } });
  assert.deepEqual(r.data.approval, { status: 'DENIED', token: null });
});
test('approval requests for denied operations fail', async () => {
  const r = await gql({ query: 'mutation($d: String!, $v: JSON!) { requestApproval(document: $d, variables: $v) { id } }',
    variables: { d: registry.DeleteProducts.document, v: { ids: ['PRODUCT_002'] } } });
  assert.equal(r.errors[0].extensions.code, 'UNAUTHORIZED_FIELD_OR_TYPE');
});
test('aliases, fragments, conditional fields, defaults, and operationName drive introspection', async () => {
  const query = `mutation Chosen($skip: Boolean! = true) { ...Writes }
    fragment Writes on Mutation {
      safe: archiveProducts(products: [{id: "PRODUCT_002", reason: "duplicate"}]) { archived }
      dangerous: deleteProducts(ids: ["PRODUCT_002"]) @skip(if: $skip) { deleted }
    }
    mutation Unselected { deleteProducts(ids: ["PRODUCT_002"]) { deleted } }`;
  const r = await gql({ query, operationName: 'Chosen' }, dry);
  assert.ok(r.extensions.operationMeta['Mutation.archiveProducts']);
  assert.equal(r.extensions.operationMeta['Mutation.deleteProducts'], undefined);
  const denied = await gql({ query, operationName: 'Chosen', variables: { skip: false } });
  assert.deepEqual(denied.errors[0].path, ['dangerous']);
  const allowed = { query, operationName: 'Chosen', variables: { skip: true } };
  const token = await approve(allowed);
  assert.equal((await gql(allowed, { 'x-approval': token })).data.safe.archived, 1);
});
test('nested orders policy applies through inline fragments', async () => {
  const body = { extensions: { registeredOperation: 'ProductsByName' }, variables: { term: 'Lamp' } };
  const r = await gql(body, dry, 'viewer');
  assert.equal(r.extensions.operationMeta['Product.openOrders'].allowed, false);
  const before = { ...demo.stats };
  const denied = await gql(body, {}, 'viewer');
  assert.equal(denied.errors[0].extensions.policy, 'orders:read');
  assert.deepEqual(demo.stats, before);
});
test('invalid variables, unknown fields, and ambiguous operations never execute', async () => {
  const before = { ...demo.stats };
  for (const body of [
    { ...archive, variables: { products: [{ id: 'PRODUCT_002' }] } },
    { query: '{ nonexistent }' },
    { query: 'query One { __typename } query Two { __typename }' },
  ]) assert.ok((await gql(body, dry)).errors);
  assert.deepEqual(demo.stats, before);
  assert.equal((await gql({ ...archive, variables: {} }, dry)).errors[0].extensions.code, 'BAD_USER_INPUT');
});
test('batch cap rejects 26 inputs without changing state', async () => {
  const body = { ...archive, variables: { products: Array.from({ length: 26 }, () => variables.products[0]) } };
  const token = await approve(body);
  const r = await gql(body, { 'x-approval': token });
  assert.equal(r.errors[0].extensions.code, 'BATCH_SIZE_EXCEEDED');
  assert.equal(demo.products.products.get('PRODUCT_002').archived, false);
});
test('admin can preview and execute deletion only after approval', async () => {
  const body = { query: registry.DeleteProducts.document, variables: { ids: ['PRODUCT_002'] } };
  const r = await gql(body, dry, 'admin');
  assert.equal(r.extensions.operationMeta['Mutation.deleteProducts'].allowed, true);
  const token = await approve(body, 'admin');
  assert.equal((await gql(body, { 'x-approval': token }, 'admin')).data.deleteProducts.deleted, 1);
});
test('expired approval cannot be consumed', () => {
  let now = 0;
  const approvals = createApprovals({ now: () => now, ttlMs: 1000 });
  const caller = identity('editor');
  const a = approvals.request(demo.inspector, { document: archive.query, variables }, caller);
  approvals.decide(a.id, true, identity('admin'));
  const token = a.token;
  const analysis = demo.inspector.inspect(archive.query, variables, undefined, caller);
  now = 1001;
  assert.equal(approvals.consume(token, approvalBinding(analysis, caller)), false);
});
test('subgraphs cannot be called directly to bypass the gateway', async () => {
  const response = await fetch(demo.urls.products, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(archive) });
  assert.equal(response.status, 403);
});
test('downstream orders failure before the second product does not conceal an earlier write', async () => {
  const products = createProducts();
  let calls = 0;
  const resolver = products.resolvers(async () => { if (++calls === 2) throw Error('orders unavailable'); return []; }).Mutation.archiveProducts;
  await assert.rejects(resolver(null, { products: variables.products }, { partialErrors: [] }, { path: { key: 'archiveProducts' } }), /orders unavailable/);
  assert.equal(products.products.get('PRODUCT_002').archived, false);
});
