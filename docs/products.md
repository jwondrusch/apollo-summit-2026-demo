# Product cleanup

This is fictional product data for Apollo Summit 2026.
Search with `ProductsByName`, inspect variants and open orders, then archive
duplicates with `ArchiveProducts`. Keep the canonical `PRODUCT_001` Desk Lamp.
`PRODUCT_002` and `PRODUCT_003` are duplicates. `PRODUCT_004` has a variant in `ORDER_001`.

Price is an integer in cents on a variant. A service is work such as installation.
Search is case-insensitive and collection-aware. Archived products stay visible for verification.

Archive batches must contain 1–25 inputs. Each input contains `id` and `reason`.
Every write needs a preview and a separate reviewer decision. Both archive and delete
check orders before changing the products. A normal expected product failure produces
partial data plus an error; successful products are not rolled back.

The federation plan's post-mutation orders fetch is a response join. It is **not**
the check that prevents an unsafe archive. The products service calls orders before
writing, even when the client does not select `openOrders`.

The demo checks all downstream responses before applying writes. A real production
service also needs concurrency control across the order check and the archive.

`extensions.operationMeta`, `inputPath`, `entityPath`, and the demo permission
directive are custom conventions. They are not built-in GraphQL behavior.
