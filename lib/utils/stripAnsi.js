/**
 * stripAnsi — remove ANSI escape sequences from a string.
 * Handles CSI, OSC, G-set designations, and non-printable control bytes.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  return str
    // Cursor-forward (ESC[NC) → N spaces — Claude Code uses this instead of literal spaces
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences (ST or BEL terminated)
    .replace(/\x1b[()][AB012]/g, '')            // G-set designations
    .replace(/\x1b./g, '')                      // Remaining two-char escape sequences
    .replace(/\r+\n/g, '\n')                        // Normalize CRLF / CR+CR+LF → LF
    .replace(/\r/g, '\n')                           // Bare CR (in-place overwrite) → new line
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Non-printable control bytes (keep \n \t)
}
