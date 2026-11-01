/** Localized text helper for the Map app. */
export const t = (key: string, ...args: Array<string | number>): string =>
    window.TacPhone.localization.t(key, ...args);

/**
 * Base-game stringtable keys used by the Map app.
 *
 * They are not part of the add-on stringtable, so the app preloads them from
 * the game in bulk during `init()`, before any panel renders.
 */
export const MAP_BASE_GAME_STRINGS: readonly string[] = [
    'STR_3DEN_Group_Mode_Custom',
    'STR_3DEN_Layer_textPlural',
    'STR_3DEN_Marker_textPlural',
    'STR_3DEN_Marker_textSingular',
    'str_3den_marker_attribute_alpha_displayname',
    'str_3den_marker_attribute_color_displayname',
    'str_a3_cfgvehicles_modulechat_f_arguments_channel_0',
    'str_a3_map1',
    'str_channel_command',
    'str_channel_direct',
    'str_channel_global',
    'str_channel_group',
    'str_channel_side',
    'str_channel_vehicle',
    'str_arcmark_title2',
    'str_a3_rscdiary_markercolor_tooltip',
    'str_a3_rscdisplayarcademodules_direction',
    'str_usract_buld_scale',
];
