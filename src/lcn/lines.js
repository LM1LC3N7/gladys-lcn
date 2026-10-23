// -----------------------------------------------------------------------------
// The lines of PCHK, read from the socket: one forward pass over each chunk,
// bounded in memory. A line longer than LIMITS.maxLine is dropped whole (the
// bytes up to its end are skipped, never kept); a line holding a control
// character is dropped too. UTF-8, or Windows-1252-like bytes read as Latin-1
// when they are not valid UTF-8 (pypck falls back to cp1250 for LinHK).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const NEWLINE = 0x0a;

export class LineReader {
  constructor({ onLine, onDrop = () => undefined, maxLine = LIMITS.maxLine }) {
    this.onLine = onLine;
    this.onDrop = onDrop;
    this.maxLine = maxLine;
    this.parts = [];
    this.length = 0;
    this.skipping = false;
  }

  push(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      const stop = end === -1 ? chunk.length : end;
      if (!this.skipping) {
        const size = stop - start;
        if (this.length + size > this.maxLine) {
          // Too long: what was kept goes, the rest of the line is skipped.
          this.parts = [];
          this.length = 0;
          this.skipping = true;
        } else if (size > 0) {
          this.parts.push(chunk.subarray(start, stop));
          this.length += size;
        }
      }
      if (end === -1) return;
      if (this.skipping) {
        this.skipping = false;
        this.onDrop('too long');
      } else {
        this.emit();
      }
      start = end + 1;
    }
  }

  emit() {
    const bytes = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
    this.parts = [];
    this.length = 0;
    let text = bytes.toString('utf8');
    if (text.includes('�')) text = bytes.toString('latin1');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text === '') return;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) {
      this.onDrop('control character');
      return;
    }
    this.onLine(text);
  }
}
