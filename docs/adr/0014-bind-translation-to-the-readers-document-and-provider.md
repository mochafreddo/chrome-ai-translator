# Bind translation to the reader's document and provider choice

Status: accepted, implementation pending

A translation gesture applies to the top-level document where the reader invoked it. A tab can load another document before extraction starts, even when its URL stays the same. Document replacement or tab closure ends that document's work: stop admitting chunks and repairs, abort outstanding transport where possible, discard late results, and clear the previous document's panel state. Requests already received by a provider may still incur charges. Scrolling and fragment navigation within the document preserve the operation.

Within one document, Inline Translation continues to scan new paragraphs in the selected article. If the selected root becomes detached, automatic submission pauses until the reader chooses **Scan visible text** to select the current article. This costs an extra gesture when a site redraws the same article, but prevents automatic submission of a replacement article. The Session Budget continues across this same-document rescan.

Before Side Panel Translation sends the article, the service and effective model must match what the panel showed when the reader clicked **Translate**. A mismatch refreshes those fields and requires another click. Once a translation starts, all its chunks and repairs use that starting service and model. This keeps one document's requests with the provider the reader chose even if Options changes during execution.
