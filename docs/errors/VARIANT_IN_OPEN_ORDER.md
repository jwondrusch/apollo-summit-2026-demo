# VARIANT_IN_OPEN_ORDER

The product is referenced by an open order and was not changed. Other valid products in
the batch may have succeeded. Inspect `inputPath`, `productId`, `entityPath`, and
`orderIds`. Do not retry unchanged or resubmit successful products. Resolve the open
order through the appropriate workflow or leave this product active. Any later write
requires a new preview and reviewer approval. `retryable: false`.
