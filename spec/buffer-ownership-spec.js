const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Range, TextBuffer } = require("lumine");
const removeTemporaryDirectory = require("./helpers/temporary-directory");

describe("find-references preview buffer ownership", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let View, editor, directory, temporaryRoot, betaPath, gammaPath, panels, loads, hold;
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("find-references");
    View = require("../lib/references-view");
    temporaryRoot = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporaryRoot, "references-cache-")),
    );
    const alphaPath = path.join(directory, "alpha.js");
    betaPath = path.join(directory, "beta.js");
    gammaPath = path.join(directory, "gamma.js");
    for (const [file, text] of [
      [alphaPath, "alpha source\n"],
      [betaPath, "beta preview\n"],
      [gammaPath, "gamma preview\n"],
    ])
      fs.writeFileSync(file, text);
    lumine.project.setPaths([directory]);
    editor = await lumine.workspace.open(alphaPath);
    panels = [];
    loads = [];
    hold = new Map();
    const load = TextBuffer.load.bind(TextBuffer);
    spyOn(TextBuffer, "load").and.callFake(async (...args) => {
      const buffer = await load(...args);
      loads.push(buffer);
      const gate = hold.get(args[0]);
      if (gate) {
        hold.delete(args[0]);
        await gate.promise;
      }
      return buffer;
    });
  });

  afterEach(async () => {
    for (const panel of panels) await panel.destroy();
    await lumine.packages.deactivatePackage("find-references");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
    for (const buffer of loads) if (!buffer.isDestroyed()) buffer.destroy();
    lumine.project.setPaths([]);
    await removeTemporaryDirectory(directory);
  });

  const references = (...files) =>
    files.map((file) => ({ path: file, range: new Range([0, 0], [0, 4]) }));
  function createPanel(files, manager = { findReferencesAtPosition: async () => null }) {
    const uri = View.nextUri();
    View.setReferences(uri, {
      editor,
      manager,
      marker: editor.markBufferRange([
        [0, 0],
        [0, 4],
      ]),
      references: references(...files),
      symbolName: "alpha",
    });
    const panel = new View(uri);
    panels.push(panel);
    return panel;
  }

  it("destroys a real owned load that completes after the preview closes", async () => {
    const gate = deferred();
    hold.set(betaPath, gate);
    const panel = createPanel([betaPath]);
    const cache = panel.bufferCache;
    await conditionPromise(() => loads.length === 1);
    const buffer = loads[0];
    await panel.destroy();
    gate.resolve();
    await flushMicrotasks();

    expect(buffer.isDestroyed()).toBe(true);
    expect(cache.has(betaPath)).toBe(false);
  });

  it("retires a replaced cache and destroys its late load without changing the latest previews", async () => {
    const gate = deferred();
    hold.set(betaPath, gate);
    const panel = createPanel([betaPath]);
    const cache = panel.bufferCache;
    await conditionPromise(() => loads.length === 1);
    const old = loads[0];
    await panel.update({ references: references(gammaPath), symbolName: "new symbol" });
    await conditionPromise(() => panel.bufferCache.has(gammaPath));
    gate.resolve();
    await flushMicrotasks();

    expect(old.isDestroyed()).toBe(true);
    expect(cache.has(betaPath)).toBe(false);
    expect(panel.bufferCache.has(betaPath)).toBe(false);
    expect(panel.bufferCache.get(gammaPath).lineForRow(0)).toBe("gamma preview");
    expect(panel.symbolName).toBe("new symbol");
  });

  it("releases completed owned previews when the cache changes or the view closes", async () => {
    const panel = createPanel([betaPath]);
    await conditionPromise(() => panel.bufferCache.has(betaPath));
    const old = panel.bufferCache.get(betaPath);
    await panel.update({ references: references(gammaPath) });
    await conditionPromise(() => panel.bufferCache.has(gammaPath));
    const current = panel.bufferCache.get(gammaPath);

    expect(old.isDestroyed()).toBe(true);
    await panel.destroy();
    expect(current.isDestroyed()).toBe(true);
  });

  it("borrows live workspace buffers and preserves their unsaved text after close", async () => {
    const borrowed = editor.getBuffer();
    editor.setText("unsaved alpha\n");
    const panel = createPanel([editor.getPath()]);

    expect(panel.bufferCache.get(editor.getPath())).toBe(borrowed);
    await panel.destroy();
    expect(borrowed.isDestroyed()).toBe(false);
    expect(editor.getText()).toBe("unsaved alpha\n");
    expect(loads.length).toBe(0);
  });

  it("prefers a workspace buffer opened while its owned disk preview is still loading", async () => {
    const gate = deferred();
    hold.set(betaPath, gate);
    const panel = createPanel([betaPath]);
    await conditionPromise(() => loads.length === 1);
    const preview = loads[0];
    const current = await lumine.workspace.open(betaPath);
    current.setText("unsaved beta\n");
    gate.resolve();
    await flushMicrotasks();

    expect(panel.bufferCache.get(betaPath)).toBe(current.getBuffer());
    expect(preview.isDestroyed()).toBe(true);
    await panel.destroy();
    expect(current.isDestroyed()).toBe(false);
    expect(current.getText()).toBe("unsaved beta\n");
  });

  it("preserves an owned preview adopted by an actual workspace editor", async () => {
    const panel = createPanel([betaPath]);
    await conditionPromise(() => panel.bufferCache.has(betaPath));
    const buffer = panel.bufferCache.get(betaPath);
    const adopted = lumine.workspace.buildTextEditor({ buffer });
    await lumine.workspace.open(adopted);
    expect(buffer.hasMultipleEditors()).toBe(false);
    await panel.destroy();

    expect(buffer.isDestroyed()).toBe(false);
    expect(adopted.getText()).toBe("beta preview\n");
  });

  it("coalesces simultaneous completion requests for the same cache path", async () => {
    const gate = deferred();
    hold.set(betaPath, gate);
    const panel = createPanel([betaPath]);
    const completion = panel.completeBufferCache();
    await conditionPromise(() => loads.length >= 1);
    gate.resolve();
    await completion;
    await flushMicrotasks();

    expect(TextBuffer.load).toHaveBeenCalledTimes(1);
    expect(panel.bufferCache.get(betaPath).isDestroyed()).toBe(false);
  });

  it("silently skips copying without creating another origin or preview buffer", async () => {
    const source = createPanel([betaPath, gammaPath]);
    await lumine.workspace.open(source);
    await conditionPromise(() => source.bufferCache.has(betaPath));
    const sourceBuffer = source.bufferCache.get(betaPath);
    const count = editor.getBuffer().getMarkerCount();
    const panes = lumine.workspace.getPanes();
    const warnings = spyOn(lumine.notifications, "addWarning");
    const errors = spyOn(lumine.notifications, "addError");
    expect(await lumine.workspace.copyPaneItem(source, { splitDirection: "right" })).toBeNull();
    expect(editor.getBuffer().getMarkerCount()).toBe(count);
    expect(source.bufferCache.get(betaPath)).toBe(sourceBuffer);
    expect(sourceBuffer.isDestroyed()).toBe(false);
    expect(lumine.workspace.getPanes()).toEqual(panes);
    expect(warnings).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("retires separate query panels and their pending origins with their manager", async () => {
    const manager = lumine.packages.getActivePackage("find-references").mainModule.manager;
    const first = createPanel([betaPath], manager);
    const second = createPanel([gammaPath], manager);
    await lumine.workspace.open(first);
    await lumine.workspace.open(second);
    expect(first.getSingletonKey()).not.toBe(second.getSingletonKey());
    const pendingURI = View.nextUri();
    const marker = editor.markBufferRange([
      [0, 0],
      [0, 4],
    ]);
    View.setReferences(pendingURI, { manager, marker });
    manager.dispose();
    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(true);
    expect(marker.isDestroyed()).toBe(true);
    expect(View.instances.has(first.uri)).toBe(false);
    expect(View.instances.has(second.uri)).toBe(false);
    expect(View.pendingContexts.has(pendingURI)).toBe(false);
  });

  it("moves a result panel with its original tracked marker and independent resource key", async () => {
    const source = createPanel([betaPath]);
    await lumine.workspace.open(source);
    const marker = source.marker;
    const root = source.element;
    const key = source.getSingletonKey();
    const moved = await lumine.workspace.movePaneItem(source, { splitDirection: "right" });
    expect(moved.item).toBe(source);
    expect(source.marker).toBe(marker);
    expect(source.element).toBe(root);
    expect(source.getSingletonKey()).toBe(key);
  });
});
