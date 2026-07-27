const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the pulsar-find-references -> find-references rebrand and the
// TypeScript/Less -> plain CommonJS/CSS modernization. The command prefix,
// config namespace, and package name all move to `find-references`; the custom
// canvas scrollbar overlay is dropped in favor of the scrollmap-references
// layer package, fed through the `find-references.markers` service.
describe("find-references package assets", () => {
  it("ships plain CommonJS with no build step or TypeScript leftovers", () => {
    expect(exists("lib/main.js")).toBe(true);
    expect(exists("tsconfig.json")).toBe(false);
    expect(exists("dist")).toBe(false);
    expect(exists("typings")).toBe(false);
    expect(fs.readdirSync(path.join(root, "lib")).every((file) => file.endsWith(".js"))).toBe(true);
  });

  it("drops the canvas scrollbar overlay in favor of scrollmap-references", () => {
    expect(exists("lib/elements")).toBe(false);
    expect(exists("lib/scroll-gutter.js")).toBe(false);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.configSchema.scrollbarDecoration).toBeUndefined();
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      const src = read(path.join("lib", file));
      expect(src).not.toContain("scroll-gutter");
      expect(src).not.toContain("ScrollGutter");
    }
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/find-references.css")).toBe(true);
    expect(exists("styles/find-references.less")).toBe(false);
    expect(exists("styles/pulsar-find-references.less")).toBe(false);
    const css = read("styles/find-references.css");
    expect(css).toContain(".find-references-pane");
    expect(css).toContain(".find-references-reference");
    expect(css).toContain("var(--");
    expect(css).not.toContain("pulsar");
    expect(css).not.toContain("@import");
    expect(css).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(|@[a-z-]+:/);
  });

  it("is named `find-references` and swaps the legacy dependencies for scoped ones", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("find-references");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/find-references");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/find-references/issues");
    expect(pkg.main).toBe("./lib/main");
    expect(pkg.dependencies["@lumine-code/etch"]).toBeDefined();
    expect(pkg.dependencies.picomatch).toBeDefined();
    expect(pkg.dependencies.minimatch).toBeUndefined();
    expect(pkg.dependencies.etch).toBeUndefined();
    expect(pkg.dependencies["fs-plus"]).toBeUndefined();
    expect(pkg.dependencies["atom-utils-plus"]).toBeUndefined();
    expect(pkg.dependencies.classnames).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeUndefined();
  });

  it("consumes find-references.provider and provides find-references.markers", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["find-references.provider"].versions["^1.0.0"]).toBe(
      "consumeFindReferences",
    );
    expect(pkg.providedServices["find-references.markers"].versions["1.0.0"]).toBe(
      "provideFindReferencesMarkers",
    );
    // The experimental upstream show-references service is dropped.
    expect(pkg.providedServices["show-references"]).toBeUndefined();
  });

  it("defines a flat config schema under the find-references namespace without order keys", () => {
    const pkg = JSON.parse(read("package.json"));
    const schema = pkg.configSchema;
    expect(Object.keys(schema).sort()).toEqual([
      "autoHighlight",
      "delay",
      "ignoreThreshold",
      "skipCurrentReference",
      "splitDirection",
    ]);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
      expect(entry.title).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.type).toBeDefined();
      // `default` must be the last key of every entry.
      const keys = Object.keys(entry);
      expect(keys[keys.length - 1]).toBe("default");
    }
  });

  it("keeps the README description in sync with package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# find-references");
    const sentence = lines.find((line, index) => index > 0 && line.trim().length > 0);
    expect(sentence).toBe(pkg.description);
  });

  it("has no leftover pulsar / atom-ide / dropped-dependency references in lib", () => {
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      if (!file.endsWith(".js")) continue;
      const src = read(path.join("lib", file));
      expect(src.toLowerCase()).not.toContain("pulsar");
      expect(src).not.toContain("atom-ide");
      expect(src).not.toContain("atom-utils");
      expect(src).not.toContain("classnames");
      expect(src).not.toContain("fs-plus");
      expect(src).not.toContain('require("etch")');
    }
  });
});
