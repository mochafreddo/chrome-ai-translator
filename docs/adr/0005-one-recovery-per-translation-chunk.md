# One recovery per Translation Chunk, and the first failure owns it

Status: accepted

Side Panel Translation now has two ways to recover a Translation Chunk, and they want the same chunk. The older one answers an over-long response: `splitChunkForRecovery` halves the chunk's character limit, re-cuts it at block boundaries, and translates each child, guarded by `recoveryDepth` so it happens once. The newer one (issue #26) answers a broken token contract: an answer that lost, repeated, invented, or crossed the placeholder tokens the chunk was sent buys one further attempt, told which of the four codes refused it.

A chunk can fail both ways, and giving each recovery its own budget multiplies the bill: an over-long chunk splits into N children, each child then repairs, and one chunk the reader asked to translate once costs up to `1 + 2N` requests — a number that grows with the chunk's block count for a reader who never chose it. The decision is therefore that **a Translation Chunk carries one recovery budget, and whichever failure arrives first spends it.** `recoveryDepth` is that budget rather than a split depth: the split stamps it on the children it makes, the repair stamps it on the retry it sends, and in both cases the next failure of either kind ends the chunk instead of starting the other recovery.

Two consequences follow directly, and both are checked in `tests/background-helpers.test.js`. A child of a split that comes back without a token is not repaired. A repair attempt that comes back over-long is not split.

The alternative worth naming is ordering the two by kind — always split first, and let each child repair — on the reasoning that the split makes the request smaller and a smaller request is likelier to keep its tokens. It was rejected for cost and for evidence. Cost, because it is exactly the `1 + 2N` shape above. Evidence, because #23 ran the billed check against a fixture cut into three chunks at the smallest chunk size the options page accepts and did not reproduce the failure at all: there is nothing on record saying a token loss is more likely in a large chunk than a small one, so paying per block for that hypothesis would be paying for a guess.

## Consequences

- The worst case for one chunk is unchanged from before #26: `1 + N` requests, where N is the number of children a split produces. A token repair costs 2, and the two never compose.
- `recoveryDepth` is load-bearing in a way its name understates. It is not "how deep the splitting went" — it is "this chunk has already had its second chance". `splitChunkForRecovery` refuses on it with `response.recovery_exhausted`, which `translateFullPageChunk` never reaches because its own guard throws first — as was already true before #26. That refusal is the Markdown module's own invariant for any other caller, not a live path here.
- A repair is one attempt, not a loop, because every attempt is billed and the reader did not ask for it. If a second repair is ever wanted, the thing to change is this decision, not the guard.
- The four codes are enumerated in `FULL_PAGE_TOKEN_ERROR_CODES` rather than matched on their shared `markdown.token_` prefix. `markdown.token_parent_changed` exists in the extension's vocabulary and Side Panel Translation's validator never raises it; a prefix match would quietly grant a second request to any code a future validator invents.

## Do not revert this

Restoring a per-child repair budget looks like strictly more recovery for one line of code. What it actually buys is a bill that scales with the size of the article on the reader's worst path — the path where the model is already failing — and it buys it for a failure that has never been reproduced against a real model (#23: not reproduced, three attempts). If evidence arrives that a token loss survives one correction and is cured by a smaller chunk, that evidence belongs in a ticket beside a changed worst case, not in a guard loosened on the reasoning that retries are cheap.
