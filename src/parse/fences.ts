/** One fenced block of a reply. */
export interface Fence {
  /** The info string after the opening fence, trimmed (`findings`, `ts`, ...). */
  info: string;
  body: string[];
  closed: boolean;
}

export interface FenceScan {
  fences: Fence[];
  /** Per line: true for a fence's opening line, its body and its closing line. An unclosed fence runs to the end. */
  inFence: boolean[];
}

// After the marker CommonMark allows only spaces and tabs, not `\s`: U+00A0 and the other Unicode spaces are text,
// so a line of three backticks and U+00A0 is body text, never a closing fence.
const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Finds the fenced blocks of a reply (CommonMark backtick and tilde fences). The findings parser and the verdict
 * parser share this scan, so a line is inside a fence for one exactly when it is for the other. As in CommonMark,
 * a backtick fence's info string cannot hold a backtick, so a one-line "```VERDICT: SHIP```" opens nothing.
 */
export function scanFences(lines: readonly string[]): FenceScan {
  const fences: Fence[] = [];
  const inFence: boolean[] = [];
  let open: { char: string; len: number; fence: Fence } | null = null;
  for (const line of lines) {
    if (open === null) {
      const m = OPEN.exec(line);
      const char = m?.[1]?.[0];
      const info = m?.[2] ?? '';
      if (m?.[1] !== undefined && char !== undefined && !(char === '`' && info.includes('`'))) {
        const fence: Fence = { info: info.trim(), body: [], closed: false };
        fences.push(fence);
        open = { char, len: m[1].length, fence };
        inFence.push(true);
      } else {
        inFence.push(false);
      }
      continue;
    }
    inFence.push(true);
    const close = CLOSE.exec(line);
    if (close?.[1] !== undefined && close[1][0] === open.char && close[1].length >= open.len) {
      open.fence.closed = true;
      open = null;
      continue;
    }
    open.fence.body.push(line);
  }
  return { fences, inFence };
}
