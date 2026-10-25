describe("Reference panel opening ownership", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let manager, editor, lease, View;
  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    lumine.config.set("find-references.autoHighlight", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("symbol\n");
    manager = (await lumine.packages.activatePackage("find-references")).mainModule.manager;
    lease = manager.addProvider({
      isEditorSupported: () => true,
      findReferences: async () => ({
        symbolName: "symbol",
        references: [
          {
            path: __filename,
            range: [
              [0, 0],
              [0, 6],
            ],
          },
        ],
      }),
    });
    View = await manager.loadView();
  });
  afterEach(async () => {
    lease.dispose();
    await lumine.packages.deactivatePackage("find-references");
    editor.destroy();
  });
  const request = (manager, editor) =>
    manager.requestReferencesForPanel({ target: editor.getElement() });

  it("reports a rejected new opening and releases its pending context and origin marker", async () => {
    let marker;
    spyOn(lumine.workspace, "open").and.callFake(async (uri) => {
      marker = View.pendingContexts.get(uri).marker;
      throw new Error("Failed asynchronous opening");
    });
    const errors = spyOn(manager, "showProviderError").and.callThrough();
    expect(await request(manager, editor)).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(View.pendingContexts.size).toBe(0);
    expect(marker.isDestroyed()).toBe(true);
    expect(manager.pendingPanelMarkers.size).toBe(0);
  });

  it("retires a newly constructed view when opening fails after the opener consumed its context", async () => {
    let panel;
    spyOn(lumine.workspace, "open").and.callFake(async (uri) => {
      panel = new View(uri);
      throw new Error("Failed after construction");
    });
    expect(await request(manager, editor)).toBeNull();
    expect(panel.isDestroyed()).toBe(true);
    expect(panel.marker.isDestroyed()).toBe(true);
    expect(View.instances.has(panel.uri)).toBe(false);
    expect(View.pendingContexts.size).toBe(0);
  });

  it("retains an already adopted live panel and marker when bringing it forward rejects", async () => {
    const panel = await request(manager, editor);
    const previousMarker = panel.marker;
    let adoptedMarker;
    const opening = spyOn(lumine.workspace, "open").and.callFake(async (item) => {
      expect(item).toBe(panel);
      adoptedMarker = item.marker;
      throw new Error("Failed to reveal existing panel");
    });
    const errors = spyOn(manager, "showProviderError").and.callThrough();
    expect(await request(manager, editor)).toBeNull();
    expect(opening).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(panel.isDestroyed()).toBe(false);
    expect(panel.marker).toBe(adoptedMarker);
    expect(adoptedMarker.isDestroyed()).toBe(false);
    expect(previousMarker.isDestroyed()).toBe(true);
    expect(View.instances.get(panel.uri)).toBe(panel);
    expect(manager.pendingPanelMarkers.size).toBe(0);
  });

  it("does not destroy a later reused context when an older opening rejects", async () => {
    const panel = await request(manager, editor);
    let rejectOld;
    let entered;
    const started = new Promise((resolve) => (entered = resolve));
    const opening = spyOn(lumine.workspace, "open").and.callFake(() => {
      entered();
      return new Promise((_resolve, reject) => (rejectOld = reject));
    });
    const errors = spyOn(manager, "showProviderError").and.callThrough();
    const previous = request(manager, editor);
    await started;
    const previousMarker = panel.marker;
    opening.and.resolveTo(panel);
    expect(await request(manager, editor)).toBe(panel);
    const currentMarker = panel.marker;
    rejectOld(new Error("Obsolete opening failed"));
    expect(await previous).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(panel.marker).toBe(currentMarker);
    expect(currentMarker.isDestroyed()).toBe(false);
    expect(previousMarker.isDestroyed()).toBe(true);
    expect(panel.isDestroyed()).toBe(false);
  });

  it("preserves a replacement pending context while retiring only the failed request's marker", async () => {
    let uri, originalMarker, replacement;
    spyOn(lumine.workspace, "open").and.callFake(async (openingURI) => {
      uri = openingURI;
      originalMarker = View.pendingContexts.get(uri).marker;
      replacement = {
        manager,
        editor,
        marker: editor.markBufferRange([
          [0, 0],
          [0, 0],
        ]),
        references: [],
      };
      View.setReferences(uri, replacement);
      throw new Error("Failed after context replacement");
    });
    expect(await request(manager, editor)).toBeNull();
    expect(View.pendingContexts.get(uri)).toBe(replacement);
    expect(replacement.marker.isDestroyed()).toBe(false);
    expect(originalMarker.isDestroyed()).toBe(true);
  });
});
