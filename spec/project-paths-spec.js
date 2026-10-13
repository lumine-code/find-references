const Path = require("node:path");

describe("reference project containment", () => {
  let View;

  beforeEach(async () => {
    await lumine.packages.activatePackage("find-references");
    View = require("../lib/references-view");
  });

  function group(project, files) {
    spyOn(lumine.project, "getPaths").and.returnValue([project]);
    const view = {
      references: files.map((path) => ({ path })),
      isPathIgnored: () => false,
    };
    View.prototype.filterAndGroupReferences.call(view);
    return [...view.groupedReferences.keys()];
  }

  it("keeps descendants but excludes a sibling sharing the root name", () => {
    const root = Path.resolve("project");
    const file = Path.join(root, "src", "main.js");
    expect(group(root, [file, Path.join(root + "-other", "main.js")])).toEqual([file]);
  });

  it("accepts a Windows language-server path with different drive-letter casing", () => {
    if (process.platform !== "win32") return;
    const file = "c:\\projects\\signal\\main.ts";
    expect(group("C:\\projects\\signal", [file])).toEqual([file]);
  });

  it("retains case sensitivity on POSIX filesystems", () => {
    if (process.platform === "win32") return;
    expect(group("/projects/Signal", ["/projects/signal/main.ts"])).toEqual([]);
  });
});
