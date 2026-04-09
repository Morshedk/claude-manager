/**
 * stripAnsi — remove ANSI escape sequences from a string.
 * Handles CSI, OSC, G-set designations, and non-printable control bytes.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')            // G-set designations
    .replace(/\x1b[\[>?=]/g, '')               // Other escape starters
    .replace(/\x1b[^\x1b]*/g, '')             // Any remaining escape sequences
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ''); // Non-printable control bytes (keep \n \r \t)
}
