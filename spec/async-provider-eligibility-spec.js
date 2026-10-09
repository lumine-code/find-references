const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Reference provider eligibility", () => {
  let main, editor, root, previousPaths, leases;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    lumine.config.set("find-references.autoHighlight", false);
    lumine.config.set("find-references.skipCurrentReference", false);
    previousPaths = lumine.project.getPaths();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "references-eligibility-"));
    fs.writeFileSync(path.join(root, "source.txt"), "one two\n");
    lumine.project.setPaths([root]);
    leases = [];
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    editor = await lumine.workspace.open(path.join(root, "source.txt"));
    editor.setCursorBufferPosition([0, 1]);
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    if (lumine.packages.isPackageActive("find-references"))
      await lumine.packages.deactivatePackage("find-references");
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    editor?.destroy();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    for (const setting of ["autoHighlight", "skipCurrentReference"])
      lumine.config.unset(`find-references.${setting}`);
    const temporary = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(temporary, target);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Fixture cleanup escaped the private temporary directory.");
    fs.unlinkSync(path.join(target, "source.txt"));
    fs.rmdirSync(target);
    main = editor = root = leases = null;
  });

  function provide(supported, range) {
    const find = jasmine.createSpy("find references").and.callFake(async () => ({
      symbolName: "owned symbol",
      references: [{ path: editor.getPath(), range }],
    }));
    leases.push(
      lumine.packages.serviceHub.provide("find-references.provider", "1.0.0", {
        isEditorSupported: supported,
        findReferences: find,
      }),
    );
    return find;
  }

  it("skips an asynchronously unsupported provider and highlights the next eligible result", async () => {
    const unsupported = provide(
      async () => false,
      [
        [0, 4],
        [0, 7],
      ],
    );
    const supported = provide(
      async () => true,
      [
        [0, 0],
        [0, 3],
      ],
    );
    await main.manager.requestReferencesUnderCursor(true);
    expect(unsupported).not.toHaveBeenCalled();
    expect(supported.calls.count()).toBe(1);
    expect(
      main
        .provideFindReferencesMarkers()
        .getMarkersForEditor(editor)
        .map((marker) => marker.getBufferRange().serialize()),
    ).toEqual([
      [
        [0, 0],
        [0, 3],
      ],
    ]);
  });

  it("retains first-match order for synchronous eligible providers", async () => {
    const first = provide(
      () => true,
      [
        [0, 0],
        [0, 3],
      ],
    );
    const second = provide(
      () => true,
      [
        [0, 4],
        [0, 7],
      ],
    );
    await main.manager.requestReferencesUnderCursor(true);
    expect(first.calls.count()).toBe(1);
    expect(second).not.toHaveBeenCalled();
  });
});
