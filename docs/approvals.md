# Reviewer approvals

1. Dry-run the intended operation.
2. `requestApproval(document:, variables:, operationName:)` validates it and creates
   a pending preview, without granting approval or executing product writes.
3. The reviewer inspects the exact document, variables, and field metadata in the UI.
4. The separate demo-admin decision endpoint approves or declines it.
5. Poll `approval(id:)` as the original caller. An approved request returns a token.
6. Submit the original document and variables with `x-approval: <token>`.

Tokens are random, one-use, and expire after five minutes. They bind to the caller,
printed document (including aliases and selections), selected operation, and coerced
variables with sorted object keys. Changed inputs, another caller, replay, and
expiration fail closed. A consumed token cannot be reused even if execution fails;
read the outcome and obtain a fresh approval for another attempt.

This localhost demo deliberately uses selectable `x-demo-user` identities and an
in-memory approval store. The admin panel simulates a separate authenticated human
session; the header is not authentication. Production requires verified identities,
durable atomic token consumption, resource authorization, and an actual reviewer UI.
