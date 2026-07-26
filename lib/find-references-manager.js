const { CompositeDisposable, Disposable, Emitter, Range } = require("atom");
const ReferencesView = require("./references-view");

// How long after the user last typed before the highlight debounce returns to
// the configured delay.
const TYPING_DELAY = 1000;

module.exports = class FindReferencesManager {
  constructor() {
    this.editor = null;
    this.providers = [];
    this.isTyping = false;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.editorSubscriptions = null;
    this.markerLayersForEditors = new Map();
    this.layerDecorationsForEditors = new Map();
    this.errorNotification = null;
    this.cursorMoveTimer = null;
    this.typingTimer = null;
    this.onCursorMove = this.onCursorMove.bind(this);

    this.subscriptions.add(
      atom.workspace.addOpener((uri) => {
        if (uri.startsWith(ReferencesView.URI) && ReferencesView.hasContext(uri)) {
          return new ReferencesView(uri);
        }
      }),
      atom.workspace.observeActiveTextEditor((editor) => {
        this.updateCurrentEditor(editor ?? null);
      }),
      atom.commands.add("atom-text-editor", {
        "find-references:highlight": () => this.requestReferencesUnderCursor(true),
        "find-references:show-panel": () => this.requestReferencesForPanel(),
      }),
      atom.config.observe("find-references.autoHighlight", (value) => {
        this.autoHighlight = value;
      }),
      atom.config.observe("find-references.delay", (value) => {
        this.delay = value;
      }),
      atom.config.observe("find-references.skipCurrentReference", (value) => {
        this.skipCurrentReference = value;
      }),
      atom.config.observe("find-references.ignoreThreshold", (value) => {
        this.ignoreThreshold = value;
      }),
      atom.config.observe("find-references.splitDirection", (value) => {
        this.splitDirection = value;
      }),
    );
  }

  dispose() {
    clearTimeout(this.cursorMoveTimer);
    clearTimeout(this.typingTimer);
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    for (const item of atom.workspace.getPaneItems()) {
      if (item instanceof ReferencesView) {
        atom.workspace.paneForItem(item)?.destroyItem(item, true);
      }
    }
    for (const layer of this.markerLayersForEditors.values()) {
      if (!layer.isDestroyed()) layer.destroy();
    }
    this.markerLayersForEditors.clear();
    this.layerDecorationsForEditors.clear();
    this.subscriptions.dispose();
    this.emitter.dispose();
  }

  // PROVIDERS

  addProvider(provider) {
    this.providers.push(provider);
    return new Disposable(() => {
      const index = this.providers.indexOf(provider);
      if (index > -1) this.providers.splice(index, 1);
    });
  }

  getProviderForEditor(editor) {
    return this.providers.find((provider) => provider.isEditorSupported(editor)) ?? null;
  }

  // THE `find-references.markers` SERVICE SURFACE

  onDidChangeMarkers(callback) {
    return this.emitter.on("did-change-markers", callback);
  }

  getMarkersForEditor(editor) {
    const layer = this.markerLayersForEditors.get(editor);
    return layer && !layer.isDestroyed() ? layer.getMarkers() : [];
  }

  // EDITOR MANAGEMENT

  updateCurrentEditor(editor) {
    if (editor === this.editor) return;

    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.editor = null;

    if (!editor || !atom.workspace.isTextEditor(editor)) return;

    this.editor = editor;
    this.editorSubscriptions = new CompositeDisposable(
      editor.onDidChangeCursorPosition(this.onCursorMove),
      editor.getBuffer().onDidChange(() => {
        this.isTyping = true;
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => {
          this.isTyping = false;
        }, TYPING_DELAY);
      }),
    );
    this.onCursorMove();
  }

  onCursorMove() {
    clearTimeout(this.cursorMoveTimer);

    // Any existing highlight clears as soon as the cursor moves.
    if (this.editor) this.clearHighlight(this.editor);
    if (!this.autoHighlight) return;

    this.cursorMoveTimer = setTimeout(
      () => this.requestReferencesUnderCursor(),
      // When the user is typing, wait at least as long as the typing window.
      this.isTyping ? TYPING_DELAY : this.delay,
    );
  }

  // FIND REFERENCES

  // Resolves to `{ symbolName, references }` with every reference range
  // upgraded to a `Range`, or `null` when no provider can serve the request.
  // Provider rejections surface as a single dismissable error notification.
  async findReferencesAtPosition(editor, position) {
    const provider = this.getProviderForEditor(editor);
    if (!provider) return null;
    let result;
    try {
      result = await provider.findReferences(editor, position);
    } catch (error) {
      this.showProviderError(error);
      return null;
    }
    if (!result) return null;
    return {
      symbolName: result.symbolName ?? null,
      references: (result.references ?? []).map((reference) => ({
        ...reference,
        range: Range.fromObject(reference.range),
      })),
    };
  }

  async requestReferencesUnderCursor(force = false) {
    const editor = this.editor;
    if (!editor || editor.isDestroyed()) return;
    const position = this.getCursorPositionForEditor(editor);
    if (!position) return;
    const result = await this.findReferencesAtPosition(editor, position);
    if (!result) return;
    this.highlightReferencesInVisibleEditors(result.references, force);
  }

  highlightReferencesInVisibleEditors(references, force) {
    const referencesByPath = new Map();
    for (const reference of references) {
      let list = referencesByPath.get(reference.path);
      if (!list) referencesByPath.set(reference.path, (list = []));
      list.push(reference);
    }
    for (const editor of this.getVisibleEditors()) {
      this.highlightReferences(editor, referencesByPath.get(editor.getPath()) ?? [], force);
    }
  }

  highlightReferences(editor, references, force) {
    const layer = this.getOrCreateMarkerLayerForEditor(editor);
    if (layer.isDestroyed()) return;
    layer.clear();

    if (this.autoHighlight || force) {
      const cursorPosition = editor.getLastCursor().getBufferPosition();
      const seen = new Set();
      const ranges = [];
      for (const { range } of references) {
        const key = range.toString();
        if (seen.has(key)) continue;
        if (this.skipCurrentReference && range.containsPoint(cursorPosition)) continue;
        seen.add(key);
        ranges.push(range);
      }
      // When the reference count is a large share of the buffer, the provider
      // is likely reporting something mundane; showing it all would only be
      // noise (and lots of decorations).
      const overloaded =
        this.ignoreThreshold > 0 && ranges.length / editor.getLineCount() >= this.ignoreThreshold;
      if (!overloaded) {
        for (const range of ranges) layer.markBufferRange(range);
      }
    }

    this.emitter.emit("did-change-markers");
  }

  clearHighlight(editor) {
    const layer = this.markerLayersForEditors.get(editor);
    if (!layer || layer.isDestroyed() || layer.getMarkerCount() === 0) return;
    layer.clear();
    this.emitter.emit("did-change-markers");
  }

  getOrCreateMarkerLayerForEditor(editor) {
    let layer = this.markerLayersForEditors.get(editor);
    if (!layer || layer.isDestroyed()) {
      layer = editor.addMarkerLayer();
      const decoration = editor.decorateMarkerLayer(layer, {
        type: "highlight",
        class: "find-references-reference",
      });
      this.markerLayersForEditors.set(editor, layer);
      this.layerDecorationsForEditors.set(editor, decoration);
      const removal = editor.onDidDestroy(() => {
        this.markerLayersForEditors.delete(editor);
        this.layerDecorationsForEditors.delete(editor);
        removal.dispose();
      });
    }
    return layer;
  }

  // RESULTS PANEL

  async requestReferencesForPanel() {
    const editor = this.editor;
    if (!editor || editor.isDestroyed()) return;
    const position = this.getCursorPositionForEditor(editor);
    if (!position) return;
    const result = await this.findReferencesAtPosition(editor, position);
    // With no new references to show, return early rather than replace the
    // previous results with an empty panel.
    if (!result) return;
    // Track the logical position that triggered the panel so its results can
    // refresh through subsequent edits.
    const marker = editor.markBufferRange(new Range(position, position), {
      invalidate: "surround",
    });
    return this.showReferencesPanel({ result, editor, marker });
  }

  showReferencesPanel({ result, editor, marker }) {
    const panelToReuse = atom.workspace
      .getPaneItems()
      .find((item) => item instanceof ReferencesView && item.overridable);
    const uri = panelToReuse ? panelToReuse.uri : ReferencesView.nextUri();

    // The view may not exist yet, so store context values it can pick up when
    // it instantiates.
    ReferencesView.setReferences(uri, {
      manager: this,
      editor,
      marker,
      references: result.references,
      symbolName: result.symbolName,
    });

    // A reused panel picks up the changes and re-renders; just bring it to
    // the front.
    if (panelToReuse) {
      const pane = atom.workspace.paneForItem(panelToReuse);
      pane?.activateItem(panelToReuse);
      return;
    }

    const split = this.splitDirection === "none" ? undefined : this.splitDirection;
    return atom.workspace.open(uri, { searchAllPanes: true, split });
  }

  // UTIL

  getCursorPositionForEditor(editor) {
    const cursors = editor.getCursors();
    if (cursors.length > 1) return null;
    return cursors[0].getBufferPosition();
  }

  getVisibleEditors() {
    const editors = [];
    for (const pane of atom.workspace.getPanes()) {
      const item = pane.getActiveItem();
      if (atom.workspace.isTextEditor(item)) editors.push(item);
    }
    return editors;
  }

  showProviderError(error) {
    if (this.errorNotification && !this.errorNotification.isDismissed()) return;
    this.errorNotification = atom.notifications.addError(
      "find-references: the reference request failed",
      {
        detail: error?.message ?? String(error),
        dismissable: true,
      },
    );
  }
};
