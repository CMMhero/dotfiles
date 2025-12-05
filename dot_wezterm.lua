-- Pull in the wezterm API
local wezterm = require "wezterm"

-- This table will hold the configuration.
local config = {}

-- In newer versions of wezterm, use the config_builder which will
-- help provide clearer error messages
if wezterm.config_builder then
  config = wezterm.config_builder()
end

-- terminal configuration
-- config.default_prog = { "pwsh.exe", "-NoLogo" }
config.default_prog = { "nu.exe" }


-- max fps
config.max_fps = 240
config.animation_fps = 240

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
    wezterm.font_with_fallback { "GeistMono NFP", "CascadiaCove NFP Regular" }
config.font_size = 15

config.window_decorations = "RESIZE"
config.window_background_opacity = 0.50
config.win32_system_backdrop = "Acrylic" -- or "Mica", "Tabbed", "Acrylic"

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
      rosewater = "f4dbd6",
      flamingo = "f0c6c6",
      pink = "f5bde6",
      mauve = "c6a0f6",
      red = "ed8796",
      maroon = "ee99a0",
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
}


--[[
============================
Border
============================
]] --

config.window_frame = {
  border_left_width = "0.4cell",
  border_right_width = "0.4cell",
  border_bottom_height = "0.15cell",
  border_top_height = "0.15cell",
  border_left_color = colors.border,
  border_right_color = colors.border,
  border_bottom_color = colors.border,
  border_top_color = colors.border,
}

--[[
============================
Shortcuts
============================
]] --

-- shortcut_configuration
config.leader = { key = "q", mods = "ALT", timeout_milliseconds = 2000 }
config.keys = {
  {
    mods = "CTRL|SHIFT",
    key = "v",
    action = wezterm.action.PasteFrom 'Clipboard'
  },
  {
    mods = "CTRL|SHIFT",
    key = "c",
    action = wezterm.action.CopyTo 'Clipboard'
  },
  -- {
  --   mods = 'LEADER',
  --   key = 'c',
  --   action = wezterm.action_callback(function(window, pane)
  --     local selection_text = window:get_selection_text_for_pane(pane)
  --     local is_selection_active = string.len(selection_text) ~= 0
  --     if is_selection_active then
  --       window:perform_action(wezterm.action.CopyTo('ClipboardAndPrimarySelection'), pane)
  --     else
  --       window:perform_action(wezterm.action.SendKey { key = 'c', mods = 'CTRL' }, pane)
  --     end
  --   end),
  -- },
  {
    mods = "CTRL",
    key = "t",
    action = wezterm.action.SpawnTab 'CurrentPaneDomain'
  },
  {
    mods = "CTRL",
    key = "w",
    action = wezterm.action.CloseCurrentPane { confirm = false }
  },
  {
    mods = "CTRL",
    key = "d",
    action = wezterm.action.SplitHorizontal { domain = "CurrentPaneDomain" }
  },
  {
    mods = "CTRL|SHIFT",
    key = "d",
    action = wezterm.action.SplitVertical { domain = "CurrentPaneDomain" }
  },
  {
    mods = "ALT",
    key = "b",
    action = wezterm.action.ActivateTabRelative(-1)
  },
  {
    mods = "ALT",
    key = "n",
    action = wezterm.action.ActivateTabRelative(1)
  },
  {
    mods = "ALT",
    key = "h",
    action = wezterm.action.ActivatePaneDirection "Left"
  },
  {
    mods = "ALT",
    key = "j",
    action = wezterm.action.ActivatePaneDirection "Down"
  },
  {
    mods = "ALT",
    key = "k",
    action = wezterm.action.ActivatePaneDirection "Up"
  },
  {
    mods = "ALT",
    key = "l",
    action = wezterm.action.ActivatePaneDirection "Right"
  },
  {
    mods = "ALT",
    key = "LeftArrow",
    action = wezterm.action.AdjustPaneSize { "Left", 5 }
  },
  {
    mods = "ALT",
    key = "RightArrow",
    action = wezterm.action.AdjustPaneSize { "Right", 5 }
  },
  {
    mods = "ALT",
    key = "DownArrow",
    action = wezterm.action.AdjustPaneSize { "Down", 5 }
  },
  {
    mods = "ALT",
    key = "UpArrow",
    action = wezterm.action.AdjustPaneSize { "Up", 5 }
  },
}

for i = 1, 9 do
  -- alt + number to activate that tab
  table.insert(config.keys, {
    key = tostring(i),
    mods = "ALT",
    action = wezterm.action.ActivateTab(i - 1),
  })
end

--[[
============================
Tab Bar
============================
]] --

-- tab bar
config.hide_tab_bar_if_only_one_tab = false
config.tab_bar_at_bottom = true
config.use_fancy_tab_bar = false
config.tab_and_split_indices_are_zero_based = false

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
  end
)

--[[
============================
Leader Active Indicator
============================
]] --

wezterm.on("update-status", function(window, _)
  -- leader inactive
  local solid_left_arrow = ""
  local arrow_foreground = { Foreground = { Color = colors.arrow_foreground_leader } }
  local arrow_background = { Background = { Color = colors.arrow_background_leader } }
  local prefix = ""

  -- leaader is active
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


  window:set_left_status(wezterm.format {
    { Background = { Color = colors.arrow_foreground_leader } },
    { Text = prefix },
    arrow_foreground,
    arrow_background,
    { Text = solid_left_arrow }
  })
end)

-- and finally, return the configuration to wezterm
return config
