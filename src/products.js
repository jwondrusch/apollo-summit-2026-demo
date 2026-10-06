import { responsePathAsArray } from 'graphql';
import { problem } from './operation-meta.js';

export function createProducts() {
  const products = new Map();
  const services = [{ __typename: 'Service', id: 'SERVICE_001', name: 'Lamp installation', collectionId: 'DEMO' }];
  function reset() {
    products.clear();
    for (const [id, name, price] of [
      ['PRODUCT_001', 'Desk Lamp', 4900], ['PRODUCT_002', 'Lamp (Desk)', 4900],
      ['PRODUCT_003', 'Lamp – desk model', 4900], ['PRODUCT_004', 'Discontinued Table', 15900],
      ['PRODUCT_005', 'Office Chair', 12900],
    ]) products.set(id, { __typename: 'Product', id, name, collectionId: 'DEMO', archived: false,
      variants: [{ id: `${id}_V1`, sku: `${id}_REGULAR`, price }] });
  }
  reset();
  function search(input, onlyProducts = false) {
    return [...products.values(), ...(onlyProducts ? [] : services)].filter(product =>
      product.name.toLowerCase().includes(input.nameContains.toLowerCase()) &&
      (!input.collectionId || product.collectionId === input.collectionId) &&
      (!input.types?.length || input.types.includes(product.__typename === 'Product' ? 'PRODUCT' : 'SERVICE')),
    );
  }
  return {
    products, reset,
    resolvers(ordersForProduct) {
      async function change(inputs, context, info, deleting = false) {
        if (!inputs.length || inputs.length > 25) throw problem('BATCH_SIZE_EXCEEDED', 'Submit between 1 and 25 products per previewed batch.', { inputPath: deleting ? 'ids' : 'products' });
        const seen = new Set();
        const changed = [];
        for (const [index, input] of inputs.entries()) {
          const product = products.get(input.id);
          let failure;
          if (seen.has(input.id)) failure = problem('DUPLICATE_INPUT', 'Product occurs more than once in this batch.');
          else if (!product) failure = problem('PRODUCT_NOT_FOUND', 'Product was not found.');
          else if (!deleting && !input.reason.trim()) failure = problem('REASON_REQUIRED', 'Provide an archive reason.');
          else if (!deleting && product.archived) failure = problem('ALREADY_ARCHIVED', 'Product is already archived; do not retry it.');
          seen.add(input.id);
          if (!failure) {
            const orders = await ordersForProduct(input.id);
            if (orders.length) {
              const variantIndex = product.variants.findIndex(v => orders.some(o => o.variantIds.includes(v.id)));
              failure = problem('VARIANT_IN_OPEN_ORDER', 'Variant is in an open order', {
                inputPath: deleting ? `ids[${index}]` : `products[${index}].id`,
                entityPath: `variants[${Math.max(0, variantIndex)}]`,
                productId: input.id, orderIds: orders.map(o => o.id),
              });
            }
          }
          if (failure) {
            context.partialErrors.push({ message: failure.message, path: responsePathAsArray(info.path),
              extensions: { ...failure.extensions, inputPath: failure.extensions.inputPath ?? `${deleting ? 'ids' : 'products'}[${index}]` } });
          } else changed.push({ product, reason: input.reason });
        }
        // Finish all downstream checks before writes. An orders outage cannot
        // hide an earlier write behind a null mutation response.
        for (const { product, reason } of changed) {
          if (deleting) products.delete(product.id);
          else { product.archived = true; product.archiveReason = reason; }
        }
        return deleting ? { deleted: changed.length } : { archived: changed.length, skipped: inputs.length - changed.length, products: changed.map(c => c.product) };
      }
      return {
        Query: {
          searchOfferings: (_, { input }) => ({ nodes: search(input) }),
          searchProducts: (_, { input }) => ({ nodes: search(input, true) }),
        },
        Product: { __resolveReference: ({ id }) => products.get(id) },
        Offering: { __resolveType: obj => obj.__typename },
        Mutation: {
          archiveProducts: (_, { products }, context, info) => change(products, context, info),
          deleteProducts: (_, { ids }, context, info) => change(ids.map(id => ({ id })), context, info, true),
        },
      };
    },
  };
}

export function ordersForProduct(id) {
  return id === 'PRODUCT_004' ? [{ id: 'ORDER_001', status: 'OPEN', variantIds: ['PRODUCT_004_V1'] }] : [];
}
