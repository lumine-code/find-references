# find-references.markers

Reports which reference occurrences are currently highlighted in each editor.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | `provideFindReferencesMarkers()` returning the query facade         |
| Consumed by | `consumeFindReferencesMarkers(service)`                             |
| Owner       | [`find-references`](https://github.com/lumine-code/find-references) |

The read-out side of the package: [`find-references.provider`](find-references.provider.md) supplies the occurrences, and this reports where they ended up so a scrollbar overview or a minimap can draw them.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "find-references.markers": {
      "versions": { "^1.0.0": "consumeFindReferencesMarkers" }
    }
  }
}
```

## Contract

```ts
type FindReferencesMarkers = {
  getMarkersForEditor(editor: TextEditor): DisplayMarker[];
  onDidChangeMarkers(callback: (editor: TextEditor) => void): Disposable;
};
```

| Member                         | Description                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `getMarkersForEditor(editor)`  | The markers currently highlighted in that editor. Empty when none are.                           |
| `onDidChangeMarkers(callback)` | Reports the editor whose native markers changed, including positions and validity after an edit. |

This is a deliberately narrow facade over the package's internal manager, so consumers cannot reach its state.

## Minimal example

```js
module.exports = {
  consumeFindReferencesMarkers(service) {
    this.references = service;
    this.layer?.update();
    return new Disposable(() => {
      this.references = null;
      this.layer?.update();
    });
  },

  rowsFor(editor) {
    return (this.references?.getMarkersForEditor(editor) ?? []).map(
      (marker) => marker.getStartScreenPosition().row,
    );
  },
};
```

## Behavior

`onDidChangeMarkers` receives the affected editor. Re-query that editor and skip markers for which `isValid()` returns `false`, matching native highlight decorations. Native position and validity changes report immediately; they do not trigger or wait for another reference request.

It also does not replay the current state on subscribe, so call `getMarkersForEditor` yourself for the initial value.

The markers are live `DisplayMarker`s owned by `find-references`. Read their positions when you need them, and **do not destroy them** — they are torn down when the highlight is cleared.

An editor with no active reference search returns an empty array rather than `null`.

## Teardown

Return a `Disposable` that unsubscribes and clears whatever you drew. Losing the service should visibly clear your markers, as in the example — otherwise a stale overlay outlives the highlight it was showing.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
