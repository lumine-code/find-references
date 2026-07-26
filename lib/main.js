const FindReferencesManager = require("./find-references-manager");

module.exports = {
  activate() {
    this.manager = new FindReferencesManager();
  },

  deactivate() {
    this.manager?.dispose();
    this.manager = null;
  },

  consumeFindReferences(provider) {
    return this.manager.addProvider(provider);
  },

  provideReferenceMarks() {
    // Expose a narrow facade rather than the manager itself so consumers never
    // depend on its internal state.
    const manager = this.manager;
    return {
      onDidChangeMarkers: (callback) => manager.onDidChangeMarkers(callback),
      getMarkersForEditor: (editor) => manager.getMarkersForEditor(editor),
    };
  },
};
