module.exports = class ViewLoader {
  importView() {
    return import("./references-view.jsx");
  }

  load() {
    this.pending ??= Promise.resolve()
      .then(() => this.importView())
      .then((namespace) => namespace.default ?? namespace)
      .catch((error) => {
        this.pending = null;
        throw error;
      });
    return this.pending;
  }
};
