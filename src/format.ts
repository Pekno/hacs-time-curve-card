/**
 * Display formatting of curve values (French typography), shared by the card, the editor and the
 * config messages. Pure: no DOM, no Lit. The storage format (`19.5`, see formatCenti in
 * src/core/curve.ts) is never localized; only what the user reads is.
 */
import { formatCenti } from './core/curve.js';

/** Narrow no-break space (U+202F): French typography puts one between a number and its unit. */
export const NNBSP = '\u{202f}';

/**
 * A value in user units with the French decimal comma: 19.5 -> `19,5`, 70 -> `70`, -2.05 ->
 * `-2,05`. The value is rounded to whole hundredths first (every curve value already is one).
 * No thousands separator (`6500`).
 */
export function formatNumber(value: number): string {
  const centi = Math.round(value * 100) + 0;
  if (!Number.isSafeInteger(centi)) return String(value);
  return formatCenti(centi).replace('.', ',');
}

/**
 * A value with its unit, separated by a narrow no-break space: `19,5 \u{b0}C`, `57 %`, `2700 K`;
 * the bare number when the unit is empty.
 */
export function formatQuantity(value: number, unit: string): string {
  const text = formatNumber(value);
  return unit === '' ? text : `${text}${NNBSP}${unit}`;
}

/** A decimal number as typed by a user: optional sign, digits, `.` or `,` and digits. */
const DECIMAL_RE = /^([+-]?)(\d+)(?:[.,](\d+))?$/;

/**
 * Parses a decimal number typed by a user, with a French comma or a dot (`19,5`, `19.5`, ` -2 `,
 * `+3`); surrounding whitespace is ignored. Returns null for anything else (empty text, `1e3`,
 * `19,5,1`, `abc`).
 */
export function parseDecimal(text: string): number | null {
  const match = DECIMAL_RE.exec(text.trim());
  if (match === null) return null;
  const [, sign, intText, fracText] = match;
  const value = Number(
    `${sign ?? ''}${intText ?? ''}${fracText === undefined ? '' : `.${fracText}`}`,
  );
  return Number.isFinite(value) ? value + 0 : null;
}
