const $ = id => document.getElementById(id);
const registry = await (await fetch('/api/operations')).json();
const archiveVariables = { products: [
  { id: 'PRODUCT_002', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_003', reason: 'DUPLICATE_OF PRODUCT_001' },
  { id: 'PRODUCT_004', reason: 'Discontinued product' },
] };
let result, view = 'full', approvalId, approvalCaller, token;
for (const name of Object.keys(registry)) $('operation').add(new Option(name, name));
function select(name) {
  $('operation').value = name; $('document').value = registry[name].document;
  $('variables').value = JSON.stringify(name === 'ProductsByName' ? { term: 'Lamp', collection: 'DEMO' }
    : name === 'DeleteProducts' ? { ids: ['PRODUCT_002'] }
    : name === 'ComparePermissions' ? { ...archiveVariables, ids: ['PRODUCT_002'] } : archiveVariables, null, 2);
  document.querySelectorAll('.scenario').forEach(el => el.classList.toggle('active', el.dataset.scenario === name));
}
function render() {
  $('output').textContent = view === 'plan' ? result?.extensions?.apolloQueryPlan?.text ?? '// Dry run to see the real federation query plan.'
    : JSON.stringify(view === 'meta' ? result?.extensions?.operationMeta ?? { note: 'Dry run to see operation metadata.' } : result, null, 2);
}
async function refreshStats() { $('stats').textContent = JSON.stringify(await (await fetch('/api/stats')).json(), null, 2); }
async function graphql(body, headers = {}, caller = $('caller').value) {
  const response = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': caller, ...headers }, body: JSON.stringify(body) });
  const json = await response.json();
  await refreshStats();
  return json;
}
function current() { return { query: $('document').value, variables: JSON.parse($('variables').value), operationName: $('operation').value }; }
function show(json, tag) { result = json; $('result-tag').textContent = tag; render(); }
async function action(fn) {
  try { await fn(); } catch (error) { $('notice').textContent = error.message; }
}
$('operation').onchange = () => select($('operation').value);
document.querySelectorAll('.scenario').forEach(el => { el.onclick = () => select(el.dataset.scenario); });
document.querySelectorAll('[data-view]').forEach(el => { el.onclick = () => {
  view = el.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('selected', b === el)); render();
}; });
$('dry-run').onclick = () => action(async () => {
  const json = await graphql(current(), { 'Apollo-Expose-Query-Plan': 'dry-run' });
  show(json, 'DRY RUN'); $('notice').textContent = json.errors ? 'Request rejected. Read the errors.' : 'Planned, never executed. No subgraph request was made.';
});
$('execute').onclick = () => action(async () => {
  const json = await graphql(current(), token ? { 'x-approval': token } : {});
  show(json, json.errors ? 'ERROR / PARTIAL' : 'EXECUTED');
  $('notice').textContent = json.data?.archiveProducts ? `${json.data.archiveProducts.archived} archived, ${json.data.archiveProducts.skipped} skipped. Inspect errors for the exact input.`
    : json.errors ? 'The graph explains what stopped this operation.' : 'Operation completed.';
  if (approvalId) {
    const approval = await graphql({ query: 'query($id: ID!) { approval(id: $id) { status } }', variables: { id: approvalId } }, {}, approvalCaller);
    const status = approval.data?.approval?.status;
    if (status === 'USED' || status === 'EXPIRED') {
      token = undefined;
      $('approval-status').textContent = `${status === 'USED' ? 'Used' : 'Expired'} · request a new approval for another write`;
    }
  }
});
$('request-approval').onclick = () => action(async () => {
  const request = current(); approvalCaller = $('caller').value;
  const json = await graphql({ query: 'mutation RequestApproval($document: String!, $variables: JSON!, $operationName: String) { requestApproval(document: $document, variables: $variables, operationName: $operationName) { id status preview expiresAt } }',
    variables: { document: request.query, variables: request.variables, operationName: request.operationName } });
  show(json, 'APPROVAL REQUEST');
  const approval = json.data?.requestApproval;
  if (!approval) { $('notice').textContent = 'Approval request rejected. Read the response.'; return; }
  approvalId = approval.id; token = undefined;
  $('preview').textContent = JSON.stringify(approval.preview, null, 2);
  $('approval-status').textContent = 'Pending reviewer decision'; $('reviewer').open = true;
  $('approve').disabled = false; $('deny').disabled = false;
  $('notice').textContent = 'The request is pending. The reviewer must review the exact operation below.';
});
async function decide(approved) {
  const response = await fetch(`/api/approvals/${approvalId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': 'admin' }, body: JSON.stringify({ approved }) });
  if (!response.ok) throw Error(JSON.stringify(await response.json()));
  const json = await graphql({ query: 'query($id: ID!) { approval(id: $id) { id status token expiresAt } }', variables: { id: approvalId } }, {}, approvalCaller);
  token = json.data?.approval?.token;
  $('approval-status').textContent = approved ? 'Approved · token attached to next matching execution' : 'Declined · no token issued';
  $('approve').disabled = true; $('deny').disabled = true;
  $('notice').textContent = approved ? 'Reviewer approved. Execute the unchanged document and variables as the original caller.' : 'Reviewer declined. Nothing was executed.';
}
$('approve').onclick = () => action(() => decide(true));
$('deny').onclick = () => action(() => decide(false));
$('reset').onclick = () => action(async () => {
  await fetch('/api/reset', { method: 'POST' }); token = undefined; approvalId = undefined;
  $('approve').disabled = true; $('deny').disabled = true; $('reviewer').open = false;
  $('approval-status').textContent = 'No pending request'; $('preview').textContent = 'Request approval to create a preview.';
  $('notice').textContent = 'Demo data restored. Approvals and request counters cleared.';
  show({ reset: true }, 'RESET'); await refreshStats();
});
select('ProductsByName'); await refreshStats();
