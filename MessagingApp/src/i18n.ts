/** Localized text helper for the Messenger app. */
export const t = (key: string, ...args: Array<string | number>): string =>
    window.TacPhone.localization.t(key, ...args);

/**
 * Base-game stringtable keys used by the Messenger app.
 *
 * They are not part of the add-on stringtable, so the app preloads them from
 * the game in bulk during `init()`, before any panel renders.
 */
export const MESSENGER_BASE_GAME_STRINGS: readonly string[] = [
    'STR_A3_TargetBootcampTable_direct',
    'str_a3_cfgvehicles_modulecuratoraddaddons_f_arguments_mode_values_remove',
    'str_a3_cfgvehicles_modulecuratoraddeditableobjects_arguments_addcrew_values_yes',
    'str_a3_forward',
    'str_a3_orange_hub_post_timelinelabel',
    'str_a3_rscdisplaycurator_modegroups_tooltip',
    'str_a3_rscdisplaydynamicgroups_button_join',
    'str_a3_rscdisplaydynamicgroups_players',
    'str_a3_rscdisplaydynamicgroups_you',
    'str_a3_vr_available',
    'str_disp_close',
    'str_disp_xbox_friends_offline',
    'str_network_creating',
    'str_a3_rscdisplayremotemissions_buttonlog',
];
