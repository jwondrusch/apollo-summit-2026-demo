import { startDemo } from './server.js';
const demo = await startDemo({ port: Number(process.env.PORT ?? 4000) });
console.log(`Apollo Summit demo: ${demo.url}\nGraphQL: ${demo.url}/graphql\nSubgraphs: ${JSON.stringify(demo.urls)}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await demo.stop(); process.exit(0); });
