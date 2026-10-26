const { TextBuffer, Range } = require("lumine");

describe("bounded reference line previews", () => {
  let buffer;
  afterEach(() => buffer?.destroy());
  it("keeps the match's source offset while reading only a short window of a giant row", () => {
    buffer = new TextBuffer({ text: "x".repeat(100000) + "TARGET" + "tail".repeat(1000) });
    const read = spyOn(buffer, "lineForRow").and.throwError("whole preview row");
    const preview = require("../lib/line-preview")(buffer, 0, 100000);
    expect(preview.text.length).toBeLessThanOrEqual(770);
    expect(preview.text.slice(100000 - preview.startColumn, 100006 - preview.startColumn)).toBe(
      "TARGET",
    );
    expect(preview.prefix).toBe("…");
    expect(preview.suffix).toBe("…");
    expect(read).not.toHaveBeenCalled();
  });

  it("does not split UTF-16 surrogate pairs at either preview boundary", () => {
    buffer = new TextBuffer({ text: "😀".repeat(3000) });
    const preview = require("../lib/line-preview")(buffer, 0, 1001);
    expect(preview.text.startsWith("😀")).toBeTrue();
    expect(preview.text.endsWith("😀")).toBeTrue();
  });

  function context(sourceBuffer) {
    return {
      activeNavigationIndex: 0,
      indexToReferenceMap: new Map([[0, { range: new Range([0, 0], [0, 1]) }]]),
      activeElement: { matches: () => false, dataset: { filePath: "owned" } },
      bufferCache: new Map([["owned", sourceBuffer]]),
    };
  }

  it("copies the complete line, including text outside the display preview", async () => {
    const text = "😀".repeat(2000);
    buffer = new TextBuffer({ text });
    const write = spyOn(lumine.clipboard, "write").and.resolveTo();
    await require("../lib/references-view").prototype.copyActiveLine.call(context(buffer));
    expect(write).toHaveBeenCalledWith(text);
  });

  it("rejects an impossible clipboard string before materializing any text", async () => {
    const value = {
      length: 600000000,
      canMaterialize: () => false,
      toString: jasmine.createSpy("flatten").and.throwError("oversized clipboard"),
    };
    const input = {
      lineLengthForRow: () => value.length,
      rangeForRow: () => [],
      getTextSnapshotInRange: () => value,
    };
    const write = spyOn(lumine.clipboard, "write").and.resolveTo();
    const error = spyOn(lumine.notifications, "addError");
    await require("../lib/references-view").prototype.copyActiveLine.call(context(input));
    expect(value.toString).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
