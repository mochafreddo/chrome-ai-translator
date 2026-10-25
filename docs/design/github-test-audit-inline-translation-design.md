# GitHub test-audit Inline Translation failures

This design records the 2026-10-25 interview about Inline Translation on the public [gstack test-audit skill page](https://github.com/garrytan/gstack/blob/main/test-audit/SKILL.md). The user confirmed the combined implementation scope, abbreviation classification, public test seams, and review base on 2026-10-25. Subsequent authorization for billed verification and English-residue correction is recorded below. Commits and publication remain outside the scope.

## Evidence and limits

The inspected source revision is `fb84d6e4b172c1b8243b6949602aac9617dfa0ad`. A disposable Chrome with that unpacked extension reproduced ten local rejections from the visible metadata table. Each rejected Semantic Block is a `TD` containing a single direct `DIV`, such as `<td><div dir="auto">audit the test suite</div></td>`. Three cells contain natural-language triggers and seven contain tool names. All ten return `unsupported_descendant / DIV`. The viewport probe queued records without draining batches or invoking a model. Its document scroll did not traverse the entire GitHub inner scroll area, so its counts describe that observed viewport, not the complete article.

The user-supplied schema-3 diagnostic export records the reported operation at 2026-10-25 17:27 KST with extension version `0.3.0.0` and model `deepseek/deepseek-v4.1-flash-1017`. It contains ten local `runtime.unsupported_block` rejections with `unsupported_descendant / DIV` and zero model attempts. A separate batch records one rejected block with `structure.source_syntax_changed` at both initial and repair validation, with two attempts for that block. These observations establish the failure category, not the changed literal: diagnostics deliberately omit source text and model answers.

Independent serialization of the captured page identifies ordinary `e.g.` abbreviations as Source Syntax with value `e.g`. A replay through the public `validateTranslatedTemplate` interface accepts the unchanged captured template and rejects the same template with only `e.g.` replaced by `예:`. This is a deterministic synthetic replacement, not a captured provider answer. It proves an abbreviation false-positive path but does not link that path to the diagnostic block's HMAC fingerprint.

Source inspection also shows that `serializeModelRequest` sends the original template, atoms, and optional repair metadata, but no separate Source Syntax values or counts. Repair supplies the previous error code. This is an existing protocol limitation, not evidence that it caused the reported rejection.

## Confirmed table-cell support

A single direct `DIV` enclosing a table cell's whole prose will be supported within that cell's Semantic Block. The cell remains the translation unit; its inner container does not become an independently discovered Semantic Block. The existing page-owned cell and container retain identity, attributes, and restoration behavior. The rule applies to equivalent table-cell structures without checking a GitHub hostname or CSS class.

Only ignorable surrounding whitespace may accompany the sole container. Hidden, editable, interactive, or unsupported descendants remain subject to the existing exclusions. Nested Semantic Blocks keep their existing ownership boundaries. Generic DIV paragraph inference, multiple DIV containers, interior Block Children, and arbitrary mixed block layouts are outside this change.

Links, code, Placeholder Tokens, and genuine Source Syntax retain their existing validation. Failed Semantic Blocks keep their originals and do not block their siblings. Tool labels are not converted into prose merely to increase translated counts.

## Confirmed abbreviation boundary

Ordinary linguistic abbreviations such as `e.g.` and `i.e.` are translatable prose rather than Source Syntax. The classifier will distinguish those abbreviations from unambiguous filenames and paths while retaining exact preservation for genuine Source Syntax. Existing code and link protection remain intact; the change will not disable `source_syntax_changed` validation globally.

The smallest classifier correction will be preferred over adding a Source Syntax model-input protocol or additional repair attempts. A broader model-input change needs separate evidence that correctly classified Source Syntax cannot be preserved under the current flow. Billed model execution is outside the current authorization.

The existing Source Syntax glossary entry gains this linguistic distinction. No new domain term or ADR is needed: cell ownership remains under ADR-0002 and ADR-0011, and the local classification choices are reversible.

## Implementation and verification

The repository is `chrome-ai-translator`, with review base `fb84d6e4b172c1b8243b6949602aac9617dfa0ad`. The confirmed scope is the shared Inline codec, affected tests, the reported-page browser check, the Source Syntax glossary clarification, and necessary documentation. Other repositories and translation flows are outside the scope.

The public test seams are `serializeBlock`, `validateTranslatedTemplate`, `applyTranslatedTemplate`, `restoreBlock`, and viewport admission through a real Inline Translation Session. Existing codec fixtures will cover supported table cells, rejected unsafe variants, preserved node identity, exact restore, and ordinary-abbreviation translation alongside genuine filename/path protection. Regression checks will first demonstrate the current rejection before verifying the fix.

The reported-page browser check will retain its existing GitHub skill coverage and add the reported gstack page. It will verify supported metadata-cell admission without model requests. A local fixture will verify deterministic application and restoration independently of public page changes. The browser collection must traverse the page's actual scrolling surface; static candidate enumeration is not a substitute for viewport admission counts.

Planned final checks are `npm test`, `npm run check:syntax`, `npm run check:docs`, and the affected unbilled browser check. Passing local tests will establish the deterministic DOM and validation contracts, not live DeepSeek translation quality or the original provider answer's contents. A valid changed filename/path must still be rejected. Any additional live verification requires explicit authorization for credentials and billed execution.

## English-residue follow-up

The user subsequently authorized billed headless verification and requested a fix for two remaining Partial Translation warnings. Live OpenRouter evidence at the same model showed that both blocks passed structure checks but retained descriptive section references. One also retained ordinary emphasized prose and prose beside a code atom. General instruction changes and translation examples improved some wording but did not reliably complete both blocks; a later repair also returned an empty template, which the unchanged structure validator rejected.

The follow-up keeps the quality detector, Source Syntax boundary and single-repair limit. It does not exempt arbitrary quotes, titles or uppercase labels. The original source remains authoritative. English-residue repairs can include the complete prior answer and up to four shared English sequences as transient model input only when the combined initial and repair JSON fits its reservation and the assembled repair request stays within its cap. No prior answer is truncated. A source-sized context allowance is capped at 2,048 serialized characters and the remaining space under the existing record cap, preserving individual-record admission while potentially reducing batch size. Contextual repairs report their actual record cost to Session, including late responses; cached answers do not charge it again. These changes supersede the initial decision to defer a model-input change because live evidence established that fixed instructions alone were insufficient.

Verification covers the public model-execution request/response seam, serialized JSON reservation including escaping, Session charging and cache/lifecycle behavior, and real headless translation of the captured blocks and reported page. A zero warning count is insufficient by itself: checks also inspect ordinary words such as `recommended` and `echoed`, preserve code and identifiers, and restore the original node graph. Isolated technical names remain allowed under the existing Partial Translation definition.
