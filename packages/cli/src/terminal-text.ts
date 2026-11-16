/** Characters that move the cursor, break a line or reorder text. */
const UNSAFE =
  // Matching control characters is what this expression is for.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Text as a terminal should show it. Control, line-separator and bidirectional
 * override characters become visible escapes, so a name taken from a recorded
 * session cannot recolour the terminal, move the cursor or forge a line.
 */
export function terminalSafe(text: string): string {
  return text.replace(
    UNSAFE,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
}
