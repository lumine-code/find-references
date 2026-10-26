const { CompositeDisposable } = require("lumine");

// One source invocation owns its waits, including providers that ignore cancellation.
module.exports = class SourceRequest {
  constructor(editor, owner) {
    this.editor = editor;
    this.owner = owner;
    this.buffer = editor.getBuffer();
    this.mode = this.buffer.getLanguageMode();
    this.grammar = editor.getGrammar();
    this.path = editor.getPath();
    this.revision = this.buffer.getTextRevision();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    const cancel = () => this.controller.abort();
    this.cancelled = new Promise((resolve) =>
      this.signal.addEventListener("abort", () => resolve(null), { once: true }),
    );
    this.subscriptions = new CompositeDisposable(
      this.buffer.onDidChangeLanguageMode(cancel),
      this.buffer.onDidChangeText(cancel),
      editor.onDidChangeGrammar(cancel),
      editor.onDidChangePath(cancel),
      editor.onDidDestroy(cancel),
    );
    owner.add(this);
  }

  matchesSource() {
    const { editor, buffer } = this;
    return (
      !this.owner.disposed &&
      !editor.isDestroyed() &&
      editor.getBuffer() === buffer &&
      buffer.getLanguageMode() === this.mode &&
      buffer.getTextRevision() === this.revision &&
      editor.getGrammar() === this.grammar &&
      editor.getGrammar() !== lumine.grammars.nullGrammar &&
      editor.getPath() === this.path
    );
  }

  current() {
    return !this.signal.aborted && this.matchesSource();
  }

  wait(value) {
    return Promise.race([value, this.cancelled]);
  }

  dispose() {
    this.controller.abort();
    this.subscriptions.dispose();
    this.owner.remove(this);
  }
};
