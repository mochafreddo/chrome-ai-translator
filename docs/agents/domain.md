# Domain Docs

## Before exploring

Read the root [GLOSSARY.md](../../GLOSSARY.md) before exploring code or proposing domain or architecture changes. Use the [architecture reference](../architecture.md) to locate current responsibilities, then read the relevant [ADRs](../README.md#accepted-decisions) for their rationale. If a document is absent, proceed without inventing its contents.

## Vocabulary and decisions

Use canonical glossary terms in issues, proposals, hypotheses, and tests, following each entry's synonyms to avoid. For a missing concept, first decide whether it belongs to this domain; resolve it through `domain-modeling` when needed.

Flag a proposal that conflicts with an accepted ADR by identifying the decision and explaining why it should be reconsidered. Treat historical plans and QA records as evidence at their recorded baseline, not current instructions.

## Structure and maintenance

This repository has one context: root `GLOSSARY.md` for vocabulary and `docs/adr/` for decisions. Keep definitions free of implementation details. Record current behavior and module relationships in the architecture reference, and create glossary entries or ADRs through `domain-modeling` as terms or qualifying decisions are resolved. The [documentation index](../README.md) identifies each document's role.
