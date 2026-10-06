const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompositeDisposable, Icon } = require("lumine");
const etch = require("@lumine-code/etch");
let ReferencesView;

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so async provider/render chains settle without
// advancing the fake clock.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe("find-references", () => {
  let mainModule, editor, disposables, delay, tempDir, alphaPath, betaPath;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    disposables = new CompositeDisposable();
    lumine.notifications.clear();

    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "find-references-")));
    alphaPath = path.join(tempDir, "alpha.js");
    betaPath = path.join(tempDir, "beta.js");
    fs.writeFileSync(alphaPath, "hello world\nplain line\nhello again\n");
    fs.writeFileSync(betaPath, "// beta\nuse hello here\n");
    lumine.project.setPaths([tempDir]);

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    ReferencesView = require("../lib/references-view");
    delay = lumine.config.get("find-references.delay");

    editor = await lumine.workspace.open(alphaPath);
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("find-references");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("registers file commands only on non-mini editors", () => {
    const commands = lumine.commands.findCommands({ target: lumine.views.getView(editor) });
    expect(commands.some(({ name }) => name === "find-references:highlight")).toBe(true);
  });

  // A provider following the `find-references` service contract (see
  // ide's references provider): `grammarScopes` is a getter,
  // `isEditorSupported` is a cheap sync check, and `findReferences` resolves
  // to `{ symbolName, references }` with range-compatible arrays, or `null`.
  function addProvider(findReferences) {
    const provider = {
      name: "Reference Stub",
      packageName: "find-references-spec",
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      isEditorSupported: () => true,
      findReferences,
    };
    disposables.add(mainModule.consumeFindReferences(provider));
    return provider;
  }

  function makeResult() {
    return {
      symbolName: "hello",
      references: [
        {
          path: alphaPath,
          range: [
            [0, 0],
            [0, 5],
          ],
        },
        {
          path: alphaPath,
          range: [
            [2, 0],
            [2, 5],
          ],
        },
        {
          path: betaPath,
          range: [
            [1, 4],
            [1, 9],
          ],
          name: "hello",
        },
      ],
    };
  }

  describe("automatic highlighting", () => {
    it("highlights references after the cursor rests and reports them via find-references.markers", async () => {
      const findReferences = jasmine
        .createSpy("findReferences")
        .and.callFake(async () => makeResult());
      addProvider(findReferences);
      const marks = mainModule.provideFindReferencesMarkers();
      const changed = jasmine.createSpy("changed");
      disposables.add(marks.onDidChangeMarkers(changed));

      editor.setCursorBufferPosition([0, 2]);
      await microtasks();
      expect(findReferences).not.toHaveBeenCalled();

      advanceClock(delay - 1);
      await microtasks();
      expect(findReferences).not.toHaveBeenCalled();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);

      advanceClock(1);
      await microtasks();
      expect(findReferences).toHaveBeenCalled();
      const [calledEditor, point] = findReferences.calls.mostRecent().args;
      expect(calledEditor).toBe(editor);
      expect(point.isEqual([0, 2])).toBe(true);

      // The reference under the cursor is skipped by default, so only the
      // other in-file reference gets an occurrence marker; both service
      // surfaces report the change.
      const markers = marks.getMarkersForEditor(editor);
      expect(markers.length).toBe(1);
      expect(
        markers[0].getBufferRange().isEqual([
          [2, 0],
          [2, 5],
        ]),
      ).toBe(true);
      expect(changed).toHaveBeenCalled();

      // The markers carry a highlight layer decoration with the rebranded
      // class.
      const decoration = mainModule.manager.layerDecorationsForEditors.get(editor);
      expect(decoration.getProperties().type).toBe("highlight");
      expect(decoration.getProperties().class).toBe("find-references-reference");

      // Existing markers remain until the next lookup replaces them.
      changed.calls.reset();
      editor.setCursorBufferPosition([1, 0]);
      expect(marks.getMarkersForEditor(editor)).toEqual(markers);
      expect(changed).not.toHaveBeenCalled();
    });

    function addDeferredProvider() {
      const requests = [];
      const findReferences = jasmine
        .createSpy("findReferences")
        .and.callFake(() => new Promise((resolve) => requests.push(resolve)));
      addProvider(findReferences);
      return { requests, findReferences };
    }

    it("keeps the same markers while moving within a symbol and awaiting the next result", async () => {
      const { requests, findReferences } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();
      const changed = jasmine.createSpy("changed");
      disposables.add(marks.onDidChangeMarkers(changed));

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      const markers = marks.getMarkersForEditor(editor);
      expect(markers.length).toBe(1);
      changed.calls.reset();

      lumine.commands.dispatch(lumine.views.getView(editor), "core:move-right");
      expect(editor.getCursorBufferPosition().isEqual([0, 3])).toBe(true);
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
      expect(changed).not.toHaveBeenCalled();

      advanceClock(delay - 1);
      expect(findReferences.calls.count()).toBe(1);
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);

      advanceClock(1);
      expect(findReferences.calls.count()).toBe(2);
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
      expect(changed).not.toHaveBeenCalled();

      requests[1](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
      expect(changed).not.toHaveBeenCalled();
    });

    it("ignores an old result while the next cursor position is still debouncing", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      const markers = marks.getMarkersForEditor(editor);

      editor.setCursorBufferPosition([1, 0]);
      advanceClock(delay);
      editor.setCursorBufferPosition([1, 1]);
      requests[1](null);
      await microtasks();
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);

      advanceClock(delay);
      requests[2]({
        references: [
          {
            path: alphaPath,
            range: [
              [1, 6],
              [1, 10],
            ],
          },
        ],
      });
      await microtasks();
      expect(marks.getMarkersForEditor(editor).length).toBe(1);
      expect(
        marks
          .getMarkersForEditor(editor)[0]
          .getBufferRange()
          .isEqual([
            [1, 6],
            [1, 10],
          ]),
      ).toBe(true);
    });

    it("does not replace a newer result with an older response", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      editor.setCursorBufferPosition([1, 0]);
      advanceClock(delay);
      requests[1]({
        references: [
          {
            path: alphaPath,
            range: [
              [1, 6],
              [1, 10],
            ],
          },
        ],
      });
      await microtasks();
      const markers = marks.getMarkersForEditor(editor);
      expect(markers.length).toBe(1);

      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual(markers);
      expect(
        markers[0].getBufferRange().isEqual([
          [1, 6],
          [1, 10],
        ]),
      ).toBe(true);
    });

    for (const [name, result] of [
      ["null", null],
      ["empty", { references: [] }],
    ]) {
      it(`clears prior highlights in every editor when the latest result is ${name}`, async () => {
        const betaEditor = await lumine.workspace.open(betaPath, { split: "right" });
        lumine.workspace.paneForItem(editor).activate();
        const { requests } = addDeferredProvider();
        const marks = mainModule.provideFindReferencesMarkers();

        editor.setCursorBufferPosition([0, 2]);
        advanceClock(delay);
        requests[0](makeResult());
        await microtasks();
        expect(marks.getMarkersForEditor(editor).length).toBe(1);
        expect(marks.getMarkersForEditor(betaEditor).length).toBe(1);

        editor.setCursorBufferPosition([1, 0]);
        expect(marks.getMarkersForEditor(editor).length).toBe(1);
        expect(marks.getMarkersForEditor(betaEditor).length).toBe(1);
        advanceClock(delay);
        requests[1](result);
        await microtasks();
        expect(marks.getMarkersForEditor(editor)).toEqual([]);
        expect(marks.getMarkersForEditor(betaEditor)).toEqual([]);
        expect(lumine.notifications.getNotifications().length).toBe(0);
      });
    }

    it("clears highlights on edits and ignores the pre-edit response", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor).length).toBe(1);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      editor.getBuffer().insert([1, 0], "changed ");
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      requests[1](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
    });

    it("clears highlights when adding another cursor and ignores the pending response", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor).length).toBe(1);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      editor.addCursorAtBufferPosition([1, 0]);
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      requests[1](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
    });

    it("clears highlights when automatic highlighting is disabled and ignores pending results", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor).length).toBe(1);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      lumine.config.set("find-references.autoHighlight", false);
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      requests[1](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
    });

    it("ignores a result from the previously active editor", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      const betaEditor = await lumine.workspace.open(betaPath);
      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(betaEditor)).toEqual([]);
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
    });

    it("clears highlights when there is no active text editor and ignores pending results", async () => {
      const { requests } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor).length).toBe(1);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      mainModule.manager.updateCurrentEditor(null);
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      requests[1](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
    });

    it("ignores a result after the package has deactivated", async () => {
      const { requests } = addDeferredProvider();
      const manager = mainModule.manager;

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      await lumine.packages.deactivatePackage("find-references");
      requests[0](makeResult());
      await microtasks();
      expect(manager.getMarkersForEditor(editor)).toEqual([]);
      expect(manager.markerLayersForEditors.size).toBe(0);
    });

    it("keeps highlights when a panel request supersedes a pending highlight request", async () => {
      const { requests, findReferences } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      const markers = marks.getMarkersForEditor(editor);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      lumine.commands.dispatch(lumine.views.getView(editor), "find-references:show-panel");
      requests[1](null);
      await microtasks();
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
      requests[2](null);
      await microtasks();
      advanceClock(delay);
      expect(findReferences.calls.count()).toBe(3);
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);

      editor.setCursorBufferPosition([0, 4]);
      lumine.commands.dispatch(lumine.views.getView(editor), "find-references:show-panel");
      requests[3](null);
      await microtasks();
      advanceClock(delay);
      expect(findReferences.calls.count()).toBe(4);
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
    });

    it("keeps highlights when a panel refresh supersedes a pending highlight request", async () => {
      const { requests, findReferences } = addDeferredProvider();
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      requests[0](makeResult());
      await microtasks();
      const markers = marks.getMarkersForEditor(editor);

      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      const refresh = mainModule.manager.findReferencesAtPosition(
        editor,
        editor.getCursorBufferPosition(),
      );
      requests[1](null);
      await microtasks();
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
      requests[2](null);
      await refresh;

      editor.setCursorBufferPosition([0, 4]);
      const nextRefresh = mainModule.manager.findReferencesAtPosition(
        editor,
        editor.getCursorBufferPosition(),
      );
      requests[3](null);
      await nextRefresh;
      advanceClock(delay);
      expect(findReferences.calls.count()).toBe(5);
      requests[4](makeResult());
      await microtasks();
      expect(marks.getMarkersForEditor(editor)[0]).toBe(markers[0]);
    });

    it("highlights on command even when autoHighlight is disabled", async () => {
      lumine.config.set("find-references.autoHighlight", false);
      addProvider(async () => makeResult());
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([1, 2]);
      advanceClock(delay + 1);
      await microtasks();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);

      lumine.commands.dispatch(lumine.views.getView(editor), "find-references:highlight");
      await microtasks();
      // The cursor sits inside no reference, so both in-file references get
      // markers.
      expect(marks.getMarkersForEditor(editor).length).toBe(2);
    });

    it("does nothing when the provider resolves null", async () => {
      const findReferences = jasmine.createSpy("findReferences").and.resolveTo(null);
      addProvider(findReferences);
      const marks = mainModule.provideFindReferencesMarkers();

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      await microtasks();
      expect(findReferences).toHaveBeenCalled();
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      expect(lumine.notifications.getNotifications().length).toBe(0);
    });

    it("shows one dismissable error notification when the provider rejects", async () => {
      addProvider(async () => {
        throw new Error("no can do");
      });

      editor.setCursorBufferPosition([0, 2]);
      advanceClock(delay);
      await microtasks();
      let notifications = lumine.notifications.getNotifications();
      expect(notifications.length).toBe(1);
      expect(notifications[0].getType()).toBe("error");
      expect(notifications[0].isDismissable()).toBe(true);
      expect(notifications[0].getOptions().detail).toBe("no can do");

      // Repeated failures reuse the open notification instead of stacking.
      editor.setCursorBufferPosition([2, 2]);
      advanceClock(delay);
      await microtasks();
      expect(lumine.notifications.getNotifications().length).toBe(1);

      // Once dismissed, the next failure may raise a fresh one.
      notifications[0].dismiss();
      editor.setCursorBufferPosition([0, 3]);
      advanceClock(delay);
      await microtasks();
      expect(lumine.notifications.getNotifications().length).toBe(2);
    });
  });

  describe("the results panel", () => {
    beforeEach(async () => {
      addProvider(async () => makeResult());
      // Keep every referenced buffer open so the panel previews render without
      // hitting the disk.
      await lumine.workspace.open(betaPath);
      editor = await lumine.workspace.open(alphaPath);
      await microtasks();
    });

    function getPanel() {
      return lumine.workspace.getPaneItems().find((item) => item instanceof ReferencesView);
    }

    async function showPanel() {
      lumine.commands.dispatch(lumine.views.getView(editor), "find-references:show-panel");
      await microtasks();
      return getPanel();
    }

    it("renders grouped results and opens a reference on click", async () => {
      editor.setCursorBufferPosition([2, 2]);
      const panel = await showPanel();
      expect(panel).toBeDefined();
      expect(panel.getTitle()).toContain("hello");
      expect(panel.serialize).toBeUndefined();

      expect(panel.element.querySelectorAll("li.list-nested-item").length).toBe(2);
      const rows = Array.from(panel.element.querySelectorAll("li.match-row"));
      expect(rows.length).toBe(3);
      expect(panel.element.querySelector(".preview-count").textContent).toContain(
        "3 results found in 2 files",
      );
      expect(panel.element.querySelector(".reference-group-icon.icon-file-text")).toExist();
      disposables.add(
        lumine.icons.addProvider(
          {
            id: "find-references-spec",
            handles: ["path"],
            usesContext: true,
            iconFor(target) {
              return target.context === "find-references" ? Icon.classes(["icon-flame"]) : null;
            },
          },
          { priority: 100 },
        ),
      );
      expect(panel.element.querySelector(".reference-group-icon.icon-flame")).toExist();

      // Rows preview the buffer line with the matched segment highlighted.
      const alphaRow = rows.find((row) => row.dataset.filePath === alphaPath);
      expect(alphaRow.querySelector(".preview").textContent).toBe("hello world");
      expect(alphaRow.querySelector(".match").textContent).toBe("hello");

      // A click on a row jumps to the reference.
      const betaRow = rows.find((row) => row.dataset.filePath === betaPath);
      betaRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await microtasks();
      const active = lumine.workspace.getActiveTextEditor();
      expect(active.getPath()).toBe(betaPath);
      expect(
        active
          .getLastSelection()
          .getBufferRange()
          .isEqual([
            [1, 4],
            [1, 9],
          ]),
      ).toBe(true);
    });

    it("navigates with core commands and opens the selected row on confirm", async () => {
      editor.setCursorBufferPosition([0, 2]);
      const panel = await showPanel();

      // Down twice: past the first group header onto its first row.
      lumine.commands.dispatch(panel.element, "core:move-down");
      lumine.commands.dispatch(panel.element, "core:move-down");
      lumine.commands.dispatch(panel.element, "core:confirm");
      await microtasks();

      const active = lumine.workspace.getActiveTextEditor();
      expect(active.getPath()).toBe(alphaPath);
      expect(
        active
          .getLastSelection()
          .getBufferRange()
          .isEqual([
            [0, 0],
            [0, 5],
          ]),
      ).toBe(true);
    });

    it("brings a reusable results panel forward through the workspace", async () => {
      editor.setCursorBufferPosition([0, 2]);
      const panel = await showPanel();
      const editorPane = lumine.workspace.paneForItem(editor);
      editorPane.activateItem(editor);
      editorPane.activate();
      const open = spyOn(lumine.workspace, "open").and.callThrough();

      expect(await showPanel()).toBe(panel);
      expect(open).toHaveBeenCalledWith(panel);
    });

    it("filters core ignored names and refreshes the open panel when they change", async () => {
      jasmine.useRealClock();
      const previous = lumine.config.get("core.ignoredNames");
      try {
        lumine.config.set("core.ignoredNames", ["beta.js"]);
        editor.setCursorBufferPosition([0, 2]);
        const panel = await showPanel();

        expect(panel.element.querySelectorAll("li.list-nested-item").length).toBe(1);
        expect(panel.element.querySelectorAll("li.match-row").length).toBe(2);

        lumine.config.set("core.ignoredNames", []);
        await etch.getScheduler().getNextUpdatePromise();
        expect(panel.groupedReferences.size).toBe(2);
        expect(panel.element.querySelectorAll("li.list-nested-item").length).toBe(2);
        expect(panel.element.querySelectorAll("li.match-row").length).toBe(3);
      } finally {
        lumine.config.set("core.ignoredNames", previous);
      }
    });

    it("does not open a panel when the provider resolves null", async () => {
      disposables.dispose();
      disposables = new CompositeDisposable();
      addProvider(async () => null);
      editor.setCursorBufferPosition([0, 2]);
      const panel = await showPanel();
      expect(panel).toBeUndefined();
    });
  });
});
