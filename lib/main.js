const FindReferencesManager = require("./find-references-manager");
const markerLayer = require("./marker-layer");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "find-references",
      tips: [
        "{% if keys['find-references:show-panel'] %}You can list every reference to the symbol under the cursor with {{ 'find-references:show-panel' | keystroke }}{% else %}You can list every reference to the symbol under the cursor, grouped by file.{% endif %}",
      ],
    };
  },

  activate() {
    this.manager = new FindReferencesManager();
    // The overview-map layer consumes the package's own markers facade,
    // exactly as an external consumer of `find-references.markers` would.
    markerLayer.activate();
    this.markerLayerConnection = markerLayer.connect(this.provideFindReferencesMarkers());
  },

  deactivate() {
    this.markerLayerConnection?.dispose();
    this.markerLayerConnection = null;
    markerLayer.deactivate();
    this.manager?.dispose();
    this.manager = null;
  },

  consumeFindReferences(provider) {
    return this.manager.addProvider(provider);
  },

  provideFindReferencesMarkers() {
    // Expose a narrow facade rather than the manager itself so consumers never
    // depend on its internal state.
    const manager = this.manager;
    return {
      onDidChangeMarkers: (callback) => manager.onDidChangeMarkers(callback),
      getMarkersForEditor: (editor) => manager.getMarkersForEditor(editor),
    };
  },

  provideMarkerLayer() {
    return markerLayer.provideMarkerLayer();
  },

  markerLayer,
};
