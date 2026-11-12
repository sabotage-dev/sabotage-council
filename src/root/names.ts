/**
 * A file name or path the root cannot represent exactly. Lossy decoding maps different names to one string
 * (`a\x80` and `a�` both read as `a�`), so a check, the sanitizer or the hash could read one entry while
 * the disk holds another. The root build refuses such names instead.
 */
export class FileNameError extends Error {
  constructor(
    message: string,
    /** The name as decoded with replacement characters, for messages only. */
    readonly lossy: string,
  ) {
    super(message);
    this.name = 'FileNameError';
  }
}

/**
 * Decodes a raw file name or path as UTF-8 and refuses bytes that do not round-trip: invalid sequences, overlong
 * forms and encoded surrogates. `where` names the source (a directory, a commit) for the message.
 */
export function decodeName(raw: Buffer, where: string): string {
  const name = raw.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(raw)) {
    throw new FileNameError(
      `${where}: the name ${JSON.stringify(name)} (bytes ${raw.toString('hex')}) is not valid UTF-8; the root refuses names it cannot represent exactly`,
      name,
    );
  }
  return name;
}

/** Splits NUL-terminated git output (`-z`) into its raw records, dropping the empty tail. */
export function splitNul(out: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = out.indexOf(0); i >= 0; i = out.indexOf(0, start)) {
    records.push(out.subarray(start, i));
    start = i + 1;
  }
  if (start < out.length) records.push(out.subarray(start));
  return records.filter((r) => r.length > 0);
}
