const { createExtensionAdapter } = require("./vscode-adapter.cjs");

function activate(context) {
  return createExtensionAdapter(require("vscode")).activate(context);
}

function deactivate() {}

module.exports = { activate, deactivate };