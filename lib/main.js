const FindReferencesManager = require("./find-references-manager");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

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

  provideFindReferencesMarkers() {
    // Expose a narrow facade rather than the manager itself so consumers never
    // depend on its internal state.
    const manager = this.manager;
    return {
      onDidChangeMarkers: (callback) => manager.onDidChangeMarkers(callback),
      getMarkersForEditor: (editor) => manager.getMarkersForEditor(editor),
    };
  },
};
