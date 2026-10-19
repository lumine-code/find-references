const { Disposable } = require("lumine");

// The `marker.layer` provider: reference occurrences on the overview maps.
//
// Fed through the package's own `find-references.markers` facade — the same
// service an external consumer would get — so the layer and the highlight
// decorations always report the same set of markers.
module.exports = {
  activate() {
    this.marksService = null;
    this.connection = null;
    // Layers handed over by the marker hub, keyed by editor. The hub builds
    // exactly one layer per (provider, editor), so a plain map suffices.
    this.layers = new Map();
  },

  deactivate() {
    this.marksService = null;
    this.connection = null;
    this.layers?.clear();
  },

  updateLayers() {
    for (const layer of this.layers.values()) layer.update();
  },

  connect(marksService) {
    const connection = {};
    this.connection = connection;
    this.marksService = marksService;
    const updateEditor = (editor) => {
      if (this.connection === connection) this.layers.get(editor)?.update();
    };
    const subscription = marksService.onDidChangeMarkers(updateEditor);
    this.updateLayers();
    return new Disposable(() => {
      subscription.dispose();
      if (this.connection !== connection) return;
      this.connection = null;
      this.marksService = null;
      this.updateLayers();
    });
  },

  provideMarkerLayer() {
    return {
      name: "references",
      description: "Reference occurrence markers",
      merge: true,
      enabled: "find-references.marker.enabled",
      threshold: "find-references.marker.threshold",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.disposables.add(
          new Disposable(() => {
            this.layers.delete(layer.editor);
          }),
        );
        layer.update();
      },
      getItems: ({ editor }) => {
        // Marker changes only invalidate; a frame reads the current results
        // after the provider has finished replacing its highlights.
        const data = this.marksService?.getMarkersForEditor(editor) ?? [];
        const items = [];
        for (const marker of data) {
          if (!marker.isValid()) continue;
          const range = marker.getScreenRange();
          items.push({ row: range.start.row, end: range.end.row });
        }
        return items;
      },
    };
  },
};
