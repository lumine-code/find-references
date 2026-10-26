function linePreview(buffer, row, column = 0) {
  const length = buffer?.lineLengthForRow(row);
  if (!Number.isFinite(length)) return { text: "", startColumn: 0, prefix: "", suffix: "" };
  let startColumn = Math.max(0, Math.min(length, column) - 128);
  let endColumn = Math.min(length, startColumn + 768);
  const source = buffer.getTextSnapshot();
  const start = buffer.characterIndexForPosition([row, 0]);
  const high = (code) => code >= 0xd800 && code <= 0xdbff;
  const low = (code) => code >= 0xdc00 && code <= 0xdfff;
  if (
    startColumn > 0 &&
    low(source.charCodeAt(start + startColumn)) &&
    high(source.charCodeAt(start + startColumn - 1))
  )
    startColumn--;
  if (
    endColumn < length &&
    high(source.charCodeAt(start + endColumn - 1)) &&
    low(source.charCodeAt(start + endColumn))
  )
    endColumn++;
  return {
    text: source.slice(start + startColumn, start + endColumn),
    startColumn,
    prefix: startColumn > 0 ? "…" : "",
    suffix: endColumn < length ? "…" : "",
  };
}

module.exports = linePreview;
