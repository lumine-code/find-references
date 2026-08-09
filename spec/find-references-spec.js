const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompositeDisposable } = require("lumine");
const ReferencesView = require("../lib/references-view");

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

  // A provider following the `find-references` service contract (see
  // ide-client's references provider): `grammarScopes` is a getter,
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

      // Moving the cursor clears the highlight immediately.
      changed.calls.reset();
      editor.setCursorBufferPosition([1, 0]);
      expect(marks.getMarkersForEditor(editor)).toEqual([]);
      expect(changed).toHaveBeenCalled();
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

      expect(panel.element.querySelectorAll("li.list-nested-item").length).toBe(2);
      const rows = Array.from(panel.element.querySelectorAll("li.match-row"));
      expect(rows.length).toBe(3);
      expect(panel.element.querySelector(".preview-count").textContent).toContain(
        "3 results found in 2 files",
      );

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
