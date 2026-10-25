const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const removeTemporaryDirectory = require("./helpers/temporary-directory");

function deferred() {
  let resolve;
  const promise = new Promise((accept) => (resolve = accept));
  return { promise, resolve };
}

describe("Find References native results view", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, manager, editor, providerLease, directory;
  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("find-references"))
      await lumine.packages.unloadPackage("find-references");
    lumine.config.set("find-references.autoHighlight", false);
    lumine.config.set("find-references.skipCurrentReference", false);
    lumine.config.set("find-references.ignoreThreshold", 0);
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reference-view-import-"));
    const filePath = path.join(directory, "symbol.txt");
    fs.writeFileSync(filePath, "symbol\n");
    editor = await lumine.workspace.open(filePath);
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    manager = main.manager;
    providerLease = manager.addProvider({
      isEditorSupported: () => true,
      findReferences: async () => ({
        symbolName: "symbol",
        references: [
          {
            path: filePath,
            range: [
              [0, 0],
              [0, 6],
            ],
          },
        ],
      }),
    });
  });
  afterEach(async () => {
    providerLease.dispose();
    await lumine.packages.deactivatePackage("find-references");
    editor.destroy();
    await removeTemporaryDirectory(directory);
  });

  it("loads its bootstrap without the panel renderer or Etch", () => {
    const source = `
      const Module = require("node:module");
      const original = Module._load;
      Module._load = function(request, ...args) { return request === "lumine" ? {} : original.call(this, request, ...args); };
      const main = require("./lib/main");
      if (typeof main.provideFindReferencesMarkers !== "function") throw new Error("Missing service");
      console.log(JSON.stringify(Object.keys(require.cache).filter(file => {
        const normalized = file.replaceAll("\\\\", "/");
        return normalized.endsWith("/references-view.jsx") || normalized.includes("/node_modules/@lumine-code/etch/");
      })));
    `;
    const output = execFileSync(process.execPath, ["-e", source], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      encoding: "utf8",
    });
    expect(JSON.parse(output.trim())).toEqual([]);
  });

  it("highlights references without requesting the panel view", async () => {
    const loading = spyOn(manager, "loadView").and.callThrough();
    await manager.requestReferencesUnderCursor(true);
    expect(main.provideFindReferencesMarkers().getMarkersForEditor(editor).length).toBe(1);
    expect(loading).not.toHaveBeenCalled();
  });

  it("shares native JSX imports and keeps the CommonJS view constructor", async () => {
    const Loader = require("../lib/view-loader");
    const loader = new Loader();
    const imported = spyOn(loader, "importView").and.callThrough();
    const first = loader.load();
    expect(loader.load()).toBe(first);
    expect(await first).toBe(require("../lib/references-view"));
    expect(imported).toHaveBeenCalledTimes(1);
  });

  for (const retire of ["package", "provider", "document"]) {
    it(`releases pending origin markers and does not open a panel after its ${retire} retires during import`, async () => {
      const View = require("../lib/references-view");
      const importing = deferred();
      const started = deferred();
      spyOn(manager, "loadView").and.callFake(() => {
        started.resolve();
        return importing.promise;
      });
      const opening = spyOn(lumine.workspace, "open").and.callThrough();
      const pending = manager.requestReferencesForPanel();
      await started.promise;
      const marker = [...manager.pendingPanelMarkers][0];
      expect(marker.isDestroyed()).toBe(false);
      if (retire === "package") await lumine.packages.deactivatePackage("find-references");
      else if (retire === "provider") providerLease.dispose();
      else editor.insertText("changed");
      importing.resolve(View);
      await pending;
      expect(opening).not.toHaveBeenCalled();
      expect(marker.isDestroyed()).toBe(true);
      expect(manager.pendingPanelMarkers.size).toBe(0);
    });
  }

  it("cleans a failed view import and retries the next panel request", async () => {
    const nativeLoad = manager.loadView.bind(manager);
    const loading = spyOn(manager, "loadView").and.rejectWith(new Error("temporary view failure"));
    await manager.requestReferencesForPanel();
    expect(manager.pendingPanelMarkers.size).toBe(0);
    loading.and.callFake(nativeLoad);
    const panel = await manager.requestReferencesForPanel();
    expect(panel.constructor).toBe(require("../lib/references-view"));
    expect(panel.manager).toBe(manager);
  });
});
