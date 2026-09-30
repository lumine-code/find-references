const { CompositeDisposable, Disposable, Emitter, Range } = require("lumine");
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
    this.highlightRequestId = 0;
    this.disposed = false;
    this.onCursorMove = this.onCursorMove.bind(this);

    this.subscriptions.add(
      lumine.workspace.addOpener((uri) => {
        if (uri.startsWith(ReferencesView.URI) && ReferencesView.hasContext(uri)) {
          return new ReferencesView(uri);
        }
      }),
      lumine.workspace.observeActiveTextEditor((editor) => {
        this.updateCurrentEditor(editor ?? null);
      }),
      lumine.commands.add("lumine-text-editor:not([mini])", {
        "find-references:highlight": {
          description: "Mark every reference to the symbol under the cursor.",
          didDispatch: () => this.requestReferencesUnderCursor(true),
        },
        "find-references:show-panel": {
          description: "List every reference to the symbol under the cursor in a panel.",
          didDispatch: () => this.requestReferencesForPanel(),
        },
      }),
      lumine.config.observe("find-references.autoHighlight", (value) => {
        const previous = this.autoHighlight;
        this.autoHighlight = value;
        if (previous !== undefined && previous !== value) this.onCursorMove();
      }),
      lumine.config.observe("find-references.delay", (value) => {
        this.delay = value;
      }),
      lumine.config.observe("find-references.skipCurrentReference", (value) => {
        this.skipCurrentReference = value;
      }),
      lumine.config.observe("find-references.ignoreThreshold", (value) => {
        this.ignoreThreshold = value;
      }),
      lumine.config.observe("find-references.splitDirection", (value) => {
        this.splitDirection = value;
      }),
    );
  }

  dispose() {
    this.disposed = true;
    this.highlightRequestId++;
    clearTimeout(this.cursorMoveTimer);
    clearTimeout(this.typingTimer);
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    for (const item of lumine.workspace.getPaneItems()) {
      if (item instanceof ReferencesView) {
        lumine.workspace.paneForItem(item)?.destroyItem(item, true);
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

    clearTimeout(this.cursorMoveTimer);
    clearTimeout(this.typingTimer);
    this.highlightRequestId++;
    this.isTyping = false;
    this.editorSubscriptions?.dispose();
    this.editorSubscriptions = null;
    this.editor = null;

    if (!editor || !lumine.workspace.isTextEditor(editor)) {
      this.clearAllHighlights();
      return;
    }

    this.editor = editor;
    this.editorSubscriptions = new CompositeDisposable(
      editor.onDidChangeCursorPosition(this.onCursorMove),
      editor.onDidAddCursor(this.onCursorMove),
      editor.onDidRemoveCursor(this.onCursorMove),
      editor.getBuffer().onDidChange(() => {
        this.isTyping = true;
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => {
          this.isTyping = false;
        }, TYPING_DELAY);
        this.clearAllHighlights();
        this.onCursorMove();
      }),
    );
    this.onCursorMove();
  }

  onCursorMove() {
    clearTimeout(this.cursorMoveTimer);
    this.highlightRequestId++;

    if (
      !this.autoHighlight ||
      !this.editor ||
      this.editor.isDestroyed() ||
      !this.getCursorPositionForEditor(this.editor)
    ) {
      this.clearAllHighlights();
      return;
    }

    // Keep the previous result visible while the next lookup is debounced and
    // in flight. Moving within one reference should not make it blink.
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
  async findReferencesAtPosition(editor, position, { forHighlight = false } = {}) {
    if (!forHighlight) {
      // Panel lookups and refreshes share the provider's cancellation channel
      // with automatic highlights. An abandoned highlight reply must not clear
      // the previous result while the panel is fetching its own references.
      this.highlightRequestId++;
    }
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
    clearTimeout(this.cursorMoveTimer);
    const editor = this.editor;
    if (!editor || editor.isDestroyed()) return;
    const position = this.getCursorPositionForEditor(editor);
    if (!position) return;
    if (!force && !this.autoHighlight) return;
    const requestId = ++this.highlightRequestId;
    const result = await this.findReferencesAtPosition(editor, position, { forHighlight: true });
    if (
      this.disposed ||
      requestId !== this.highlightRequestId ||
      editor !== this.editor ||
      editor.isDestroyed() ||
      !position.isEqual(this.getCursorPositionForEditor(editor))
    )
      return;
    if (!result) {
      this.clearAllHighlights();
      return;
    }
    this.highlightReferencesInVisibleEditors(result.references, force);
  }

  highlightReferencesInVisibleEditors(references, force) {
    const referencesByPath = new Map();
    for (const reference of references) {
      let list = referencesByPath.get(reference.path);
      if (!list) referencesByPath.set(reference.path, (list = []));
      list.push(reference);
    }
    const visibleEditors = new Set(this.getVisibleEditors());
    for (const editor of this.markerLayersForEditors.keys()) {
      if (!visibleEditors.has(editor)) this.clearHighlight(editor);
    }
    for (const editor of visibleEditors) {
      this.highlightReferences(editor, referencesByPath.get(editor.getPath()) ?? [], force);
    }
  }

  highlightReferences(editor, references, force) {
    const layer = this.getOrCreateMarkerLayerForEditor(editor);
    if (layer.isDestroyed()) return;
    const ranges = [];

    if (this.autoHighlight || force) {
      const cursorPosition = editor.getLastCursor().getBufferPosition();
      const seen = new Set();
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
      if (overloaded) ranges.length = 0;
    }

    const rangeKeys = new Set(ranges.map((range) => range.toString()));
    const markers = layer.getMarkers();
    if (
      markers.length === ranges.length &&
      markers.every((marker) => rangeKeys.has(marker.getBufferRange().toString()))
    )
      return;

    layer.clear();
    for (const range of ranges) layer.markBufferRange(range);
    this.emitter.emit("did-change-markers");
  }

  clearAllHighlights() {
    for (const editor of this.markerLayersForEditors.keys()) this.clearHighlight(editor);
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
    clearTimeout(this.cursorMoveTimer);
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
    const panelToReuse = lumine.workspace
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
      return lumine.workspace.open(panelToReuse);
    }

    const split = this.splitDirection === "none" ? undefined : this.splitDirection;
    return lumine.workspace.open(uri, { searchAllPanes: true, split });
  }

  // UTIL

  getCursorPositionForEditor(editor) {
    const cursors = editor.getCursors();
    if (cursors.length !== 1) return null;
    return cursors[0].getBufferPosition();
  }

  getVisibleEditors() {
    const editors = [];
    for (const pane of lumine.workspace.getPanes()) {
      const item = pane.getActiveItem();
      if (lumine.workspace.isTextEditor(item)) editors.push(item);
    }
    return editors;
  }

  showProviderError(error) {
    if (this.errorNotification && !this.errorNotification.isDismissed()) return;
    this.errorNotification = lumine.notifications.addError(
      "find-references: the reference request failed",
      {
        detail: error?.message ?? String(error),
        dismissable: true,
      },
    );
  }
};
