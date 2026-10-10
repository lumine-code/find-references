describe("Reference results after their owner retires", () => {
  let main, editor, registration, pending, resolve, reject;

  beforeEach(async () => {
    for (const name of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("find-references.autoHighlight", false);
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("symbol\n");
    pending = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    registration = main.consumeFindReferences({
      isEditorSupported: () => true,
      findReferences: () => pending,
    });
  });

  afterEach(async () => {
    registration.dispose();
    if (lumine.packages.isPackageActive("find-references"))
      await lumine.packages.deactivatePackage("find-references");
    lumine.config.unset("find-references.autoHighlight");
  });

  function result() {
    return { symbolName: "symbol", references: [] };
  }

  function panels() {
    return lumine.workspace
      .getPaneItems()
      .filter((item) => item.getURI?.()?.startsWith("lumine://find-references/results"));
  }

  it("opens a real results panel while the provider and package are active", async () => {
    const request = main.manager.requestReferencesForPanel();
    resolve(result());
    await request;
    expect(panels().length).toBe(1);
    expect(panels()[0].getTitle()).toBe("References: symbol");
  });

  it("does not reopen results after the package deactivates", async () => {
    const manager = main.manager;
    const marker = spyOn(editor, "markBufferRange").and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const request = manager.requestReferencesForPanel();
    await lumine.packages.deactivatePackage("find-references");
    resolve(result());
    await request;
    expect(marker).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(panels().length).toBe(0);
  });

  it("does not use a reply from a provider whose registration was removed", async () => {
    const request = main.manager.requestReferencesForPanel();
    registration.dispose();
    resolve(result());
    await request;
    expect(panels().length).toBe(0);
  });

  it("does not try to track a closed source editor", async () => {
    const request = main.manager.requestReferencesForPanel();
    editor.destroy();
    resolve(result());
    await expectAsync(request).toBeResolved();
    expect(panels().length).toBe(0);
  });

  it("does not notify about a retired package request that later rejects", async () => {
    const request = main.manager.requestReferencesForPanel();
    await lumine.packages.deactivatePackage("find-references");
    const notify = spyOn(lumine.notifications, "addError").and.callThrough();
    reject(new Error("retired lookup"));
    await request;
    expect(notify).not.toHaveBeenCalled();
  });
});
