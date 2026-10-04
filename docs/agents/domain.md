# Domain Docs

## Before exploring

Read `GLOSSARY.md` at the repo root and the ADRs in `docs/adr/` relevant to the area being explored.

If a document does not exist, proceed silently. Create domain documents through `/domain-modeling` when terms or decisions are resolved.

## File structure

This repo uses a single-context layout:

- `GLOSSARY.md`: domain vocabulary.
- `docs/adr/`: architecture decision records.

## Use the glossary's vocabulary

Use the terms defined in `GLOSSARY.md` when naming domain concepts in issues, proposals, hypotheses, and tests. Follow its guidance on synonyms to avoid.

If a needed concept is missing, reconsider whether it belongs to the domain or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain why the decision should be reconsidered.
