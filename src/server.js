import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloGateway, RemoteGraphQLDataSource } from '@apollo/gateway';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { GraphQLScalarType, valueFromASTUntyped } from 'graphql';
import { definitions, compose } from './schema.js';
import { createInspector, identity, problem } from './operation-meta.js';
import { createApprovals } from './approvals.js';
import { companyModelPlugin, partialSuccessPlugin } from './plugins.js';
import { createProducts, ordersForProduct } from './products.js';
import { registry } from './registry.js';

export async function startDemo({ port = 4000, subgraphPorts = { products: 4001, orders: 4002, approvals: 4003 }, writeSchema = true } = {}) {
  // Keep this local stage demo offline, including Gateway's metrics exporter.
  process.env.APOLLO_TELEMETRY_DISABLED = 'true';
  const cleanup = [];
  const stats = { products: 0, orders: 0, approvals: 0 };
  const secret = randomBytes(32).toString('hex');
  const products = createProducts();
  const approvals = createApprovals();
  let inspector;
  async function mount(app, apollo, listenPort, context) {
    await apollo.start();
    cleanup.push(() => apollo.stop());
    app.use('/graphql', expressMiddleware(apollo, { context }));
    const http = createServer(app);
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(listenPort, '127.0.0.1', resolve); });
    cleanup.push(() => new Promise((resolve, reject) => http.close(err => err ? reject(err) : resolve())));
    return `http://127.0.0.1:${http.address().port}`;
  }
  async function subgraph(name, resolvers) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.get('x-demo-internal') !== secret) return res.status(403).json({ error: 'Use the gateway.' });
      stats[name]++; next();
    });
    const apollo = new ApolloServer({ schema: buildSubgraphSchema([{ typeDefs: definitions[name], resolvers }]),
      includeStacktraceInErrorResponses: false, plugins: [partialSuccessPlugin] });
    const base = await mount(app, apollo, subgraphPorts[name], async ({ req }) => ({
      caller: identity(req.get('x-demo-user')), partialErrors: [],
    }));
    return `${base}/graphql`;
  }
  async function stop() {
    for (const close of cleanup.reverse()) await close();
  }
  try {
    const orders = await subgraph('orders', {
      Query: { openOrdersForProduct: (_, { productId }) => ordersForProduct(productId) },
      Product: { __resolveReference: ref => ref, openOrders: product => ordersForProduct(product.id) },
    });
    const productsUrl = await subgraph('products', products.resolvers(async productId => {
      try {
        const result = await fetch(orders, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-internal': secret },
          body: JSON.stringify({ query: 'query($id: ID!) { openOrdersForProduct(productId: $id) { id variantIds } }', variables: { id: productId } }),
          signal: AbortSignal.timeout(3000),
        });
        const body = await result.json();
        if (!result.ok || body.errors || !Array.isArray(body.data?.openOrdersForProduct)) throw Error('Order check failed');
        return body.data.openOrdersForProduct;
      } catch {
        throw problem('ORDERS_UNAVAILABLE', 'Unable to check open orders. No products changes were applied.', { retryable: true });
      }
    }));
    const approvalsUrl = await subgraph('approvals', {
      JSON: new GraphQLScalarType({ name: 'JSON', serialize: v => v, parseValue: v => v, parseLiteral: valueFromASTUntyped }),
      Query: { approval: (_, { id }, { caller }) => approvals.read(id, caller) },
      Mutation: { requestApproval: (_, input, { caller }) => approvals.request(inspector, input, caller) },
    });
    const urls = { products: productsUrl, orders, approvals: approvalsUrl };
    const supergraphSdl = compose(urls);
    inspector = createInspector(supergraphSdl);
    if (writeSchema) {
      await mkdir(new URL('../generated/', import.meta.url), { recursive: true });
      await writeFile(new URL('../generated/supergraph.graphql', import.meta.url), supergraphSdl);
    }
    const gateway = new ApolloGateway({ supergraphSdl, buildService({ url }) {
      return new class extends RemoteGraphQLDataSource {
        willSendRequest({ request, context }) {
          request.http.headers.set('x-demo-internal', secret);
          request.http.headers.set('x-demo-user', context.caller?.id ?? 'editor');
        }
      }({ url });
    } });
    const apollo = new ApolloServer({ gateway, includeStacktraceInErrorResponses: false,
      plugins: [companyModelPlugin(inspector, approvals)] });
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.get('/api/operations', (_, res) => res.json(registry));
    app.get('/api/stats', (_, res) => res.json(stats));
    app.get('/api/approvals', (_, res) => res.json(approvals.pending().map(({ id, preview, expiresAt, callerId }) => ({ id, preview, expiresAt, callerId }))));
    app.post('/api/approvals/:id/decision', (req, res) => {
      if (typeof req.body.approved !== 'boolean') return res.status(400).json({ error: 'approved must be a Boolean' });
      try { res.json(approvals.decide(req.params.id, req.body.approved, identity(req.get('x-demo-user')))); }
      catch (error) { res.status(403).json({ errors: [error.toJSON()] }); }
    });
    app.post('/api/reset', (_, res) => {
      products.reset(); approvals.reset(); Object.keys(stats).forEach(k => { stats[k] = 0; });
      res.json({ reset: true });
    });
    app.use('/docs', express.static(new URL('../docs/', import.meta.url).pathname));
    app.use('/skills', express.static(new URL('../skills/', import.meta.url).pathname));
    app.use(express.static(new URL('../public/', import.meta.url).pathname));
    app.use('/graphql', (req, res, next) => {
      const name = req.body?.extensions?.registeredOperation;
      if (name !== undefined) {
        const entry = Object.hasOwn(registry, name) ? registry[name] : null;
        if (!entry || req.body.query) return res.status(400).json({ errors: [{ message: 'Unknown registered operation, or query supplied alongside it.' }] });
        req.body.query = entry.document;
        req.body.operationName = entry.name;
      }
      next();
    });
    const url = await mount(app, apollo, port, async ({ req }) => ({ caller: identity(req.get('x-demo-user')) }));
    return { url, urls, stop, stats, inspector, approvals, products, supergraphSdl };
  } catch (error) { await stop(); throw error; }
}
