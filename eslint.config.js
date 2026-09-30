const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
// Local JSX rules keep each file's factory explicit and count JSX references
// for no-unused-vars without depending on a particular UI library.
const jsxPragmas = new WeakMap();
function readJSXPragmas(sourceCode) {
  if (!jsxPragmas.has(sourceCode)) {
    const pragmas = {};
    for (const comment of sourceCode.getAllComments()) {
      // Match Babel's annotation syntax and let the last annotation win.
      const factory = /^\s*(?:\*\s*)?@jsx\s+(\S+)\s*$/m.exec(comment.value);
      const fragment = /^\s*(?:\*\s*)?@jsxFrag\s+(\S+)\s*$/m.exec(comment.value);
      if (factory) pragmas.factory = factory[1];
      if (fragment) pragmas.fragment = fragment[1];
    }
    jsxPragmas.set(sourceCode, pragmas);
  }
  return jsxPragmas.get(sourceCode);
}

const jsx = {
  rules: {
    "require-pragma": {
      meta: {
        type: "problem",
        schema: [],
        messages: { missing: "This file contains JSX but declares no `/** @jsx ... */` pragma." },
      },
      create({ sourceCode, report }) {
        const { factory } = readJSXPragmas(sourceCode);
        let reported = false;
        function check(node) {
          if (factory || reported) return;
          reported = true;
          report({ node, messageId: "missing" });
        }
        return { JSXOpeningElement: check, JSXOpeningFragment: check };
      },
    },
    "jsx-uses": {
      meta: { type: "problem", schema: [] },
      create({ sourceCode }) {
        const { factory, fragment } = readJSXPragmas(sourceCode);
        function mark(expression, node) {
          if (expression) sourceCode.markVariableAsUsed(expression.split(".")[0], node);
        }
        return {
          JSXOpeningElement(node) {
            mark(factory, node);
            // Plain lowercase tags are strings; a member tag still references
            // its root even when that root starts with a lowercase letter.
            if (node.name.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)) return;
            let root = node.name;
            while (root.type === "JSXMemberExpression") root = root.object;
            if (root.type === "JSXIdentifier") sourceCode.markVariableAsUsed(root.name, root);
          },
          JSXOpeningFragment(node) {
            mark(factory, node);
            // A fragment type is separate from the factory that receives it.
            // Compiler defaults are outside this rule's explicit-pragma scope.
            mark(fragment, node);
          },
        };
      },
    },
  },
};

// Modules provided by the Lumine/Electron runtime rather than this package's own
// manifest, so they aren't resolvable by eslint-plugin-n.
const runtimeModules = ["lumine"];

module.exports = [
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    // Flat config lints only .js/.mjs/.cjs by default, so .jsx must be named
    // or the views drop out of `eslint .` without failing it.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    settings: {
      // This runs inside the editor's bundled Node 24 runtime, so lint
      // syntax/builtins against that rather than the package's `engines`.
      // tryExtensions lets extensionless requires resolve .jsx files.
      n: {
        version: ">=24.0.0",
        tryExtensions: [".js", ".jsx", ".json", ".node", ".mjs", ".cjs"],
      },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      // references-view.jsx authors its panel in JSX.
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "readonly",
      },
    },
    plugins: { jsx },
    rules: {
      // Each file names its own JSX factory in a `/** @jsx ... */` pragma:
      // `require-pragma` insists on it, and `jsx-uses` reads it from there
      // rather than from a default that lives in another repository.
      "jsx/require-pragma": "error",
      "jsx/jsx-uses": "error",
      "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
    },
  },
  {
    // The lint configuration itself requires devDependencies; it never ships.
    files: ["eslint.config.js"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Jasmine specs run in the editor's test runner with its fake-clock helper.
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
        advanceClock: "readonly",
        // Waiting primitives injected onto `window` by the editor's spec harness.
        conditionPromise: "readonly",
        emitterEventPromise: "readonly",
        flushMicrotasks: "readonly",
        timeoutPromise: "readonly",
        waitForFrames: "readonly",
      },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off any lint rules that would conflict with Prettier.
  prettier,
];
