export const inlinePanelControlsReady = (panel) => panel.evaluate(
  "document.readyState === 'complete' && !document.getElementById('btnInlineTranslate').disabled");
