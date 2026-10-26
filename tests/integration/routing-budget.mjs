export const PRICE_CAP = Object.freeze({ prompt: 0.33, completion: 1.32, request: 0 });

const NANODOLLARS_PER_DOLLAR = 1_000_000_000n;
const DEFAULT_MAX_INPUT_TOKENS = 1_048_576;
const MAX_INPUT_TOKENS = 1_050_000;
const DEFAULT_MAX_BUDGET_USD = 2;
const MAX_BUDGET_USD = 5;

function decimalNanoDollars(value, roundUp) {
  const match = String(value).match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new TypeError('USD amount is invalid.');
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0);
  const digits = BigInt(`${match[1]}${fraction}`);
  const decimalPlaces = fraction.length - exponent;
  const scale = 9 - decimalPlaces;
  if (scale >= 0) return digits * (10n ** BigInt(scale));
  const divisor = 10n ** BigInt(-scale);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  if (remainder !== 0n && !roundUp) throw new TypeError('USD limit must use whole nanodollars.');
  return quotient + (roundUp && remainder !== 0n ? 1n : 0n);
}

function asUsd(nanoDollars) {
  const negative = nanoDollars < 0n;
  const absolute = negative ? -nanoDollars : nanoDollars;
  const whole = absolute / NANODOLLARS_PER_DOLLAR;
  const fraction = String(absolute % NANODOLLARS_PER_DOLLAR).padStart(9, '0');
  return Number(`${negative ? '-' : ''}${whole}.${fraction}`);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function createBudget({ limitUsd = 2, inputTokenLimit, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS, openingSpentUsd = 0 } = {}) {
  if (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) ||
      maxBudgetUsd <= 0 || maxBudgetUsd > MAX_BUDGET_USD) {
    throw new TypeError('Budget cap must be greater than zero and no more than USD 5.');
  }
  if (typeof limitUsd !== 'number' || !Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > maxBudgetUsd) {
    throw new TypeError('Budget limit must be greater than zero and no more than its authorized cap.');
  }
  if (!positiveSafeInteger(maxInputTokens) || maxInputTokens > MAX_INPUT_TOKENS) {
    throw new TypeError('Input token cap must be a positive safe integer no greater than 1050000.');
  }
  if (!positiveSafeInteger(inputTokenLimit) || inputTokenLimit > maxInputTokens) {
    throw new TypeError('Input token limit must be a positive safe integer within its authorized cap.');
  }
  if (typeof openingSpentUsd !== 'number' || !Number.isFinite(openingSpentUsd) || openingSpentUsd < 0 || openingSpentUsd > limitUsd) {
    throw new TypeError('Opening spend must be finite, nonnegative, and no greater than the budget limit.');
  }
  const limitNano = decimalNanoDollars(limitUsd, false);
  if (limitNano <= 0n) throw new TypeError('Budget limit must use at least one nanodollar.');
  const openingSpentNano = decimalNanoDollars(openingSpentUsd, true);
  if (openingSpentNano > limitNano) throw new TypeError('Opening spend exceeds the budget limit.');

  let spentNano = openingSpentNano;
  let reservedNano = 0n;
  let frozen = false;
  const reservations = new Map();

  function reserve(id, maxOutputTokens) {
    if (frozen) throw new Error('Budget is frozen.');
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('Reservation id must be a nonempty string.');
    if (reservations.has(id)) throw new Error('Reservation id must be unique.');
    if (!positiveSafeInteger(maxOutputTokens) || maxOutputTokens > inputTokenLimit) {
      throw new TypeError('Output token limit must be a positive safe integer within the input token limit.');
    }
    const boundNano = BigInt(inputTokenLimit) * 330n + BigInt(maxOutputTokens) * 1320n;
    if (spentNano + reservedNano + boundNano > limitNano) throw new Error('Budget limit would be exceeded.');
    reservations.set(id, { boundNano, state: 'reserved' });
    reservedNano += boundNano;
    return asUsd(boundNano);
  }

  function settle(id, cost) {
    const reservation = reservations.get(id);
    if (!reservation || reservation.state !== 'reserved') throw new Error('Reservation is not unsettled.');
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      frozen = true;
      reservation.state = 'unknown';
      throw new Error('Actual request cost is unknown; budget is frozen.');
    }
    const actualNano = decimalNanoDollars(cost, true);
    reservation.state = 'settled';
    reservedNano -= reservation.boundNano;
    spentNano += actualNano;
    if (actualNano > reservation.boundNano) {
      frozen = true;
      throw new Error('Actual request cost exceeded its reservation; budget is frozen.');
    }
  }

  function snapshot() {
    return {
      limitUsd: asUsd(limitNano),
      spentUsd: asUsd(spentNano),
      reservedUsd: asUsd(reservedNano),
      frozen,
      remainingUsd: asUsd(limitNano - spentNano - reservedNano),
    };
  }

  return Object.freeze({ reserve, settle, snapshot });
}
