(function initInlineRequest(globalScope) {
  const codec = globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-block.js') : null);
  const INLINE_MAX_RECORDS = 500;
  const INLINE_BLOCK_MAX_RECORD_COST = 12000;
  const INLINE_BLOCK_MAX_BATCH_COST = 12000;

  function getRecordCost(record) {
    return (
      String(record?.template || '').length +
      JSON.stringify(record?.atoms || []).length +
      JSON.stringify(record?.repair ?? null).length
    );
  }

  function serializeModelRequest(records) {
    return JSON.stringify({ records: records.map((record) => ({
      id: record.id,
      template: record.template,
      atoms: record.atoms,
      repair: record.repair ?? null,
    })) });
  }

  function getReservedRecordCost(record) {
    const repairRecord = {
      ...record,
      repair: { attempt: 1, previousErrorCode: 'x'.repeat(80) },
    };
    // Counting each record as its own request intentionally over-reserves the
    // shared wrapper, guaranteeing the real batched JSON is no larger.
    const baseCost = serializeModelRequest([record]).length + serializeModelRequest([repairRecord]).length;
    const remainingRequestCapacity = Math.max(0, 12000 - baseCost);
    const previousTemplateCost = JSON.stringify({ previousTemplate: record?.template }).length;
    return baseCost + Math.min(2048, previousTemplateCost, remainingRequestCapacity);
  }

  function measureRecord(record) {
    return { actualCost: getRecordCost(record), reservedCost: getReservedRecordCost(record) };
  }

  const INLINE_BLOCK_REPAIRABLE_ERROR_CODES = new Set([
    'token_missing',
    'token_duplicate',
    'token_unknown',
    'token_nesting_invalid',
    'token_parent_changed',
    'output_too_long',
    'output_parse_failed',
  ]);
  const INLINE_BLOCK_ATOM_FIELDS = new Set([
    'token',
    'kind',
    'label',
    'preserveText',
  ]);

  function normalizeBlockAtom(atom, recordId, atomIndex) {
    if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
      throw new Error(`Invalid atom ${atomIndex} for block ${recordId}`);
    }
    for (const key of Object.keys(atom)) {
      if (!INLINE_BLOCK_ATOM_FIELDS.has(key)) {
        throw new Error(`Unexpected atom field '${key}' for block ${recordId}`);
      }
    }
    if (typeof atom.token !== 'string' || !atom.token) {
      throw new Error(`Invalid atom token for block ${recordId}`);
    }
    if (typeof atom.kind !== 'string' || !atom.kind) {
      throw new Error(`Invalid atom kind for block ${recordId}`);
    }
    if (typeof atom.preserveText !== 'boolean') {
      throw new Error(`Invalid atom preserveText for block ${recordId}`);
    }
    const normalized = {
      token: atom.token,
      kind: atom.kind,
      preserveText: atom.preserveText,
    };
    if ('label' in atom) {
      if (typeof atom.label !== 'string') {
        throw new Error(`Invalid atom label for block ${recordId}`);
      }
      normalized.label = atom.label;
    }
    return normalized;
  }

  function normalizeBlockRepair(repair, recordId) {
    if (repair == null) return null;
    if (!repair || typeof repair !== 'object' || Array.isArray(repair)) {
      throw new Error(`Invalid repair metadata for block ${recordId}`);
    }
    if (repair.attempt !== 1) {
      throw new Error(`Invalid repair attempt for block ${recordId}`);
    }
    if (!INLINE_BLOCK_REPAIRABLE_ERROR_CODES.has(repair.previousErrorCode)) {
      throw new Error(`Invalid repair error code for block ${recordId}`);
    }
    return {
      attempt: 1,
      previousErrorCode: repair.previousErrorCode,
    };
  }

  function normalizeSourceBatch(records) {
    if (!Array.isArray(records)) {
      throw new Error('Inline block translation records must be an array');
    }
    if (records.length > INLINE_MAX_RECORDS) {
      throw new Error(
        `Too many semantic blocks for inline translation (${records.length}/${INLINE_MAX_RECORDS})`
      );
    }
    const seen = new Set();
    const normalized = records.map((record, index) => {
      const id = record?.id;
      if (typeof id !== 'string' || !id) {
        throw new Error(`Invalid inline block record id at index ${index}`);
      }
      if (seen.has(id)) throw new Error(`Duplicate inline block record id: ${id}`);
      seen.add(id);
      if (typeof record.template !== 'string' || !record.template.trim()) {
        throw new Error(`Invalid inline block template for id: ${id}`);
      }
      if (!record.contract || typeof record.contract !== 'object') {
        throw new Error(`Missing inline block token contract for id: ${id}`);
      }
      const atoms = Array.isArray(record.atoms)
        ? record.atoms.map((atom, atomIndex) =>
            normalizeBlockAtom(atom, id, atomIndex)
          )
        : (() => {
            throw new Error(`Invalid inline block atoms for id: ${id}`);
          })();
      const normalizedRecord = {
        id,
        template: record.template,
        atoms,
        contract: record.contract,
        repair: normalizeBlockRepair(record.repair, id),
      };
      const validation = codec?.validateTranslatedTemplate(
        normalizedRecord.template,
        normalizedRecord.contract
      );
      // A source template carries every token it lists; ADR-0010's allowance is for answers.
      if (!validation?.ok || validation.droppedWrappers.length) {
        throw new Error(
          `Invalid source token contract for block ${id}: ${validation?.errorCode || 'output_parse_failed'}`
        );
      }
      const cost = getRecordCost(normalizedRecord);
      if (cost > INLINE_BLOCK_MAX_RECORD_COST) {
        throw new Error(
          `Inline block record is too large (${cost}/${INLINE_BLOCK_MAX_RECORD_COST} characters)`
        );
      }
      return normalizedRecord;
    });
    const totalCost = normalized.reduce(
      (sum, record) => sum + getRecordCost(record),
      0
    );
    if (totalCost > INLINE_BLOCK_MAX_BATCH_COST) {
      throw new Error(
        `Visible inline block batch is too large (${totalCost}/${INLINE_BLOCK_MAX_BATCH_COST} characters)`
      );
    }
    return normalized;
  }

  function prepareInitialBatch(records) {
    return {
      records,
      input: serializeModelRequest(records),
      actualCost: records.reduce((sum, record) => sum + getRecordCost(record), 0),
    };
  }

  function prepareRepairBatch(sourceRecords, repairDetails) {
    const sourceById = new Map(sourceRecords.map((record) => [record.id, record]));
    const repairRecordCosts = new Map();
    const records = repairDetails.map((details) => {
      const source = sourceById.get(details.id);
      const record = { ...source, repair: { attempt: 1, previousErrorCode: details.previousErrorCode } };
      if (Object.prototype.hasOwnProperty.call(details, 'previousTemplate')) {
        const contextual = { ...record, repair: { ...record.repair,
          previousTemplate: details.previousTemplate, untranslatedPhrases: details.untranslatedPhrases } };
        if (serializeModelRequest([source]).length + serializeModelRequest([contextual]).length <=
            getReservedRecordCost(source)) {
          record.repair = contextual.repair;
          repairRecordCosts.set(source.id, getRecordCost(record));
        }
      }
      return record;
    });
    let requestCost = serializeModelRequest(records).length;
    for (const record of records) {
      if (requestCost <= INLINE_BLOCK_MAX_BATCH_COST) break;
      if (!repairRecordCosts.has(record.id)) continue;
      const contextualCost = repairRecordCosts.get(record.id);
      record.repair = { attempt: 1, previousErrorCode: record.repair.previousErrorCode };
      requestCost -= contextualCost - getRecordCost(record);
      repairRecordCosts.delete(record.id);
    }
    return { ...prepareInitialBatch(records), repairRecordCosts };
  }

  const api = { measureRecord, normalizeSourceBatch, prepareInitialBatch, prepareRepairBatch };
  globalScope.ChromeAiTranslatorInlineRequest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
