# Preserve completed Text Translation on interruption

Status: accepted for the Text Translation design; implementation pending

Text Translation retains and displays each completed portion in source order. Stopping or failing marks the result incomplete rather than discarding completed translations. An explicit resume translates the remaining portions only while the source and translation settings still match the interrupted work. No automatic retry occurs, and late responses cannot replace stopped or newer work.

This preserves useful answers already obtained from the provider and avoids requesting completed portions again during resume. It requires an explicit incomplete state and retained progress tied to the original input and settings. Input or settings changes leave the previous result visibly associated with its earlier input and remove resume eligibility; a new translation clears that result. Tab-scoped retention follows the [design interview](../design/text-translation-page-2026-11-10.md), including interruption on reload and no automatic restart.

The alternative was the complete-result-only policy in [ADR-0006](0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md). That decision applies to the existing article-based Side Panel Translation, which the design removes. The new policy applies to reader-supplied Text Translation and does not change Inline Translation's Partial Translation quality classification. Existing article recovery rules in ADR-0005 are not inherited by the new plain-text flow.
