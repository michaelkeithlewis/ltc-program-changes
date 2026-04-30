import { autoFormatTimecodeInput } from '../../../shared/midi'

export interface TcFormatResult {
  /** Auto-formatted timecode string, ready to feed back into the input. */
  value: string
  /**
   * Caret position inside `value` corresponding to the same digit the user
   * was on in `raw` — so backspacing/typing in the middle of an existing
   * timecode keeps the caret where the user expects it, instead of jumping
   * to the end on every keystroke (the default behaviour for a controlled
   * input whose value is rewritten by `onChange`).
   */
  caret: number
}

/**
 * Pure helper that auto-formats a timecode entry while preserving the
 * caret's logical position. The "logical position" is the *digit index* the
 * caret sits at: we count how many digits come before the caret in the raw
 * input, then walk the formatted string and place the caret right after
 * that many digits, skipping over the auto-inserted colons.
 *
 * Pure / framework-agnostic — the React glue (reading `selectionStart`,
 * calling `setSelectionRange` after the re-render commits) lives in the
 * component.
 */
export function formatTimecodeWithCaret(
  raw: string,
  caret: number,
  previousValue?: string,
): TcFormatResult {
  const digitsBefore = raw.slice(0, caret).replace(/\D/g, '').length
  const formatted = autoFormatTimecodeInput(raw)
  let newCaret = formatted.length
  let count = 0
  for (let i = 0; i <= formatted.length; i++) {
    if (count === digitsBefore) {
      newCaret = i
      break
    }
    if (i < formatted.length && /\d/.test(formatted[i])) count++
  }
  // Push past any auto-inserted colon(s) the caret would otherwise land on
  // the LEFT side of, but ONLY when the user actually changed the digit
  // count (typed or deleted a digit). If the digit count is unchanged the
  // edit was either a colon delete (formatter restores it) or a no-op —
  // in that case we leave the caret where it falls so subsequent
  // backspaces can keep eating leftward instead of bouncing off the
  // re-inserted colon forever.
  const newDigitCount = formatted.replace(/\D/g, '').length
  const prevDigitCount =
    previousValue !== undefined
      ? previousValue.replace(/\D/g, '').length
      : -1
  const digitCountChanged =
    prevDigitCount === -1 || newDigitCount !== prevDigitCount
  if (digitCountChanged) {
    while (
      newCaret < formatted.length &&
      (formatted[newCaret] === ':' || formatted[newCaret] === ';')
    ) {
      newCaret++
    }
  }
  return { value: formatted, caret: newCaret }
}

/**
 * Convenience wrapper that does the full controlled-input dance: reads the
 * current value + selection from the `<input>`, computes the formatted
 * value and the new caret position, fires the supplied setter, and
 * restores the caret on the next animation frame (after React has had a
 * chance to commit the re-render). Returns the formatted value so callers
 * can use it for additional side-effects (persistence, validation, etc.).
 */
export function applyTimecodeFormat(
  input: HTMLInputElement,
  setValue: (next: string) => void,
  previousValue?: string,
): string {
  const raw = input.value
  const caret = input.selectionStart ?? raw.length
  const { value, caret: nextCaret } = formatTimecodeWithCaret(
    raw,
    caret,
    previousValue,
  )
  setValue(value)
  requestAnimationFrame(() => {
    if (document.activeElement !== input) return
    try {
      input.setSelectionRange(nextCaret, nextCaret)
    } catch {
      // Some input types (e.g. type="number") don't support selection
      // ranges. Non-fatal; just leave the browser default.
    }
  })
  return value
}
