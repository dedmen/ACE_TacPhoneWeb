// One localization helper for host UI code.
//
// It reads the global host object instead of importing the service, so modules
// that the localization service itself depends on (Networking) can use it
// without an import cycle. Before the host is installed it returns the key,
// matching `t()`'s missing-key behaviour.

/** Translated host UI text, with `%1`..`%9` replaced by `args`. */
export function t(key: string, ...args: Array<string | number>): string {
    return window.TacPhone?.localization?.t(key, ...args) ?? key
}

/**
 * Base-game stringtable keys used by the host UI.
 *
 * These are not part of the add-on stringtable (and therefore not in the
 * bundled default table), so they are preloaded from the game in bulk after the
 * connection opens. The pre-connection UI (remote pairing, loading, fatal
 * error) must not use any of them.
 */
export const HOST_BASE_GAME_STRINGS: readonly string[] = [
    'STR_3DEN_Display3DEN_ControlsHint_Cancel',
    'STR_3DEN_Display3DEN_ControlsHint_Disconnect',
    'STR_A3_RscDisplayMain_Spotlight_Create',
    'STR_A3_RscDisplayMain_TitleOptions_text',
    'str_3den_attributes_preferencessavegame_min15_text',
    'str_3den_attributes_preferencessavegame_min60_text',
    'str_3den_display3den_entitymenu_select_text',
    'str_3den_display3den_menubar_missionsave_text',
    'str_3den_display3den_menubar_search_text',
    'str_3den_display3den_menubar_undo_text',
    'str_3den_tutorials_editing_sections_connecting_text',
    'str_a3_cfgvehicles_modulecuratoraddeditableobjects_arguments_addcrew_values_yes',
    'str_a3_rscdisplaycampaignlobby_reset',
    'str_disp_close',
]
