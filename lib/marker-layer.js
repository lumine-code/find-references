const { Disposable } = require("lumine");

// The `marker.layer` provider: reference occurrences on the overview maps.
//
// Fed through the package's own `find-references.markers` facade — the same
// service an external consumer would get — so the layer and the highlight
// decorations always report the same set of markers.
module.exports = {
  activate() {
    this.marksService = null;
    // Layers handed over by the marker hub, keyed by editor. The hub builds
    // exactly one layer per (provider, editor), so a plain map suffices.
    this.layers = new Map();
  },

  deactivate() {
    this.marksService = null;
    this.layers.clear();
  },

  connect(marksService) {
    this.marksService = marksService;
    const updateAll = () => {
      for (const [editor, layer] of this.layers) {
        layer.cache.set("data", marksService.getMarkersForEditor(editor));
        layer.update();
      }
    };
    // `updateAll` is deliberately not invoked on connect, and `initialize`
    // seeds no cache: a layer attaching mid-session stays blank until the
    // next marker change, which is at most one cursor rest away.
    let subscription = marksService.onDidChangeMarkers(updateAll);
    return new Disposable(() => {
      this.marksService = null;
      subscription.dispose();
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
      },
      getItems: ({ cache }) => {
        const data = cache.get("data") || [];
        return data.map((marker) => {
          const range = marker.getScreenRange();
          return { row: range.start.row, end: range.end.row };
        });
      },
    };
  },
};
