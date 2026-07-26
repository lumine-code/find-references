# find-references.provider

Lists every occurrence of the symbol at a position.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | `provideFindReferences()` returning one provider                    |
| Consumed by | `consumeFindReferences(provider)` returning a `Disposable`          |
| Owner       | [`find-references`](https://github.com/lumine-code/find-references) |

A language server reaches this through an [`ide-client`](https://lumine-code.github.io/docs.html#services/ide-client) adapter. Implement it directly for a source that is not a language server.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "find-references.provider": {
      "versions": { "1.0.0": "provideFindReferences" }
    }
  }
}
```

## Contract

```ts
type FindReferencesProvider = {
  isEditorSupported(editor: TextEditor): boolean | Promise<boolean>;
  findReferences(editor: TextEditor, position: Point): Promise<ReferenceResult | null>;
};

type ReferenceResult = {
  symbolName?: string;
  references: Array<{
    path: string;
    range: Range | [[number, number], [number, number]];
  }>;
};
```

| Member                             | Description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `isEditorSupported(editor)`        | Required. Whether you can serve this editor at all.         |
| `findReferences(editor, position)` | Required. The occurrences, or `null` when you have nothing. |

Each reference needs an absolute `path` and a `range`. The range may be a `Range` or a point-pair array — it is normalized for you. `symbolName` is optional and labels the results panel.

## Minimal example

```js
module.exports = {
  provideFindReferences() {
    return {
      isEditorSupported: (editor) => editor.getGrammar()?.scopeName === "source.mylang",
      async findReferences(editor, position) {
        const symbol = symbolAt(editor, position);
        if (!symbol) return null;
        return {
          symbolName: symbol.name,
          references: (await findAll(symbol)).map((occurrence) => ({
            path: occurrence.path,
            range: occurrence.range,
          })),
        };
      },
    };
  },
};
```

## Behavior

Provider selection is **first-match by registration order**, not by priority: the first provider whose `isEditorSupported` answers truthily is used, and no other is consulted. There is no scoring here.

`isEditorSupported` is asked before every lookup, so keep it cheap — a grammar-scope comparison rather than a project scan.

Returning `null` means "nothing to show" and is quietly ignored. A **rejection** is different: it surfaces as a single dismissable error notification, so throw only when something genuinely went wrong.

Results drive both the references panel and the inline highlight of occurrences in the visible editors, so the ranges should be tight around the identifier rather than around the whole statement.

The highlighted markers are separately republished as [`find-references.markers`](find-references.markers.md) for scrollbar overviews to read.

## Teardown

`consumeFindReferences` returns a `Disposable` that removes the provider. Return it from your consumer method.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
