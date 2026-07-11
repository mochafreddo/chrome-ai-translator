(function initInlineDiagnosticsController(globalScope) {
  function normalizeLocalDiagnostics(entries, protocol) {
    const allowedCodes = new Set(protocol.localCodes);
    const diagnostics = [];
    let payloadCost = 0;
    const boundedString = (value, max = 200) => String(value || '').slice(0, max);
    const copyString = (target, source, key, max) => {
      if (Object.hasOwn(source, key)) target[key] = boundedString(source[key], max);
    };

    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, protocol.limits.maxRecords)) {
      if (!allowedCodes.has(entry?.code)) continue;
      const template = typeof entry.template === 'string' ? entry.template : '';
      let contract = null;
      let contractJson = '';
      if (entry.contract && typeof entry.contract === 'object' && !Array.isArray(entry.contract)) {
        try {
          contract = {};
          if (Object.hasOwn(entry.contract, 'codecVersion')) contract.codecVersion = Number(entry.contract.codecVersion) || 0;
          copyString(contract, entry.contract, 'namespace', 100);
          if (Object.hasOwn(entry.contract, 'entries')) {
            contract.entries = (Array.isArray(entry.contract.entries) ? entry.contract.entries : [])
              .slice(0, protocol.limits.maxRecords)
              .map((item) => {
                const copied = {};
                for (const [key, max] of [
                  ['id', 200], ['kind', 40], ['tagName', 40], ['parentId', 200],
                  ['openToken', 200], ['closeToken', 200], ['token', 200], ['atomKind', 80],
                ]) copyString(copied, item || {}, key, max);
                if (Object.hasOwn(item || {}, 'preserveText')) copied.preserveText = item.preserveText === true;
                return copied;
              });
          }
          if (Object.hasOwn(entry.contract, 'maxOutputChars')) contract.maxOutputChars = Math.max(0, Number(entry.contract.maxOutputChars) || 0);
          if (Object.hasOwn(entry.contract, 'requiresText')) contract.requiresText = entry.contract.requiresText === true;
          if (Object.hasOwn(entry.contract, 'literalTokens')) {
            contract.literalTokens = (Array.isArray(entry.contract.literalTokens) ? entry.contract.literalTokens : [])
              .slice(0, protocol.limits.maxRecords)
              .map((item) => ({ value: boundedString(item?.value), count: Math.max(0, Number(item?.count) || 0) }));
          }
          contractJson = JSON.stringify(contract);
          if (contractJson.length > protocol.limits.maxRecordCost) {
            contract = null;
            contractJson = '';
          }
        } catch {
          contract = null;
          contractJson = '';
        }
      }
      if (template.length > protocol.limits.maxRecordCost) continue;
      const entryCost = template.length + contractJson.length;
      if (entryCost > protocol.limits.maxRecordCost || payloadCost + entryCost > protocol.limits.maxSessionCost) continue;
      payloadCost += entryCost;
      const evidence = {};
      for (const key of ['recordCost', 'sessionCost', 'limit']) {
        if (Number.isFinite(entry.evidence?.[key])) evidence[key] = Math.max(0, Number(entry.evidence[key]));
      }
      diagnostics.push({ code: entry.code, ...(template && contract ? { template, contract } : {}), evidence });
    }
    return diagnostics;
  }

  const controller = { normalizeLocalDiagnostics };
  globalScope.ChromeAiTranslatorInlineDiagnosticsController = controller;
  if (typeof module !== 'undefined' && module.exports) module.exports = controller;
})(typeof globalThis !== 'undefined' ? globalThis : this);
