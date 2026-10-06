---
name: products
description: Navigate the fictional products and perform reviewer-approved cleanup.
---

# Products

Find things using the registered `ProductsByName` operation. Set `term` and
`collection` (`DEMO`). Inspect IDs, variants, prices, archived state, and open orders.
A variant is a size or color with its own price. A service is work such as installation.
Never merge a product into a service, or a variant into a product.

For cleanup, archive; never delete. Use `ArchiveProducts` in batches of at
most 25. Always dry-run with `Apollo-Expose-Query-Plan: dry-run` before requesting
approval. Check `extensions.operationMeta` for permissions and approval rules.
The dry run does not check current order state or guarantee business success.

Call `requestApproval` with the exact document, operation name, and variables.
Wait for a human reviewer to approve the preview. Read `approval(id:)` for the token,
then send the same operation as the same caller with `x-approval` set to that token.
Do not call the reviewer decision endpoint on the reviewer's behalf.

Read both `data` and `errors`. `archived` and `skipped` describe actual outcomes.
`errors[].path` locates the response field; `extensions.inputPath` locates the
submitted input. `entityPath` identifies related variant data where applicable.
Do not retry successful products or automatically retry `retryable: false` errors.
Verify the products afterward. Every changed batch requires a new approval.
