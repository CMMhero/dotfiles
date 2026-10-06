# Catppuccin Macchiato, matching the palette in wezterm/.wezterm.lua.
# fzf has no config file of its own, so the colours are injected into
# FZF_DEFAULT_OPTS by config.fish (which runs after this file).
#
# Placeholder names are fzf 0.74's own vocabulary: fg, fg+, hl, hl+, gutter,
# header, header-border, info, label, marker, pointer, preview, preview-border,
# prompt, query, scrollbar, border, spinner, separator. There is no
# "scrollbar-thumb" key; the scrollbar is styled as a whole.
#
# NOTE: these must be REAL newlines, not backslash continuations. fzf parses
# FZF_DEFAULT_OPTS as a whitespace-separated string; a literal "\" would be
# passed through as a token and fzf exits with "unknown option: \".
#
# Opaque background: `bg` is set to crust and `bg+` to surface0, so the Ctrl-T /
# Alt-C popups read as a solid panel rather than showing the terminal through.
# (An earlier revision omitted `bg` for terminal transparency, which was tried
# against wezterm's window_background_opacity = 0.75 and reverted.)
#
set -gx FZF_CATPPUCCIN_OPTS '--height 50%
--layout=default
--border=rounded
--color=fg:#cad3f5,bg:#181926,disabled:#6e738d
--color=fg+:#b7bdf8,bg+:#313244
--color=hl:#c6a0f6,bg+:#45475a,hl+:#f5bde6
--color=info:#a6da95,prompt:#c6a0f6,pointer:#c6a0f6
--color=marker:#f5bde6,spinner:#f5bde6,header:#89dceb
--color=header-border:#45475a,preview-border:#45475a
--color=border:#313244,label:#c6a0f6
--color=scrollbar:#6e738d,gutter:#181926,separator:#6e738d'