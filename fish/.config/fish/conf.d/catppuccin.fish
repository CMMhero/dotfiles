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
# TRANSPARENCY: no `bg`, `bg+`, or `gutter` is set on purpose. fzf has no
# transparency option -- it paints whatever background colour it is given, and
# 8-digit hex with alpha is rejected ("invalid color specification"). Omitting
# `bg` entirely leaves those cells unpainted, so the terminal's own background
# shows through. That is what makes the Ctrl-T / Alt-C popups translucent on a
# terminal with opacity set (wezterm uses window_background_opacity = 0.75).
# On a terminal without translucency this simply renders as the default
# background, which is the normal look anyway.
set -gx FZF_CATPPUCCIN_OPTS '--height 50%
--layout=default
--border=rounded
--color=fg:#cad3f5,disabled:#6e738d
--color=fg+:#b7bdf8
--color=hl:#c6a0f6,hl+:#f5bde6
--color=info:#a6da95,prompt:#c6a0f6,pointer:#c6a0f6
--color=marker:#f5bde6,spinner:#f5bde6,header:#89dceb
--color=header-border:#45475a,preview-border:#45475a
--color=border:#313244,label:#c6a0f6
--color=scrollbar:#6e738d,separator:#6e738d'