# Documentation

This index separates current guidance, accepted decisions, and historical evidence. The implementation is the authority for current behavior; an ADR records why a decision was made, and an old plan or QA result records what was proposed or observed at its stated baseline.

## Current guidance

| Document | Purpose | Stance |
| --- | --- | --- |
| [User guide](../README.md) | Installation, settings, controls, results, and data handling | Reader-directed |
| [Architecture](architecture.md) | Translation flows, module responsibilities, lifetimes, limits, and diagnostics | Descriptive |
| [Glossary](../GLOSSARY.md) | Canonical domain terms and synonyms to avoid | Descriptive |
| [Test guide](../tests/README.md) | Choosing and running unit, browser, and billed checks | Reader-directed |
| [Repository instructions](../AGENTS.md) | Coding-agent rules and loader conventions | Agent instructions |

The [package scripts](../package.json), [manifest](../extension/manifest.json), and linked implementation modules own executable configuration and constants. The architecture reference restates only values needed to understand behavior and links their owners. Test counts and live-page observations in historical records are evidence for those runs, not current guarantees.

## Accepted decisions

All ADRs below retain their existing numbers and accepted status. They are descriptive records: the decision and trade-off remain authoritative until explicitly reconsidered, while implementation pointers can be corrected after a refactor. Measurements and account conditions belong to the time of the recorded investigation.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-open-side-panel-from-action-click-handler.md) | Open the side panel from the extension's action-click handler |
| [0002](adr/0002-translate-semantic-blocks-not-text-nodes.md) | Translate whole Semantic Blocks |
| [0003](adr/0003-leave-the-semantic-block-session-cap-to-the-content-script.md) | Keep the Session Budget in the content-script runtime |
| [0004](adr/0004-give-the-keyboard-shortcut-to-inline-translation.md) | Assign the shortcut to Inline Translation |
| [0005](adr/0005-one-recovery-per-translation-chunk.md) | Share one recovery budget across a Translation Chunk's failure kinds |
| [0006](adr/0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md) | Publish only a complete Side Panel Translation |
| [0007](adr/0007-charge-the-session-budget-in-actual-record-cost.md) | Charge the Session Budget in actual record cost |
| [0008](adr/0008-name-the-placeholder-token.md) | Use Placeholder Token as the shared term |
| [0009](adr/0009-model-local-rejections-in-diagnostics-v3.md) | Model local rejections explicitly in diagnostics v3 |
| [0010](adr/0010-apply-an-answer-that-dropped-a-whole-emphasis-pair.md) | Allow eligible whole emphasis pairs to be absent from an answer |
| [0011](adr/0011-exclude-block-children-from-own-prose.md) | Exclude edge Block Children from a parent's own prose |

## Agent procedures

These documents use the imperative register for agent instructions. Each is loaded when its task applies rather than copied into general product documentation.

- [Domain docs](agents/domain.md): before exploring code or proposing domain or architecture changes.
- [Documentation review](agents/documentation-review.md): when reviewing repository documentation changes or claims.
- [Issue tracker](agents/issue-tracker.md): before implementing a ticket or operating on GitHub issues.
- [Triage labels](agents/triage-labels.md): before assigning triage labels.

## Historical design and verification

These descriptive records retain their original paths so existing references continue to resolve. Their proposed helpers, UI, schemas, verification commands, and measurements describe the recorded work; the current architecture and test guide provide today's interface and procedure.

| Record | Baseline or context |
| --- | --- |
| [Evaluation execution deepening design](design/evaluation-execution-deepening-2026-10-26.md) | Routing and model-quality execution responsibilities, preserved contracts and unbilled verification scope confirmed; implementation authorized on 2026-10-26 |
| [Codebase simplification design](design/codebase-simplification-2026-10-26.md) | Five local simplifications, deferred documentation-anchor caching, scope and verification confirmed; implementation authorized on 2026-10-26 |
| [UI polish accessibility design](design/ui-accessibility-polish-findings.md) | Language boundaries and keyboard access decisions; implementation authorized on 2026-10-26 |
| [OpenRouter routing pilot results](qa/openrouter-routing-pilot-2026-10-25.md) | 36 live page translations, budget control, routing-blind quality review and interpretation limits, dated 2026-10-25 |
| [Model quality preparation](qa/model-quality-preparation-2026-10-25.md) | 144 intercepted mock page executions, source coverage checks and request-sized cost scenarios, dated 2026-10-25 |
| [Model quality pilot results](qa/model-quality-pilot-2026-10-26.md) | Six profiles, 144 attempted comparisons, reconciled costs, blinded review and shared application defects, dated 2026-10-26 |
| [OpenRouter translation routing evaluation](design/openrouter-translation-routing.md) | 36-run pilot and unbilled preparation confirmed on 2026-10-25; production routing and billed execution remain open |
| [Inline restore cache design](design/inline-restore-cache-design.md) | Original page-lifetime cache design; related QA dated 2026-06-15 |
| [Inline changed text retry design](design/inline-changed-text-retry-design.md) | Design dated 2026-06-25 |
| [GitHub test-audit Inline Translation design](design/github-test-audit-inline-translation-design.md) | Confirmed 2026-10-25 scope, table-cell rejection reproduction, abbreviation false-positive replay, and diagnostic evidence limits |
| [Agent environment retrospective design](design/agent-environment-retro-2026-10-20.md) | Four environment improvements and verification scope confirmed in the 2026-10-20 interview; implementation requires a separate request |
| [Validation and diagnostics design](superpowers/specs/2026-07-11-inline-translation-validation-diagnostics-design.md) | Schema-2 design dated 2026-07-11; schema 3 followed in ADR-0009 |
| [Validation and diagnostics plan](superpowers/plans/2026-07-11-inline-translation-validation-diagnostics.md) | Implementation plan for that schema-2 design |
| [Local extension QA](qa/qa-report-local-extension-2026-06-15.md) | Static UI rendering and follow-up QA dated 2026-06-15 |
| [Issue #70 Session verification](qa/issue-70-session-checks.md) | Interface checks based on commit `2730fb4`, with mutation evidence |
| [Content-script initialization investigation](qa/content-script-readiness-2026-10-20.md) | Reconstructed loader mismatch and readiness verification boundaries, dated 2026-10-20 |

## Maintenance boundaries

User actions belong in the root README, runnable verification procedures in the test guide, current implementation relationships in the architecture reference, terms in the glossary, and decision rationale in ADRs. Historical evidence retains its baseline and distinguishes measurements from estimates. This division avoids making a new behavior change require the same explanation in several files.
