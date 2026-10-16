describe("find-references application menu document context", () => {
  let main, first, second, extra, button, cell, notebook, lease, lookup;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("find-references.autoHighlight", false);
    main = (await lumine.packages.activatePackage("find-references")).mainModule;
    first = await lumine.workspace.open();
    first.setText("first symbol");
    lookup = spyOn(main.manager, "findReferencesAtPosition").and.resolveTo(null);
  });
  afterEach(async () => {
    lease?.dispose();
    lease = null;
    await lumine.packages.deactivatePackage("find-references");
    button?.remove();
    button = null;
    if (notebook) {
      const pane = lumine.workspace.paneForItem(notebook);
      if (pane) await pane.destroyItem(notebook, true);
    }
    notebook = null;
    cell?.destroy();
    cell = null;
    await lumine.workspace.discardEditorWindows();
    first?.destroy();
  });
  it("requires editor focus and uses the invoking window's editor", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    second = lumine.workspace.buildTextEditor();
    second.setText("second symbol");
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    lumine.workspace.paneForItem(first).activate();
    button.focus();
    expect(lumine.workspace.resolveCommandContext(button).embeddedEditor).toBe(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await lumine.commands.dispatch(button, "find-references:show-panel");
    expect(lookup).not.toHaveBeenCalled();
    expect(lumine.commands.canDispatch(button, "find-references:show-panel")).toBe(false);
    await lumine.commands.dispatch(second.element, "find-references:show-panel");
    expect(lookup.calls.mostRecent().args[0]).toBe(second);
  });
  it("uses the embedded document editor when a notebook owns the active pane item", async () => {
    cell = lumine.workspace.buildTextEditor();
    cell.setText("notebook symbol");
    const element = document.createElement("div");
    notebook = {
      getTitle: () => "Notebook",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => cell,
      destroy: () => element.remove(),
    };
    lumine.workspace.getActivePane().activateItem(notebook, { activatePane: true });
    button = document.createElement("button");
    element.appendChild(button);
    button.focus();
    expect(lumine.workspace.getActiveTextEditor()).toBeUndefined();
    expect(lumine.workspace.resolveCommandContext(button).embeddedEditor).toBe(cell);
    await lumine.commands.dispatch(button, "find-references:show-panel");
    expect(lookup).not.toHaveBeenCalled();
    element.appendChild(cell.element);
    await lumine.commands.dispatch(cell.element, "find-references:show-panel");
    expect(lookup.calls.mostRecent().args[0]).toBe(cell);
  });
  it("does nothing in an empty auxiliary window while the main window still has an editor", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    lumine.workspace.paneForItem(first).activate();
    button.focus();
    const context = lumine.workspace.resolveCommandContext(button);
    expect(context.window).toBe(extra);
    expect(context.embeddedEditor).toBeUndefined();
    expect(context.editor).toBeUndefined();
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await lumine.commands.dispatch(button, "find-references:show-panel");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("retains the active-editor fallback for programmatic requests without command context", async () => {
    await main.manager.requestReferencesForPanel();
    expect(lookup.calls.mostRecent().args[0]).toBe(first);
  });
});
