const { CompositeDisposable, Emitter } = require("lumine");

describe("find-references marker layer", () => {
  let editor, mainModule, provider, layer, layers, service, consumerDisposable;

  // Minimal stand-in for the layer object a marker host passes to `initialize`
  // and `getItems` (see lib/layer.js in the marker package).
  function makeLayer(targetEditor) {
    const fake = {
      editor: targetEditor,
      props: provider,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
    };
    fake.update = jasmine.createSpy("update").and.callFake(() => {
      const items = provider.getItems(fake);
      if (items) {
        fake.items = items;
      }
    });
    fake.updateSync = fake.update;
    if (provider.initialize) {
      provider.initialize(fake);
    }
    layers.push(fake);
    return fake;
  }

  // Fake service mirroring the facade returned by this package's
  // provideFindReferencesMarkers(): onDidChangeMarkers and
  // getMarkersForEditor(editor).
  function makeFakeService() {
    const emitter = new Emitter();
    const markerLayers = new Map();
    return {
      emitter,
      markerLayers,
      onDidChangeMarkers: (callback) => emitter.on("did-change-markers", callback),
      getMarkersForEditor: (markerEditor) => markerLayers.get(markerEditor)?.getMarkers() || [],
    };
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pack = await lumine.packages.activatePackage("find-references");
    mainModule = pack.mainModule;
    // Detach the connection activate() made to the real manager, so the specs
    // drive the layer through the fake service alone.
    mainModule.markerLayerConnection.dispose();
    provider = mainModule.provideMarkerLayer();
    editor = await lumine.workspace.open();
    editor.setText(Array(50).fill("hello world").join("\n"));
    layers = [];
    layer = makeLayer(editor);
    service = makeFakeService();
    consumerDisposable = mainModule.markerLayer.connect(service);
  });

  afterEach(() => {
    consumerDisposable.dispose();
    for (const fake of layers) {
      fake.disposables.dispose();
    }
  });

  function markRanges(...ranges) {
    const markerLayer = editor.addMarkerLayer();
    for (const range of ranges) {
      markerLayer.markScreenRange(range);
    }
    service.markerLayers.set(editor, markerLayer);
    return markerLayer;
  }

  it("activates and provides a marker layer descriptor", () => {
    expect(lumine.packages.isPackageActive("find-references")).toBe(true);
    expect(provider.name).toBe("references");
    expect(typeof provider.description).toBe("string");
    expect(provider.merge).toBe(true);
    expect(provider.enabled).toBe("find-references.marker.enabled");
    expect(provider.threshold).toBe("find-references.marker.threshold");
    expect(typeof provider.initialize).toBe("function");
    expect(typeof provider.getItems).toBe("function");
  });

  it("pushes reference markers to the layer when the marks change", () => {
    markRanges(
      [
        [2, 0],
        [2, 5],
      ],
      [
        [10, 0],
        [11, 5],
      ],
    );
    service.emitter.emit("did-change-markers");
    expect(layer.update).toHaveBeenCalled();
    expect(layer.items).toEqual([
      { row: 2, end: 2 },
      { row: 10, end: 11 },
    ]);
  });

  it("returns raw ranges and leaves sorting and merging to the host", () => {
    // Created out of document order on purpose.
    markRanges(
      [
        [20, 0],
        [20, 5],
      ],
      [
        [3, 0],
        [3, 5],
      ],
    );
    service.emitter.emit("did-change-markers");
    expect(layer.items).toEqual([
      { row: 20, end: 20 },
      { row: 3, end: 3 },
    ]);
  });

  it("clears the layer when all marks are removed", () => {
    const markerLayer = markRanges([
      [2, 0],
      [2, 5],
    ]);
    service.emitter.emit("did-change-markers");
    expect(layer.items.length).toBe(1);

    markerLayer.clear();
    service.emitter.emit("did-change-markers");
    expect(layer.items).toEqual([]);
  });

  it("takes a fresh layer after the editor's layer detached", () => {
    // The layer detaches, then a new one attaches for the same editor. The
    // editor's entry is dropped on detach; holding on to the stale layer
    // would leave the new one unfed.
    layer.disposables.dispose();
    expect(mainModule.markerLayer.layers.has(editor)).toBe(false);

    const third = makeLayer(editor);
    markRanges([
      [7, 0],
      [7, 5],
    ]);
    service.emitter.emit("did-change-markers");
    expect(third.update).toHaveBeenCalled();
    expect(third.items).toEqual([{ row: 7, end: 7 }]);
  });

  it("stops updating the layer once the consumer is disposed", () => {
    consumerDisposable.dispose();
    layer.update.calls.reset();
    service.emitter.emit("did-change-markers");
    expect(layer.update).not.toHaveBeenCalled();
    expect(mainModule.markerLayer.marksService).toBeNull();
  });
});
