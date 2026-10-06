# Exclude Block Children from a Semantic Block's own prose

Status: accepted

A list item often introduces a nested list or code block with its own prose. Inline Translation treats that prose as one Semantic Block and retains a leading or trailing Block Child by identity and position, excluding its text and structure from the parent's model request. Sending a Placeholder Token for the Block Child was rejected because the model could relocate a sub-list or code block into the middle of a translated sentence; a block boundary is not inline structure that translation may reorder.

## Ownership and restoration

The parent's fingerprint and ownership cover the Block Child node and its position among the parent's children, but exclude its subtree. The parent's text and container snapshots stop at the same boundary, so a nested Semantic Block can translate first without invalidating the parent, and restoring the parent leaves the child in its current state. Parent and child records own separate prose and can apply or restore in either order, preserving the single-record ownership required by ADR-0002. Heading edge controls retain their existing subtree checks, and an anchored leading disclosure summary retains its existing wrapper contract.

## Unsupported positions

Only leading and trailing Block Children are supported, including adjacent children at either edge with ignorable whitespace between them. An interior nested Semantic Block still uses `nested_semantic_block`; an interior non-semantic Block Child uses `unsupported_descendant`. For direct Block Children these reasons now describe an interior placement rather than rejecting every nested block; a nested Semantic Block below an inline wrapper or protected atom still fails because its ownership cannot overlap that wrapper or atom. Generic `DIV` containers remain unsupported. No diagnostic reason, schema, or privacy field changes (ADR-0009).
