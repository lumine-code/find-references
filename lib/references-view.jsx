/** @jsx etch.dom */
const { CompositeDisposable, Emitter, TextBuffer } = require("lumine");
const etch = require("@lumine-code/etch");
const Path = require("path");

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// The display path of a reference: relative to its project root, with the root
// folder name prepended when the project has more than one root.
function displayPath(filePath) {
  const [projectPath, relativePath] = lumine.project.relativizePath(filePath);
  if (projectPath && lumine.project.getPaths().length > 1) {
    return Path.join(Path.basename(projectPath), relativePath);
  }
  return relativePath;
}

function descendsFrom(filePath, projectPath) {
  const prefix = projectPath.endsWith(Path.sep) ? projectPath : projectPath + Path.sep;
  return filePath.startsWith(prefix);
}

// Results open on the opposite side of the panel's own split so the panel and
// the source keep facing each other.
function getOppositeSplit(split) {
  return { left: "right", right: "left", up: "down", down: "up" }[split];
}

// One reference: the 1-based line number and a preview of the buffer line with
// the matched segment highlighted.
class ReferenceRowView {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
  }

  update(props) {
    this.props = props;
    return etch.update(this);
  }

  render() {
    const { reference, filePath, navigationIndex, isSelected, bufferCache } = this.props;
    const { range } = reference;
    const line = bufferCache.get(filePath)?.lineForRow(range.start.row) ?? "";
    let before = line;
    let middle = "";
    let after = "";
    if (range.start.row === range.end.row) {
      before = line.slice(0, range.start.column);
      middle = line.slice(range.start.column, range.end.column);
      after = line.slice(range.end.column);
    }
    return (
      <li
        className={`list-item match-row${isSelected ? " selected" : ""}`}
        dataset={{
          navigationIndex: String(navigationIndex),
          filePath,
          range: range.toString(),
        }}
      >
        <span className="line-number">{String(range.start.row + 1)}</span>
        <span className="preview">
          {before}
          <span className="match highlight-info">{middle}</span>
          {after}
        </span>
      </li>
    );
  }
}

// One file of the result set: a collapsable header row plus its references.
class ReferenceGroupView {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.updateIcon();
  }

  update(props) {
    this.props = props;
    return etch.update(this).then(() => this.updateIcon());
  }

  destroy() {
    this.iconDisposable?.dispose();
    return etch.destroy(this);
  }

  updateIcon() {
    this.iconDisposable?.dispose();
    const icon = this.element?.querySelector(".reference-group-icon");
    if (!icon) return;
    this.iconDisposable = lumine.icons.applyTo(
      icon,
      {
        path: this.props.filePath,
        context: "find-references",
        hints: { directory: false },
      },
      { setData: false },
    );
  }

  render() {
    const {
      filePath,
      references,
      navigationIndex,
      activeNavigationIndex,
      isCollapsed,
      bufferCache,
      indexToReferenceMap,
    } = this.props;
    for (let i = 0; i < references.length; i++) {
      indexToReferenceMap.set(navigationIndex + i + 1, references[i]);
    }
    const selected = navigationIndex === activeNavigationIndex ? " selected" : "";
    const collapsed = isCollapsed ? " collapsed" : "";
    return (
      <li className={`list-nested-item${selected}${collapsed}`}>
        <div
          className="list-item path-row"
          dataset={{ navigationIndex: String(navigationIndex), filePath }}
        >
          <span className="reference-group-icon" />
          <span className="path-name bright">{displayPath(filePath)}</span>
          <span className="path-match-number">
            ({pluralize(references.length, "match", "matches")})
          </span>
        </div>
        <ul className="list-tree">
          {references.map((reference, i) => (
            <ReferenceRowView
              reference={reference}
              filePath={filePath}
              navigationIndex={navigationIndex + i + 1}
              isSelected={navigationIndex + i + 1 === activeNavigationIndex}
              bufferCache={bufferCache}
            />
          ))}
        </ul>
      </li>
    );
  }
}

let nextPanelId = 1;

// The dockable results panel: references grouped by file, live-refreshed while
// the position that triggered them stays logically trackable.
module.exports = class ReferencesView {
  // Base URI; each instance appends `/1`, `/2`, … so lookups can open in
  // separate panels.
  static URI = "lumine://find-references/results";

  // Context values for panels that have not been instantiated yet.
  static pendingContexts = new Map();

  // Live instances by URI.
  static instances = new Map();

  static nextUri() {
    return `${ReferencesView.URI}/${nextPanelId++}`;
  }

  static hasContext(uri) {
    return ReferencesView.pendingContexts.has(uri);
  }

  static setReferences(uri, context) {
    const instance = ReferencesView.instances.get(uri);
    if (instance) {
      // The panel exists, so it updates directly; a fresh marker replaces the
      // tracked position.
      instance.trackMarker(context.marker);
      instance.editor = context.editor;
      instance.update(context);
    } else {
      // The panel will exist soon; store the context for its constructor.
      ReferencesView.pendingContexts.set(uri, context);
    }
  }

  constructor(uri) {
    const context = ReferencesView.pendingContexts.get(uri);
    ReferencesView.pendingContexts.delete(uri);
    if (!context) throw new Error(`No reference results for URI: ${uri}`);
    ReferencesView.instances.set(uri, this);

    this.uri = uri;
    this.manager = context.manager;
    this.editor = context.editor;
    this.references = context.references;
    this.symbolName = context.symbolName;

    this.destroyed = false;
    // Whether the next lookup may reuse this panel; toggled by the pin button.
    this.overridable = true;
    this.activeNavigationIndex = -1;
    this.lastNavigationIndex = -1;
    this.collapsedIndices = new Set();
    this.indexToReferenceMap = new Map();
    this.previewStyle = { fontFamily: "" };
    this.ignoredNames = null;
    this.splitDirection = "none";
    this.marker = null;
    this.markerSubscriptions = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();

    // These observers run synchronously on subscribe, so they must precede the
    // first grouping and render.
    this.subscriptions.add(
      lumine.config.observe("core.ignoredNames", () => {
        this.ignoredNames = lumine.project.compileIgnoredNames();
        if (!this.element) return;
        this.update({ references: this.references.slice() });
      }),
      lumine.config.observe("find-references.splitDirection", (value) => {
        this.splitDirection = value;
      }),
      lumine.config.observe("editor.fontFamily", (fontFamily) => {
        this.previewStyle = { fontFamily };
        if (this.element) etch.update(this);
      }),
    );

    this.filterAndGroupReferences();
    this.replaceBufferCache();

    etch.initialize(this);

    this.trackMarker(context.marker);
    this.subscriptions.add(
      // The panel refreshes in real time: when a buffer of the result set
      // stops changing, the lookup repeats at the tracked position.
      lumine.workspace.observeTextEditors((editor) => {
        const buffer = editor.getBuffer();
        if (this.cacheOwner.owned.delete(buffer) && !buffer.isDestroyed()) {
          // Core counts retains as editors when deciding save prompts. Once
          // adopted, this becomes a borrowed buffer rather than an extra hold.
          buffer.release();
        }
        this.subscriptions.add(
          editor.onDidStopChanging(() => {
            const path = editor.getPath();
            if (path && this.paths.has(path)) this.refresh();
          }),
        );
      }),
      lumine.commands.add(this.element, {
        "core:move-up": () => this.moveBy(-1),
        "core:move-down": () => this.moveBy(1),
        "core:move-left": () => this.collapseActive(true),
        "core:move-right": () => this.collapseActive(false),
        "core:move-to-top": () => this.moveTo(0),
        "core:move-to-bottom": () => this.moveTo(this.lastNavigationIndex),
        "core:confirm": (event) => {
          event.stopPropagation();
          this.confirmActive();
        },
        "core:copy": () => this.copyActiveLine(),
      }),
    );

    this.element.addEventListener("mousedown", (event) => this.handleClick(event));

    this.completeBufferCache();
  }

  // Follow a new position marker, releasing (and destroying) the previous one.
  trackMarker(marker) {
    if (marker === this.marker) return;
    this.markerSubscriptions?.dispose();
    if (this.marker && !this.marker.isDestroyed()) this.marker.destroy();
    this.marker = marker;
    this.markerSubscriptions = new CompositeDisposable(
      // Once the marker is invalidated, an edit has surrounded the position
      // that triggered this panel, so the results cannot refresh any more and
      // the panel closes.
      marker.onDidChange(() => {
        if (!marker.isValid()) this.close();
      }),
      marker.onDidDestroy(() => this.close()),
    );
  }

  async update({ references, symbolName }) {
    if (this.destroyed) return;
    let changed = false;
    if (references && references !== this.references) {
      this.references = references;
      this.filterAndGroupReferences();
      this.indexToReferenceMap.clear();
      this.collapsedIndices.clear();
      this.activeNavigationIndex = -1;
      this.replaceBufferCache();
      this.completeBufferCache();
      changed = true;
    }
    if (symbolName && symbolName !== this.symbolName) {
      this.symbolName = symbolName;
      this.emitter.emit("did-change-title");
      changed = true;
    }
    return changed ? etch.update(this) : Promise.resolve();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.retireBufferCache(this.cacheOwner);
    ReferencesView.instances.delete(this.uri);
    this.markerSubscriptions?.dispose();
    if (this.marker && !this.marker.isDestroyed()) this.marker.destroy();
    this.subscriptions.dispose();
    this.emitter.dispose();
    return etch.destroy(this);
  }

  close() {
    if (this.destroyed) return;
    const pane = lumine.workspace.paneForItem(this);
    if (pane) {
      pane.destroyItem(this, true);
    } else {
      this.destroy();
    }
  }

  // PANE ITEM PROTOCOL

  // Deliberately no serialize(): this result is valid only while its provider,
  // source editor, and tracked position marker are alive. "Keep results"
  // prevents reuse during this session; it does not turn the result into a
  // restorable snapshot.

  getTitle() {
    return `References: ${this.symbolName ?? "?"}`;
  }

  getIconName() {
    return "search";
  }

  getURI() {
    return this.uri;
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  // RESULT SET

  // Group the references by file, dropping everything outside the project or
  // inside ignored paths.
  filterAndGroupReferences() {
    const projectPaths = lumine.project.getPaths();
    const groups = new Map();
    const paths = new Set();
    for (const reference of this.references) {
      const { path } = reference;
      if (!path) continue;
      if (!projectPaths.some((projectPath) => descendsFrom(path, projectPath))) continue;
      if (this.isPathIgnored(path)) continue;
      paths.add(path);
      let group = groups.get(path);
      if (!group) groups.set(path, (group = []));
      group.push(reference);
    }
    this.groupedReferences = groups;
    this.paths = paths;
  }

  isPathIgnored(filePath) {
    const [projectPath, relativePath] = lumine.project.relativizePath(filePath);
    return Boolean(projectPath && relativePath && this.ignoredNames.matches(relativePath));
  }

  // Providers position references against the current project state, including
  // unsaved changes, so previews must reuse the buffers already open in the
  // workspace before loading anything from disk.
  buildOpenBufferCache() {
    const cache = new Map();
    for (const editor of lumine.workspace.getTextEditors()) {
      const path = editor.getPath();
      if (path && !cache.has(path)) cache.set(path, editor.getBuffer());
    }
    return cache;
  }

  replaceBufferCache() {
    const previous = this.cacheOwner;
    this.bufferCache = this.buildOpenBufferCache();
    this.cacheOwner = {
      cache: this.bufferCache,
      owned: new Set(),
      pending: new Map(),
      retired: false,
    };
    this.retireBufferCache(previous);
  }

  retireBufferCache(owner) {
    if (!owner || owner.retired) return;
    owner.retired = true;
    owner.cache.clear();
    owner.pending.clear();
    const buffers = [...owner.owned];
    owner.owned.clear();
    for (const buffer of buffers) {
      // A preview can become an editor's buffer. Release only our retain;
      // TextBuffer destroys itself when no holder remains.
      if (!buffer.isDestroyed()) buffer.release();
    }
  }

  isCurrentCache(owner) {
    return !this.destroyed && !owner.retired && this.cacheOwner === owner;
  }

  async loadPreviewBuffer(owner, filePath) {
    let buffer;
    let retained = false;
    try {
      buffer = await TextBuffer.load(filePath);
      if (buffer.isDestroyed()) return;
      buffer.retain();
      retained = true;
      if (!this.isCurrentCache(owner)) return;
      // The user may have opened this file while its disk preview was loading.
      // Their live buffer, including unsaved changes, takes precedence.
      const open = lumine.workspace
        .getTextEditors()
        .find((editor) => editor.getPath() === filePath);
      const borrowed = open?.getBuffer();
      if (borrowed && !borrowed.isDestroyed()) {
        owner.cache.set(filePath, borrowed);
      } else {
        if (!owner.owned.has(buffer)) {
          owner.owned.add(buffer);
          retained = false;
        }
        owner.cache.set(filePath, buffer);
      }
    } catch {
      // Unreadable file; its rows render without a preview.
    } finally {
      if (retained && !buffer.isDestroyed()) buffer.release();
    }
  }

  async completeBufferCache() {
    const owner = this.cacheOwner;
    if (!owner || !this.isCurrentCache(owner)) return;
    const missing = [...this.paths].filter((path) => !owner.cache.has(path));
    if (missing.length === 0) return;
    await Promise.all(
      missing.map((path) => {
        let pending = owner.pending.get(path);
        if (!pending) {
          pending = this.loadPreviewBuffer(owner, path).finally(() => owner.pending.delete(path));
          owner.pending.set(path, pending);
        }
        return pending;
      }),
    );
    if (this.isCurrentCache(owner)) await etch.update(this);
  }

  async refresh() {
    if (this.destroyed) return;
    const result = await this.manager.findReferencesAtPosition(
      this.editor,
      this.marker.getBufferRange().start,
    );
    if (!result || this.destroyed) return;
    await this.update(result);
  }

  // NAVIGATION

  elementAtIndex(index) {
    return this.element.querySelector(`[data-navigation-index="${index}"]`);
  }

  get activeElement() {
    if (this.activeNavigationIndex < 0) return null;
    return this.elementAtIndex(this.activeNavigationIndex);
  }

  // Move keyboard focus by `delta` visible results.
  moveBy(delta) {
    let index = this.activeNavigationIndex;
    for (;;) {
      index += delta;
      if (index < 0 || index > this.lastNavigationIndex) return;
      const element = this.elementAtIndex(index);
      // Rows of a collapsed group take no space and are skipped.
      if (element && element.clientHeight > 0) break;
    }
    this.moveTo(index);
  }

  moveTo(index) {
    if (index < 0 || this.lastNavigationIndex < 0) return;
    this.activeNavigationIndex = Math.min(index, this.lastNavigationIndex);
    etch.update(this).then(() => {
      this.activeElement?.scrollIntoViewIfNeeded?.();
    });
  }

  collapseActive(isCollapsed) {
    const element = this.activeElement;
    if (!element?.matches(".path-row")) return;
    this.setGroupCollapsed(this.activeNavigationIndex, isCollapsed);
  }

  setGroupCollapsed(navigationIndex, isCollapsed) {
    if (isCollapsed) {
      this.collapsedIndices.add(navigationIndex);
    } else {
      this.collapsedIndices.delete(navigationIndex);
    }
    return etch.update(this);
  }

  confirmActive() {
    const element = this.activeElement;
    if (!element) return;
    if (element.matches(".path-row")) {
      this.setGroupCollapsed(
        this.activeNavigationIndex,
        !this.collapsedIndices.has(this.activeNavigationIndex),
      );
      return;
    }
    this.openReference(element.dataset.filePath, element.dataset.range);
  }

  // Copy the buffer line of the focused reference.
  copyActiveLine() {
    const reference = this.indexToReferenceMap.get(this.activeNavigationIndex);
    if (!reference) return;
    const element = this.activeElement;
    if (!element || element.matches(".path-row")) return;
    const buffer = this.bufferCache.get(element.dataset.filePath);
    const text = buffer?.lineForRow(reference.range.start.row);
    if (text) lumine.clipboard.write(text);
  }

  handleClick(event) {
    const target = event.target?.closest?.("[data-navigation-index]");
    if (!target) return;
    const navigationIndex = Number(target.dataset.navigationIndex);
    if (target.matches(".path-row")) {
      this.setGroupCollapsed(navigationIndex, !this.collapsedIndices.has(navigationIndex));
    } else {
      this.openReference(target.dataset.filePath, target.dataset.range);
    }
    this.activeNavigationIndex = navigationIndex;
    etch.update(this);
    event.preventDefault();
  }

  // Bring the user to a reference, reusing an existing editor when possible.
  async openReference(filePath, rangeSpec) {
    const references = this.groupedReferences.get(filePath);
    if (!references) return;
    const reference = references.find((ref) => ref.range.toString() === rangeSpec) ?? references[0];
    const editor = await lumine.workspace.open(filePath, {
      pending: true,
      searchAllPanes: true,
      split: getOppositeSplit(this.splitDirection),
    });
    if (!lumine.workspace.isTextEditor(editor)) return;
    const { range } = reference;
    // Reveal the row of the result if it happens to be folded.
    editor.unfoldBufferRow(range.start.row);
    editor.getLastSelection().setBufferRange(range, { flash: true });
    editor.scrollToCursorPosition();
  }

  togglePinned() {
    this.overridable = !this.overridable;
    etch.update(this);
  }

  render() {
    let navigationIndex = 0;
    const groups = [];
    for (const [filePath, references] of this.groupedReferences) {
      groups.push(
        <ReferenceGroupView
          filePath={filePath}
          references={references}
          navigationIndex={navigationIndex}
          activeNavigationIndex={this.activeNavigationIndex}
          isCollapsed={this.collapsedIndices.has(navigationIndex)}
          bufferCache={this.bufferCache}
          indexToReferenceMap={this.indexToReferenceMap}
        />,
      );
      navigationIndex += references.length + 1;
    }
    this.lastNavigationIndex = navigationIndex - 1;

    let referenceCount = 0;
    for (const references of this.groupedReferences.values()) {
      referenceCount += references.length;
    }

    return (
      <div
        className={`find-references-pane pane-item${referenceCount === 0 ? " no-results" : ""}`}
        tabIndex={-1}
      >
        <div className="preview-header">
          <span className="preview-count inline-block">
            {pluralize(referenceCount, "result")} found in{" "}
            {pluralize(this.groupedReferences.size, "file")} for{" "}
            <span className="highlight-info">{this.symbolName ?? ""}</span>
          </span>
          <div
            className={`btn icon icon-pin${this.overridable ? "" : " selected"}`}
            on={{ click: () => this.togglePinned() }}
          >
            Keep results
          </div>
        </div>
        <div className="results-view focusable-panel" tabIndex={-1} style={this.previewStyle}>
          <ol className="list-tree has-collapsable-children">{groups}</ol>
        </div>
      </div>
    );
  }
};
