-- Pull in the wezterm API
local wezterm = require "wezterm"

-- This table will hold the configuration.
local config = {}

-- In newer versions of wezterm, use the config_builder which will
-- help provide clearer error messages
if wezterm.config_builder then
  config = wezterm.config_builder()
end

config.wsl_domains = {
  {
    name = 'WSL:Ubuntu',
    distribution = 'Ubuntu',
    username = 'cmmhero',
    default_cwd = '/home/cmmhero',
    default_prog = { 'fish' },
  },
}

-- terminal configuration
config.default_prog = { "pwsh.exe", "-NoLogo" }
-- config.default_prog = { "nu.exe" }
-- config.default_domain = 'WSL:Ubuntu'

--[[
============================
Rendering
============================
]] --

config.front_end = 'WebGpu'

-- Acrylic forces the window onto a DWM-composited transparency path, which is
-- the setup behind wezterm#6111 (visual artifacts with
-- win32_system_backdrop = 'Acrylic' on Windows). WezTerm's docs also require
-- window_background_opacity = 0 for a backdrop; 0.75 + Acrylic was the
-- combination in play. Disabling the backdrop removes the conflict.
-- config.win32_system_backdrop = "Disable"

-- WezTerm's update-status event fires roughly every 100ms whether or not
-- anything changed, so the leader indicator below used to call set_left_status
-- that many times per second, forcing a full-window recomposite for identical
-- text. In a large scrollback that kept the compositor continuously busy.
-- The real fix for that is the status-cache guard on the handler below; the
-- frame rates stay at their previous values so scrolling keeps its normal
-- repaint cadence.
config.max_fps = 144
config.animation_fps = 144

--[[
============================
Custom Configuration
============================
]] --

-- Rounded or Square Style Tabs

-- change to square if you don't like rounded tab style
local tab_style = "square"

-- leader active indicator prefix
local leader_prefix = utf8.char(0x1f30a) -- ocean wave


--[[
============================
Font
============================
]] --

config.font =
  wezterm.font_with_fallback {
    { family = "GeistMono NFP" }
  }
config.font_size = 14

config.window_decorations = "RESIZE"
config.window_background_opacity = 0.75
config.win32_system_backdrop = "Acrylic"
-- win32_system_backdrop is set to "Disable" in the Rendering block above; it
-- must not be re-enabled here, or the Acrylic corruption returns.

-- Window behaviour
-- Close without the "are you sure" prompt (pane-per-tab workflow makes the
-- prompt mostly noise, and it fires on every accidental Cmd-W).
config.window_close_confirmation = "NeverPrompt"
-- Suppress the system beep on BEL. Default is "SystemBeep", which on Windows
-- triggers the alert sound; this pins it off. No visual bell is configured,
-- so BEL produces no visible signal either.
config.audible_bell = "Disabled"
-- Zooming changes rows/cols rather than resizing the window, so the grid and
-- any multiplexer layout stay put. Since 20230712 the default is nil, which
-- infers this from tiling_desktop_environments; Herdr is not on that list, so
-- pin it explicitly.
config.adjust_window_size_when_changing_font_size = false
-- Disable the `calt` (contextual alternates) OpenType feature. GeistMono
-- swaps glyphs via calt, which breaks ligature rendering in some terminals.
config.harfbuzz_features = { "calt=0" }

--[[
============================
Colors
============================
]] --

local color_scheme = "Catppuccin Macchiato"
config.color_scheme = color_scheme

-- color_scheme not sufficient in providing available colors
-- local colors = wezterm.color.get_builtin_schemes()[color_scheme]

-- color scheme colors for easy access
local scheme_colors = {
  catppuccin = {
    macchiato = {
      rosewater = "#f4dbd6",
      flamingo = "#f0c6c6",
      pink = "#f5bde6",
      mauve = "#c6a0f6",
      red = "#ed8796",
      maroon = "#ee99a0",
      peach = "#f5a97f",
      yellow = "#eed49f",
      green = "#a6da95",
      teal = "#8bd5ca",
      sky = "#91d7e3",
      sapphire = "#7dc4e4",
      blue = "#8aadf4",
      lavender = "#b7bdf8",
      text = "#cad3f5",
      crust = "#181926",
    }
  }
}

local colors = {
  border = scheme_colors.catppuccin.macchiato.lavender,
  tab_bar_active_tab_fg = scheme_colors.catppuccin.macchiato.mauve,
  tab_bar_active_tab_bg = scheme_colors.catppuccin.macchiato.crust,
  tab_bar_text = scheme_colors.catppuccin.macchiato.crust,
  arrow_foreground_leader = scheme_colors.catppuccin.macchiato.lavender,
  arrow_background_leader = scheme_colors.catppuccin.macchiato.crust,

  -- Pane / tab focus. surface0 is Catppuccin Macchiato's muted overlay
  -- ("inactive" surfaces); mauve is the accent, so the focused thing reads
  -- as lit and everything else recedes.
  surface0 = "#494d64",
  surface1 = "#5b6078",
  overlay0 = "#6e738d",
  subtext0 = "#a5adce",
  accent = scheme_colors.catppuccin.macchiato.mauve,
}

-- This build of WezTerm (20240203) has no `active_pane_hilite` /
-- `inactive_pane_hilite` keys — verified against the config struct: they are
-- silently dropped, so they cannot be used here. Focus is instead conveyed by
-- the three mechanisms below, which all exist in this version:
--   1. colors.split          — colour of the line between panes
--   2. window_frame          — per-pane border geometry/colour
--   3. inactive_pane_hsb     — dims + desaturates every non-focused pane
config.colors = {
  -- Split lines (the dividers between panes/tabs) use the muted surface so
  -- they read as background chrome rather than as content.
  split = colors.surface0,
}


--[[
============================
Border + pane focus
============================
]] --

-- Focus cue for splits, using only options this WezTerm build supports
-- (no active_pane_hilite here — see note above).
--
-- Note: window_frame draws a border around the *window area*, not around each
-- individual pane, so it frames the terminal as a whole rather than marking the
-- focused pane. Per-pane focus is conveyed by inactive_pane_hsb + colors.split
-- below. Widths accept forms like '0.5cell', '2px', or a plain number.
config.window_frame = {
  border_left_width = "5px",
  border_right_width = "5px",
  border_bottom_height = "5px",
  border_top_height = "5px",
  border_left_color = colors.accent,
  border_right_color = colors.accent,
  border_bottom_color = colors.accent,
  border_top_color = colors.accent,
}

-- The real per-pane focus cue. WezTerm's default is saturation 0.9 /
-- brightness 0.8, which is far too subtle to tell 3 splits apart; these values
-- push every unfocused pane well into the background so the focused one is
-- obvious at a glance.
config.inactive_pane_hsb = {
  saturation = 0.25,
  brightness = 0.25,
}

-- Scrollback. The default is 10000 lines, which scrolls off fast during long
-- builds or a big `git log`. 100k costs very little memory but keeps the whole
-- session searchable, which pairs with the ALT+q then f search binding below.
config.scrollback_lines = 100000

-- A thin scrollbar so you can see at a glance how far back in the buffer you
-- are (useful in short windows where the thumb is otherwise invisible).
config.enable_scroll_bar = false

-- Command palette. The default shows only 8 rows, so it needs scrolling for
-- most commands. 20 shows nearly all of them at once.
config.command_palette_rows = 20

config.default_cursor_style = "BlinkingBlock"
config.cursor_blink_rate = 500
config.cursor_blink_ease_in = "EaseIn"
config.cursor_blink_ease_out = "EaseOut"
-- Block cursors default to a thin 1px outline that is easy to lose against
-- bright output. 2px makes the caret clearly visible in a screenshot or on a
-- busy screen.
config.cursor_thickness = "2px"

-- Underline thickness/position. WezTerm defaults these to 1px/0 (right on the
-- baseline), which clips descenders and looks heavy; a 1pt underline lifted
-- slightly reads cleanly for underlined text and diffs.
config.underline_thickness = "1pt"
config.underline_position = "-1px"


--[[
============================
Shortcuts
============================
]] --

wezterm.on("copy-success", function(window, pane)
  window:set_right_status(wezterm.format {
    { Background = { Color = colors.accent } },
    { Foreground = { Color = colors.tab_bar_text } },
    { Text = " Copied to clipboard " },
  })

  wezterm.time.call_after(1.5, function()
    window:set_right_status("")
  end)
end)

-- shortcut_configuration
--
-- The leader key is ALT+q. Every shortcut below is a one-shot leader
-- sequence: press ALT+q, then the key. Only copy/paste stay on plain
-- CTRL/CTRL+SHIFT so they work without entering leader mode.
config.leader = { key = "q", mods = "ALT", timeout_milliseconds = 2000 }
--[[
==========================
Scrollback search
==========================
]] --

-- WezTerm has no built-in scrollback search, so the usual workaround is piping
-- output through `less`. These bindings search the native scrollback buffer
-- instead, which works for anything already printed to the screen.
--
-- NOTE on syntax: `Search` accepts exactly ONE pattern key, not a
-- Regex+Direction pair (passing both raises "Expected a valid `Pattern`
-- variant name as single key in object, but there are 2 keys"). The overlay
-- itself searches backwards by default; press CTRL+R inside the overlay to
-- reverse. CaseInSensitiveString is used so the search ignores case unless
-- you type otherwise.
--
-- ALT+q then f  open search overlay
-- ALT+q then n  repeat the last search (same overlay, pre-filled pattern)
-- ALT+q then g  jump to the bottom of the scrollback (live output)
-- ALT+q then t  enter the BottomPrompt table (sticky scroll-navigate mode)
config.keys = {
  {
    key = "f",
    mods = "LEADER",
    action = wezterm.action.Search { CaseInSensitiveString = "" }
  },
  {
    key = "g",
    mods = "LEADER",
    action = wezterm.action.ScrollToBottom
  },
  {
    key = "t",
    mods = "LEADER",
    action = wezterm.action.ActivateKeyTable {
      one_shot = false,
      name = "BottomPrompt",
      only_shows_key_labels = false,
    }
  },

  -- ALT+q then v : paste
  {
    mods = "CTRL | SHIFT",
    key = "v",
    action = wezterm.action.PasteFrom "Clipboard"
  },
  -- ALT+q then c : copy-or-send (copies a selection, otherwise forwards CTRL+C)
  {
    key = "c",
    mods = "CTRL",
    action = wezterm.action_callback(function(window, pane)
      local selection = window:get_selection_text_for_pane(pane)

      if selection and selection ~= "" then
        window:perform_action(
          wezterm.action.CopyTo("Clipboard"),
          pane
        )

        window:perform_action(
          wezterm.action.EmitEvent("copy-success"),
          pane
        )
      else
        window:perform_action(
          wezterm.action.SendKey({
            key = "c",
            mods = "CTRL",
          }),
          pane
        )
      end
    end),
  },
  -- ALT+q then o : quick-select from the scrollback patterns below
  {
    mods = "LEADER",
    key = "o",
    action = wezterm.action.QuickSelect
  },
  -- ALT+q then p : the command palette, with the taller row count set above
  {
    mods = "LEADER",
    key = "p",
    action = wezterm.action.ActivateCommandPalette
  },
  -- ALT+q then h : split horizontally (side by side)
  {
    mods = "LEADER",
    key = "v",
    action = wezterm.action.SplitHorizontal { domain = "CurrentPaneDomain" }
  },
  -- ALT+q then SHIFT+h : split vertically (stacked)
  {
    mods = "LEADER",
    key = "-",
    action = wezterm.action.SplitVertical { domain = "CurrentPaneDomain" }
  },
  {
    mods = "LEADER",
    key = "c",
    action = wezterm.action.SpawnTab "CurrentPaneDomain"
  },
  -- ALT+q then SHIFT+w : close tab
  {
    mods = "LEADER",
    key = "x",
    action = wezterm.action.CloseCurrentTab { confirm = false }
  },
  -- ALT+q then b : previous tab
  {
    mods = "LEADER",
    key = "p",
    action = wezterm.action.ActivateTabRelative(-1)
  },
  -- ALT+q then ] : next tab
  {
    mods = "LEADER",
    key = "n",
    action = wezterm.action.ActivateTabRelative(1)
  },
  -- ALT+q then arrows : move focus between panes
  {
    mods = "LEADER",
    key = "h",
    action = wezterm.action.ActivatePaneDirection "Left"
  },
  {
    mods = "LEADER",
    key = "j",
    action = wezterm.action.ActivatePaneDirection "Down"
  },
  {
    mods = "LEADER",
    key = "k",
    action = wezterm.action.ActivatePaneDirection "Up"
  },
  {
    mods = "LEADER",
    key = "l",
    action = wezterm.action.ActivatePaneDirection "Right"
  },
  -- ALT+q then SHIFT+arrows : resize the focused pane
  {
    mods = "LEADER",
    key = "LeftArrow",
    action = wezterm.action.AdjustPaneSize { "Left", 5 }
  },
  {
    mods = "LEADER",
    key = "DownArrow",
    action = wezterm.action.AdjustPaneSize { "Down", 5 }
  },
  {
    mods = "LEADER",
    key = "UpArrow",
    action = wezterm.action.AdjustPaneSize { "Up", 5 }
  },
  {
    mods = "LEADER",
    key = "RightArrow",
    action = wezterm.action.AdjustPaneSize { "Right", 5 }
  },
}

for i = 1, 9 do
  -- ALT+q then number activates that tab
  table.insert(config.keys, {
    key = tostring(i),
    mods = "LEADER",
    action = wezterm.action.ActivateTab(i - 1),
  })
end

--[[
==========================
Quick select targets
==========================
]] --

-- ALT+q then o opens this picker over the scrollback. The alphabet is the
-- home-row order (asdf...) so the keys sit under the fingers instead of the
-- qwerty order WezTerm uses by default.
config.quick_select_alphabet = "asdfqwerzxcvjklmiuopghtybn"

-- Patterns are tried in order; the first match wins. These target the things
-- worth clicking back to during a normal work session:
--   1. git SHAs and branch names in `git log`/`git status` output
--   2. file:line references from compiler/rustc/clippy diagnostics, so you can
--      jump straight to the error
--   3. bare paths and URLs
config.quick_select_patterns = {
  "\\b[0-9a-f]{7,40}\\b",        -- git SHAs
  "\\b[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+\\b", -- branch-like names (user/repo)
  "[a-zA-Z]:\\\\[^\\s:]+:\\d+",   -- C:\path\file.rs:123
  "\\b\\d{1,5}\\b",              -- bare line/column numbers
}

--[[
==========================
BottomPrompt key table
==========================
]] --

-- Reached with ALT+q then t. WezTerm's built-in `BottomPrompt` table only
-- exists for the default key bindings, so it is redefined here to make the
-- "jump to the bottom of the scrollback" workflow behave predictably.
--
-- NOTE: this build (20240203) cannot use `ScrollToPrompt` at all — it resolves
-- to a userdata that fails to convert into a key action, which aborts the whole
-- config ("error getting tostring"). `ScrollUp`/`ScrollDown`/`ScrollPageUp`/
-- ScrollPageDown are absent from the key assignment enum entirely. Scrolling is
-- therefore done with ScrollToTop / ScrollToBottom, and normal line scrolling
-- still works with the mouse wheel or the default CTRL+SHIFT+arrow bindings
-- (those are WezTerm's own scroll bindings, which this config leaves intact).
config.key_tables = {
  BottomPrompt = {
    { key = "Escape", action = wezterm.action.PopKeyTable },
    { key = "q", action = wezterm.action.PopKeyTable },
    {
      key = "End",
      action = wezterm.action.ScrollToBottom,
    },
    {
      key = "Home",
      action = wezterm.action.ScrollToTop,
    },
    -- NOTE: the key name for the down arrow is "DownArrow" in this build;
    -- plain "Down" is rejected as an invalid KeyCode string.
    {
      key = "DownArrow",
      action = wezterm.action.ActivateKeyTable {
        one_shot = false,
        name = "BottomPrompt",
        only_shows_key_labels = false,
      },
    },
  },
}

--[[
============================
Tab Bar
============================
]] --

-- tab bar
config.hide_tab_bar_if_only_one_tab = true
config.tab_bar_at_bottom = true
config.use_fancy_tab_bar = false
config.tab_and_split_indices_are_zero_based = false

-- NOTE: there is intentionally no `show_tab_indicators` here. This build
-- (20240203) rejects it: "show_tab_indicators is not a valid Config field".
-- Focus in the tab bar is instead conveyed purely by the format-tab-title
-- handler below, which paints the active tab as a filled accent pill and
-- leaves every other tab in a muted colour.

local function tab_title(tab_info)
  local title = tab_info.tab_title
  -- if the tab title is explicitly set, take that
  if title and #title > 0 then
    return title
  end
  -- Otherwise, use the title from the active pane
  -- in that tab
  return tab_info.active_pane.title
end

wezterm.on(
  "format-tab-title",
  function(tab, tabs, panes, config, hover, max_width)
    local title = " " .. tab.tab_index + 1 .. ": " .. tab_title(tab) .. " "
    local left_edge_text = ""
    local right_edge_text = ""

    -- ensure that the titles fit in the available space,
    -- and that we have room for the edges.
    -- title = wezterm.truncate_right(title, max_width - 2)

    if tab.is_active then
      -- Focused tab: filled accent pill, highest contrast in the bar.
      return {
        { Background = { Color = colors.tab_bar_active_tab_bg } },
        { Foreground = { Color = colors.tab_bar_active_tab_fg } },
        { Text = left_edge_text },
        { Background = { Color = colors.tab_bar_active_tab_fg } },
        { Foreground = { Color = colors.tab_bar_text } },
        { Text = title },
        { Background = { Color = colors.tab_bar_active_tab_bg } },
        { Foreground = { Color = colors.tab_bar_active_tab_fg } },
        { Text = right_edge_text },
      }
    end

    -- Inactive tab: previously this returned nil, which fell back to WezTerm's
    -- default rendering and left unfocused tabs nearly as loud as the focused
    -- one. Render them explicitly in a muted colour so the focused tab stands
    -- out. Hover lifts them slightly so the pointer still feels responsive.
    local fg = hover and colors.subtext0 or colors.overlay0
    return {
      { Background = { Color = colors.tab_bar_active_tab_bg } },
      { Foreground = { Color = fg } },
      { Text = " " .. tab.tab_index + 1 .. ": " .. tab_title(tab) .. " " },
    }
  end
)

--[[
============================
Leader Active Indicator
============================
]] --

-- `update-status` fires roughly every 100ms whether or not anything changed.
-- The previous version rebuilt and re-applied the status text on every single
-- tick, which forced a full-window recomposite ~10x/second for content that
-- was almost always byte-identical. In a large chat scrollback that constant
-- repaint is what made the GPU surface corruption appear even while idle.
--
-- Caching the rendered string and skipping set_left_status when it is unchanged
-- means the indicator is only redrawn when the leader actually toggles.
local last_leader_status = nil

wezterm.on("update-status", function(window, _)
  -- leader inactive
  local solid_left_arrow = ""
  local arrow_foreground = { Foreground = { Color = colors.arrow_foreground_leader } }
  local arrow_background = { Background = { Color = colors.arrow_background_leader } }
  local prefix = ""

  -- leader is active
  if window:leader_is_active() then
    prefix = " " .. leader_prefix

    if tab_style == "rounded" then
      solid_left_arrow = wezterm.nerdfonts.ple_right_half_circle_thick
    else
      solid_left_arrow = wezterm.nerdfonts.pl_left_hard_divider
    end

    local tabs = window:mux_window():tabs_with_info()

    if tab_style ~= "rounded" then
      for _, tab_info in ipairs(tabs) do
        if tab_info.is_active and tab_info.index == 0 then
          arrow_background = { Foreground = { Color = colors.tab_bar_active_tab_fg } }
          solid_left_arrow = wezterm.nerdfonts.pl_right_hard_divider
          break
        end
      end
    end
  end

  local status = wezterm.format {
    { Background = { Color = colors.arrow_foreground_leader } },
    { Text = prefix },
    arrow_foreground,
    arrow_background,
    { Text = solid_left_arrow }
  }

  -- Only touch the status bar when it actually differs from what is already
  -- painted. Without this guard every idle tick forced a full repaint.
  if last_leader_status ~= status then
    last_leader_status = status
    window:set_left_status(status)
  end
end)

-- and finally, return the configuration to wezterm

return config
