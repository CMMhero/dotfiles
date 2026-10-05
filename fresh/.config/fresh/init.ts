/// <reference path="./types/fresh.d.ts" />
/// <reference path="./types/plugins.d.ts" />

// ---------------------------------------------------------------------------
// vi mode
// ---------------------------------------------------------------------------
// Enable vi mode at startup. Without this, vi is off until you toggle it
// from the command palette.
//
// `plugins_loaded` fires once the bundled vi-mode plugin has registered its
// API. The optional-call guard keeps a startup failure from taking the whole
// plugin runtime down if the plugin id ever changes.
editor.on("plugins_loaded", () => {
  const vi = editor.getPluginApi("vi-mode");
  vi?.enable();
  registerViToggle(vi);
});

// ---------------------------------------------------------------------------
// vi mode toggle command
// ---------------------------------------------------------------------------
// Adds "Toggle vi mode" to the command palette (Ctrl+P) so the mode can be
// flipped without restarting the editor. `registerHandler` puts the handler on
// the global scope under a stable name; `registerCommand` then binds it to a
// palette entry.
//
// The toggle is re-registered inside `plugins_loaded` because the vi-mode API
// only exists after that event, and the handler closes over the resolved API
// object rather than re-looking it up on every keystroke.
function registerViToggle(vi: ViModeApi | null) {
  if (!vi) return;

  registerHandler("dotfiles-toggle-vi-mode", () => {
    vi.toggle();
    const state = vi.isEnabled() ? "on" : "off";
    editor.setStatus(`vi mode ${state}`);
  });

  editor.registerCommand(
    "toggle-vi-mode",
    "Toggle vi mode (insert/normal)",
    "dotfiles-toggle-vi-mode",
  );
}
