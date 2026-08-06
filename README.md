# find-references

Highlight and list references to the symbol under the cursor.

References come from provider packages — typically language-server backends — and are shown as highlight decorations in every visible editor and as a dockable results panel.

## Features

- **Auto highlight**: highlights every reference to the symbol under the cursor once the cursor rests for a configurable delay.
- **Results panel**: lists references grouped by file with line previews; a click jumps straight to the reference.
- **Live results**: the panel tracks its position through edits and refreshes whenever a referenced buffer changes.
- **Panel reuse**: a new lookup reuses the previous panel unless its results are pinned.
- **Noise guard**: skips highlighting when a provider reports an outsized share of the buffer lines, e.g. for a mundane token.
- **Scrollbar markers**: reports the highlighted occurrences through the find-references.markers service, so the companion marker-references package can mark them on the scrollbar and the minimap.

## Installation

To install `find-references` search for _find-references_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/find-references`.

## Commands

Commands available in `atom-text-editor`:

- `find-references:highlight`: highlight references to the symbol under the cursor,
- `find-references:show-panel`: list references to the symbol under the cursor in a results panel.

## Customization

The highlight can be adjusted in the `styles.css` file, e.g. change the occurrence color:

```css
atom-text-editor .highlight.find-references-reference .region {
  background-color: color-mix(in srgb, var(--text-color-info) 25%, transparent);
}
```

## Services

- **[find-references.provider](docs/find-references.provider.md)** (`^1.0.0`): consumed to request the references to a symbol from providers such as IDE backend packages.
- **[find-references.markers](docs/find-references.markers.md)** (`1.0.0`): provided to report the reference occurrence markers currently highlighted in each editor, e.g. to the marker-references layer.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
