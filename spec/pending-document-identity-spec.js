const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const removeTemporaryDirectory = require("./helpers/temporary-directory");

describe("References for a pending document identity", () => {
  let main, editor, preview, scratch, temporary, lease, finish, started;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
    if (!jasmine.isSpy(lumine.application.openWindow))
      spyOn(lumine.application, "openWindow").and.resolveTo();
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    temporary = fs.realpathSync.native(os.tmpdir());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "reference-identity-")));
    for (const name of ["source.txt", "renamed.txt", "preview.txt"])
      fs.writeFileSync(path.join(scratch, name), "symbol\n");
    lumine.project.setPaths([scratch]);
    lumine.config.set("find-references.autoHighlight", false);
    lumine.config.set("find-references.skipCurrentReference", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open(path.join(scratch, "source.txt"));
    preview = await lumine.workspace.open(path.join(scratch, "preview.txt"), { split: "right" });
    lumine.workspace.paneForItem(editor).activate();
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    finish = null;
    started = false;
    lease = lumine.packages.serviceHub.provide("find-references.provider", "1.0.0", {
      isEditorSupported: () => true,
      findReferences: () => {
        started = true;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
  });
  afterEach(async () => {
    lease?.dispose();
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    editor?.destroy();
    preview?.destroy();
    lumine.project.setPaths([]);
    await removeTemporaryDirectory(scratch);
  });
  async function prepare(kind) {
    if (kind === "grammar") {
      await lumine.packages.activatePackage("language-javascript");
      editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
      expect(editor.getGrammar().scopeName).toBe("source.js");
    }
  }
  function change(kind) {
    if (kind === "path") editor.getBuffer().setPath(path.join(scratch, "renamed.txt"));
    else if (kind === "grammar") editor.setGrammar(lumine.grammars.nullGrammar);
    else editor.getBuffer().insert([0, 0], "changed ");
  }
  function panels() {
    return lumine.workspace
      .getPaneItems()
      .filter((item) => item.getURI?.()?.startsWith("lumine://find-references/results"));
  }
  async function resolve(command, mutation) {
    const pending = lumine.commands.dispatch(editor.getElement(), "find-references:" + command);
    await conditionPromise(() => started);
    mutation?.();
    finish({
      symbolName: "obsolete",
      references: [
        {
          path: preview.getPath(),
          range: [
            [0, 0],
            [0, 6],
          ],
        },
      ],
    });
    await pending;
  }
  for (const kind of ["path", "grammar"]) {
    it(`ignores a pending highlight after its ${kind} changes with the same cursor and text`, async () => {
      await prepare(kind);
      const text = editor.getText(),
        position = editor.getCursorBufferPosition().copy();
      await resolve("highlight", () => change(kind));
      expect(editor.getText()).toBe(text);
      expect(editor.getCursorBufferPosition()).toEqual(position);
      expect(main.provideFindReferencesMarkers().getMarkersForEditor(preview).length).toBe(0);
    });
  }
  for (const kind of ["path", "grammar", "text"]) {
    it(`does not open a stale panel after its ${kind} changes while the provider is pending`, async () => {
      await prepare(kind);
      await resolve("show-panel", () => change(kind));
      expect(panels().length).toBe(0);
    });
  }
  it("keeps a captured panel position when only the cursor moves", async () => {
    const original = editor.getCursorBufferPosition().copy();
    await resolve("show-panel", () => editor.setCursorBufferPosition([0, 4]));
    expect(panels().length).toBe(1);
    expect(panels()[0].marker.getBufferRange().start).toEqual(original);
    expect(panels()[0].getTitle()).toBe("References: obsolete");
  });
});
