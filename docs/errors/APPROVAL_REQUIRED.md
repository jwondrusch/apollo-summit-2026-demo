# APPROVAL_REQUIRED

Call `requestApproval` with the exact document, selected operation, and variables.
Wait for the reviewer's separate decision, then read `approval(id:)` and put the
returned token on `x-approval`. Tokens are caller-bound, single-use, and expire
after five minutes. A changed or failed attempt needs a new preview and approval.
