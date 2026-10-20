# Content-script initialization investigation

This record describes the 2026-10-20 investigation of `Cannot read properties of null (reading 'createInlineTranslationOperation')` at `content.js:99`. The source baseline was `dca651f1bc0f0f0159f5eac15537ce5c93a37f0c`. Current behavior belongs in the [architecture reference](../architecture.md#controls-and-authorization), recovery instructions in the [user guide](../../README.md#update-the-unpacked-extension), and runnable checks in the [test guide](../../tests/README.md).

## Observed reproduction

A local Node VM reconstruction executed the actual `getInlineContentScriptFiles()` list from the parent of commit `ebc6977` against the baseline's extension files. That list omitted the Operation and local diagnostic transport modules added by `ebc6977`. It produced the reported TypeError at `createInlineContentState`, `content.js:99:48`. The baseline's current ordered list initialized the same page fixture successfully. The comparison used local DOM and Chrome adapters, with no browser or model requests.

This establishes a sufficient condition: an old file list paired with newer content-script bytes can produce the exact error. It does not establish which worker, registered list, or file bytes the original Chrome tab executed. A stale running worker and a stale automatic registration remained possible explanations, rather than measured causes. Current install/startup paths already attempt to synchronize automatic registration.

After Chrome was restarted to connect the debugger, loading the reported GitHub repository, directory pages, and skill file did not reproduce the original exception. Toolbar invocations on the skill directory and file opened the panel without it. These observations did not verify the original runtime state or the automatic-injection path.

## Verification boundaries

The `static-assets` characterization check exercises an incomplete classic-script list without the Operation module, observes no page-state response, then completes injection and observes one listener and a valid response. Its separate reinjection check exercises admitted work, cached translations, and the original page-visit budget.

The `background-helpers` checks observe public worker actions and messages with fake Chrome APIs. They cover missing or malformed readiness, stopping page instructions, clearing a failure after successful preparation, and refusing Side Panel extraction/model execution after unsuccessful initialization. The `sidepanel-tab-state` check observes the actual panel renderer so initialization guidance cannot be replaced by missing-access guidance.

The unbilled `content-readiness` browser check exercises first toolbar injection, repeated toolbar invocation, and automatic injection after the all-pages choice in an isolated profile. Its network observation checks for OpenAI requests; it does not evaluate translation quality. These checks do not reproduce the original Chrome update timing, prove an already-running worker has adopted changed source, or make a mixed runtime update itself. Extension and host-page reload remain necessary when updating an unpacked installation.
