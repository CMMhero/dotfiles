/// <reference path="./types/fresh.d.ts" />
// Enable vi mode at startup. Without this, vi is off until you toggle it
// from the command palette.
//
// `plugins_loaded` fires once the bundled vi-mode plugin has registered its
// API. The optional-call guard keeps a startup failure from taking the whole
// plugin runtime down if the plugin id ever changes.
editor.on("plugins_loaded", () => {
  editor.getPluginApi("vi-mode")?.enable();
});
