// Where to flush WAL so a reply is never sent before its commit record is durable.
// Needed because a client may SET synchronous_commit = off, and PGlite has no WAL writer
// that would otherwise flush those commits within a bounded time.

const PAGE = 8192n;
const SHORT_HEADER = 24n; // SizeOfXLogShortPHD
const LONG_HEADER = 40n; // SizeOfXLogLongPHD, on a segment's first page

/**
 * GetXLogInsertRecPtr() points past the next page's header when the insert position sits exactly on a
 * page boundary (XLogBytePosToRecPtr), but that header is not written yet. Flushing to it would ask
 * for WAL that does not exist, so flush to the page start there instead (XLogBytePosToEndRecPtr).
 */
export function walInsertEnd(insert: bigint, segmentBytes: bigint): bigint {
  const offset = insert % PAGE;
  if (offset !== SHORT_HEADER && offset !== LONG_HEADER) return insert;
  const page = insert - offset;
  const header = page % segmentBytes === 0n ? LONG_HEADER : SHORT_HEADER;
  return offset === header ? page : insert;
}
