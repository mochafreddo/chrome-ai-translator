# Documentation Review

Use this procedure when reviewing documentation changes or claims.

## Inventory and scope

- Discover tracked Markdown files with Git; derive counts from that inventory instead of recording manual totals.
- Partition independent investigations by bounded paths and questions. Return concise evidence and unknowns for each.
- Inspect disputed or changed passages and their direct sources. Do not reread an entire delegated investigation unless a contradiction or uncertainty needs resolving. If output is truncated, narrow the read to the relevant passage.

## Check claims

- Ground behavioral claims in execution paths, callers, and enforcement; a constant definition alone does not establish behavior. For numeric claims, record the unit and whether the scope is per block, batch, Operation, or Session, plus the enforcing source.
- Check when settings take effect and which boundaries are transient or persisted. State guarantees per feature and distinguish observed behavior from broader claims.
- Preserve historical measurements with their original baseline and identify estimates as estimates.
- Check command descriptions against package scripts and the checks they invoke. Do not imply browser, network, or live-model coverage without evidence.

## Finish

- Run the checks required for the changed scope and report skipped checks with the reason.
- Review the final changed-file scope and report remaining uncertainty.
