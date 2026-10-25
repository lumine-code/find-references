const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const removeTemporaryDirectory = require("./helpers/temporary-directory");

beforeEach(() => {
  for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
    if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
  if (!jasmine.isSpy(lumine.application.openWindow))
    spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("Reference command editor targets", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, first, second, scratch, temporary, lease, calls;
  beforeEach(async () => {
    jasmine.useRealClock();
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    temporary = fs.realpathSync.native(os.tmpdir());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "reference-targets-")));
    for (const name of ["first.txt", "second.txt"])
      fs.writeFileSync(path.join(scratch, name), "symbol\n");
    lumine.project.setPaths([scratch]);
    lumine.config.set("find-references.autoHighlight", false);
    lumine.config.set("find-references.skipCurrentReference", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open(path.join(scratch, "first.txt"));
    const pane = lumine.workspace.paneForItem(first);
    pane.splitRight();
    second = await lumine.workspace.open(path.join(scratch, "second.txt"));
    pane.activate();
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    calls = jasmine.createSpy("lookup command editor").and.callFake(async (editor) => ({
      symbolName: path.basename(editor.getPath()),
      references: [
        {
          path: editor.getPath(),
          range: [
            [0, 0],
            [0, 6],
          ],
        },
      ],
    }));
    lease = lumine.packages.serviceHub.provide("find-references.provider", "1.0.0", {
      isEditorSupported: () => true,
      findReferences: calls,
    });
  });
  afterEach(async () => {
    lease?.dispose();
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    first?.destroy();
    second?.destroy();
    lumine.project.setPaths([]);
    await removeTemporaryDirectory(scratch);
  });
  for (const command of ["highlight", "show-panel"]) {
    it(`requests ${command} from its inactive split editor`, async () => {
      expect(lumine.workspace.getActiveTextEditor()).toBe(first);
      await lumine.commands.dispatch(second.getElement(), "find-references:" + command);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.calls.mostRecent().args[0]).toBe(second);
      if (command === "highlight") {
        const marks = main.provideFindReferencesMarkers();
        expect(marks.getMarkersForEditor(second).length).toBe(1);
        expect(marks.getMarkersForEditor(first).length).toBe(0);
      } else {
        const panels = lumine.workspace
          .getPaneItems()
          .filter((item) => item.getURI?.()?.startsWith("lumine://find-references/results"));
        expect(panels.length).toBe(1);
        expect(panels[0].editor).toBe(second);
        expect(panels[0].getTitle()).toBe("References: second.txt");
      }
    });
  }
  it("keeps the ordinary active editor lookup and actual marker", async () => {
    await lumine.commands.dispatch(first.getElement(), "find-references:highlight");
    expect(calls.calls.mostRecent().args[0]).toBe(first);
    expect(main.provideFindReferencesMarkers().getMarkersForEditor(first).length).toBe(1);
  });
  it("does not borrow an editor from an unrelated focused surface", async () => {
    const button = document.createElement("button");
    lumine.workspace.getElement().appendChild(button);
    try {
      button.focus();
      await lumine.commands.dispatch(button, "find-references:show-panel");
      expect(calls).not.toHaveBeenCalled();
      expect(lumine.commands.canDispatch(button, "find-references:show-panel")).toBe(false);
    } finally {
      button.remove();
    }
  });
  it("explains when the active file has no reference provider", async () => {
    lease.dispose();
    spyOn(lumine.notifications, "addWarning");
    await lumine.commands.dispatch(first.element, "find-references:show-panel");
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "No reference provider is available for this file.",
    );
    expect(calls).not.toHaveBeenCalled();
  });
  it("explains why finding references with multiple cursors cannot proceed", async () => {
    first.addCursorAtBufferPosition([0, 3]);
    spyOn(lumine.notifications, "addWarning");
    await lumine.commands.dispatch(first.element, "find-references:show-panel");
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Finding references requires a single cursor.",
    );
    expect(calls).not.toHaveBeenCalled();
  });
});
