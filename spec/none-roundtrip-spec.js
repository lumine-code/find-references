const path = require("node:path");
const os = require("node:os");

describe("Reference requests across a None round trip", () => {
  let manager, editor, grammar, lease;
  const held = () => {
    let resolve;
    return { promise: new Promise((done) => (resolve = done)), resolve: (value) => resolve(value) };
  };
  const flush = async () => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  };
  beforeEach(async () => {
    jasmine.useRealClock();
    const text = await lumine.packages.activatePackage("language-text");
    await text.resourceLoadPromise;
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    lumine.config.set("find-references.autoHighlight", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "reference-none-roundtrip.txt"));
    editor.setText("symbol\n");
    grammar = editor.getGrammar();
    manager = (await lumine.packages.activatePackage("find-references")).mainModule.manager;
  });
  afterEach(async () => {
    lease?.dispose();
    await lumine.packages.unloadPackage("find-references");
    editor.destroy();
  });
  const result = (name) => ({ symbolName: name, references: [] });
  function roundtrip(target = editor) {
    lumine.grammars.assignGrammar(target, lumine.grammars.nullGrammar);
    lumine.grammars.assignGrammar(target, grammar);
    expect(target.getGrammar()).toBe(grammar);
  }

  for (const embedded of [false, true]) {
    it(`retires pending provider eligibility for ${embedded ? "an embedded" : "a file"} editor before a fresh request`, async () => {
      let target = editor;
      if (embedded) {
        target = lumine.workspace.buildTextEditor();
        target.setText("symbol\n");
        target.getBuffer().setPath(path.join(os.tmpdir(), "reference-embedded-roundtrip.txt"));
        lumine.grammars.assignGrammar(target, grammar);
        jasmine.attachToDOM(target.element);
      }
      const eligibility = held();
      let calls = 0;
      const provider = {
        isEditorSupported: () => (++calls === 1 ? eligibility.promise : true),
        findReferences: jasmine.createSpy("find current references").and.resolveTo(result("fresh")),
      };
      lease = manager.addProvider(provider);
      let settled = false;
      const obsolete = manager.findReferencesAtPosition(target, [0, 0]).then((value) => {
        settled = true;
        return value;
      });
      try {
        roundtrip(target);
        await flush();
        expect(settled).toBe(true);
        expect(await manager.findReferencesAtPosition(target, [0, 0])).toEqual(result("fresh"));
        expect(provider.findReferences).toHaveBeenCalledTimes(1);
        eligibility.resolve(true);
        expect(await obsolete).toBeNull();
        expect(provider.findReferences).toHaveBeenCalledTimes(1);
      } finally {
        eligibility.resolve(true);
        await obsolete;
        if (embedded) target.destroy();
      }
    });
  }

  it("drops an old provider result while a new request finishes before it", async () => {
    const response = held();
    const find = jasmine
      .createSpy("find")
      .and.returnValues(response.promise, Promise.resolve(result("fresh")));
    lease = manager.addProvider({ isEditorSupported: () => true, findReferences: find });
    let settled = false;
    const obsolete = manager.findReferencesAtPosition(editor, [0, 0]).then((value) => {
      settled = true;
      return value;
    });
    roundtrip();
    await flush();
    expect(settled).toBe(true);
    expect(await manager.findReferencesAtPosition(editor, [0, 0])).toEqual(result("fresh"));
    response.resolve(result("obsolete"));
    expect(await obsolete).toBeNull();
    expect(editor.getText()).toBe("symbol\n");
  });

  it("discards a panel waiting for its view module through the same grammar round trip", async () => {
    const View = await manager.loadView();
    const loading = held();
    const load = spyOn(manager, "loadView").and.returnValue(loading.promise);
    const marker = editor.markBufferPosition([0, 0]);
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    let settled = false;
    const obsolete = manager
      .showReferencesPanel({ result: result("obsolete"), editor, marker })
      .then(() => {
        settled = true;
      });
    roundtrip();
    await flush();
    expect(settled).toBe(true);
    expect(marker.isDestroyed()).toBe(true);
    load.and.resolveTo(View);
    const freshMarker = editor.markBufferPosition([0, 0]);
    const fresh = await manager.showReferencesPanel({
      result: result("fresh"),
      editor,
      marker: freshMarker,
    });
    expect(fresh.getTitle()).toBe("References: fresh");
    loading.resolve(View);
    await obsolete;
    expect(open).toHaveBeenCalledTimes(1);
    expect(fresh.isDestroyed()).toBe(false);
    expect(View.pendingContexts.size).toBe(0);
  });

  it("removes only the cancelled panel while a newer opening finishes before the old one", async () => {
    const opening = held();
    const realOpen = lumine.workspace.open.bind(lumine.workspace);
    let oldPanel;
    const open = spyOn(lumine.workspace, "open").and.callFake(async (...args) => {
      oldPanel = await realOpen(...args);
      await opening.promise;
      return oldPanel;
    });
    const marker = editor.markBufferPosition([0, 0]);
    let settled = false;
    const obsolete = manager
      .showReferencesPanel({ result: result("obsolete"), editor, marker })
      .then(() => {
        settled = true;
      });
    await conditionPromise(() => Boolean(oldPanel));
    roundtrip();
    await conditionPromise(() => settled);
    expect(oldPanel.isDestroyed()).toBe(true);
    expect(marker.isDestroyed()).toBe(true);
    expect(lumine.workspace.paneForItem(oldPanel)).toBeUndefined();
    open.and.callFake(realOpen);
    const fresh = await manager.showReferencesPanel({
      result: result("fresh"),
      editor,
      marker: editor.markBufferPosition([0, 0]),
    });
    expect(fresh.getTitle()).toBe("References: fresh");
    opening.resolve();
    await obsolete;
    expect(fresh.isDestroyed()).toBe(false);
    expect(fresh.marker.isDestroyed()).toBe(false);
  });
});
