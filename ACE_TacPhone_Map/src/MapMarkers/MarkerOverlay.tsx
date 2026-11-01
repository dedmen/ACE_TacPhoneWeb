import {
    forwardRef,
    useCallback,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type OlMap from 'ol/Map';

import { MarkerModule, type PolylineUiState } from './MarkerModule';
import type { MarkerPreviewDraft } from './MarkerLayer';
import type { MapFlyToOptions, MapFocusMarkerOptions } from '../api';
import { MarkerCreateDialog } from './MarkerCreateDialog';
import { MarkerContextMenu } from './MarkerContextMenu';
import { PolylineDrawControls } from './PolylineDrawControls';
import type { MarkerCreationData } from './MarkerApi';
import {
    normalizeDirectionForDialog,
    type MarkerChannel,
} from './Channels';
import type { MarkerColor, MarkerType } from './MarkerLayer';
import { MarkerChannelStore } from './MarkerChannelStore';
import { MarkerLayerSwitcherSection } from './MarkerLayerSwitcherSection';
import type { LayerSwitcherRegistry } from './LayerSwitcherRegistry';
import {
    MAP_APP_NAME,
    isMessengerInstalled,
    registerMarkerObjectRenderer,
    shareMarkerToMessenger,
} from '../MessagingBridge';

// Game-side marker interest. Must match INTEREST_MARKERS in
// addons/tacphone/apps/map/script_component.hpp.
const MAP_MARKERS_INTEREST = 'ACE_TacPhone_Map.markers';

const MARKER_MENU_WIDTH_PX = 200;
const MARKER_MENU_HEIGHT_PX = 184;
const MARKER_MENU_MARGIN_PX = 8;

interface MarkerDialogState {
    isOpen: boolean;
    mode: 'create' | 'edit';
    markerName: string | null;
    coordinate: [number, number] | null;
    initialLabel: string;
    initialType: string;
    initialColor: string;
    initialDir: number;
    initialScale: number;
    initialChannel: number;
    anchor: { x: number; y: number } | null;
    containerSize: { width: number; height: number };
    markerTypes: MarkerType[];
    markerColors: MarkerColor[];
    channels: MarkerChannel[];
}

interface MarkerMenuState {
    name: string;
    x: number;
    y: number;
}

export interface MarkerOverlayHandle {
    hasMarker(name: string): boolean;
    focusMarker(name: string, options?: MapFocusMarkerOptions): Promise<boolean>;
    stopPolyline(): void;
}

interface MarkerOverlayProps {
    map: OlMap | null;
    /** Map container with `position: relative`, used for dialog/menu placement. */
    mapContainer: HTMLDivElement | null;
    /** Registry the marker channel section is injected into. */
    layerSwitcher: LayerSwitcherRegistry;
    /** Normal Map flyTo, used by focusMarker(). */
    flyTo(options: MapFlyToOptions): void;
    /** Close the map layer switcher when a marker panel opens. */
    onRequestCloseLayers(): void;
}

const EMPTY_DIALOG: MarkerDialogState = {
    isOpen: false,
    mode: 'create',
    markerName: null,
    coordinate: null,
    initialLabel: '',
    initialType: '',
    initialColor: '',
    initialDir: 0,
    initialScale: 1,
    initialChannel: 3,
    anchor: null,
    containerSize: { width: 0, height: 0 },
    markerTypes: [],
    markerColors: [],
    channels: [],
};

const EMPTY_POLYLINE: PolylineUiState = {
    isActive: false,
    color: '',
    vertexCount: 0,
    clickPerPoint: false,
};

export const MarkerOverlay = forwardRef<MarkerOverlayHandle, MarkerOverlayProps>(function MarkerOverlay(
    { map, mapContainer, layerSwitcher, flyTo, onRequestCloseLayers },
    ref,
) {
    const [ready, setReady] = useState(false);
    const [dialog, setDialog] = useState<MarkerDialogState>(EMPTY_DIALOG);
    const [menu, setMenu] = useState<MarkerMenuState | null>(null);
    const [polylineDraw, setPolylineDraw] = useState<PolylineUiState>(EMPTY_POLYLINE);
    const channels = useMemo(() => new MarkerChannelStore(), []);

    const channelSnapshot = useSyncExternalStore(channels.subscribe, channels.getSnapshot);
    const multiplayer = channelSnapshot.multiplayer;

    const moduleRef = useRef<MarkerModule | null>(null);
    const dialogRef = useRef(dialog);
    const flyToRef = useRef(flyTo);

    dialogRef.current = dialog;
    flyToRef.current = flyTo;

    const loadMarkerIcon = useCallback((iconPath: string): Promise<string> => {
        const module = moduleRef.current;
        if (!module) {
            return Promise.reject(new Error('Marker module is not initialized'));
        }

        return module.loadMarkerIcon(iconPath);
    }, []);

    const changeActiveChannel = useCallback((channel: number): void => {
        channels.setActiveChannel(channel);
    }, [channels]);

    const openMarkerDialog = useCallback((coordinate: [number, number]): void => {
        const module = moduleRef.current;
        if (!module) {
            return;
        }

        void module.whenChannelsLoaded().then(() => {
            if (moduleRef.current !== module || !mapContainer) {
                return;
            }

            openMarkerDialogWith({
                mode: 'create',
                markerName: null,
                coordinate,
                initialLabel: '',
                initialType: '',
                initialColor: '',
                initialDir: 0,
                initialScale: 1,
                initialChannel: module.getEffectiveChannelForRequest(module.getActiveChannel()),
            });
        });
        // The callback below is defined in the same component; this forward
        // reference is resolved by the time the promise runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapContainer]);

    const openMarkerEditDialog = useCallback((name: string): void => {
        const module = moduleRef.current;
        const data = module?.getMarkerData(name);
        if (!module || !data) {
            return;
        }

        void module.whenChannelsLoaded().then(() => {
            if (moduleRef.current !== module || !mapContainer) {
                return;
            }

            openMarkerDialogWith({
                mode: 'edit',
                markerName: name,
                coordinate: data.position,
                initialLabel: data.label,
                initialType: data.type,
                initialColor: data.color,
                initialDir: normalizeDirectionForDialog(data.dir),
                initialScale: data.size[0],
                initialChannel: data.channel,
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapContainer]);

    const openMarkerDialogWith = useCallback((next: Omit<MarkerDialogState, 'isOpen' | 'anchor' | 'containerSize' | 'markerTypes' | 'markerColors' | 'channels'>): void => {
        const module = moduleRef.current;
        if (!module || next.coordinate === null) {
            return;
        }

        const rect = mapContainer?.getBoundingClientRect();
        const pixel = map?.getPixelFromCoordinate(next.coordinate) ?? null;

        onRequestCloseLayers();

        setDialog({
            ...next,
            isOpen: true,
            anchor: pixel ? { x: pixel[0], y: pixel[1] } : null,
            containerSize: rect
                ? { width: rect.width, height: rect.height }
                : { width: 0, height: 0 },
            markerTypes: module.getMarkerTypes(),
            markerColors: module.getMarkerColors(),
            channels: module.getAvailableChannels(),
        });

        if (module.getMarkerTypes().length === 0 || module.getMarkerColors().length === 0) {
            void module.whenMarkerConfigLoaded().then(() => {
                if (moduleRef.current !== module) {
                    return;
                }

                setDialog((previous) => ({
                    ...previous,
                    markerTypes: module.getMarkerTypes(),
                    markerColors: module.getMarkerColors(),
                    channels: module.getAvailableChannels(),
                }));
            });
        }
    }, [map, mapContainer]);

    const closeMarkerDialog = useCallback((): void => {
        moduleRef.current?.hideMarkerPreview();
        setDialog((previous) => ({
            ...previous,
            isOpen: false,
            coordinate: null,
            anchor: null,
        }));
    }, []);

    const handleMarkerDraftChange = useCallback((draft: MarkerPreviewDraft): void => {
        const current = dialogRef.current;
        if (current.mode !== 'create' || current.coordinate === null) {
            return;
        }

        moduleRef.current?.updateMarkerPreview({
            ...draft,
            position: current.coordinate,
        });
    }, []);

    const handleMarkerChannelChange = useCallback((channel: number): void => {
        changeActiveChannel(channel);
    }, [changeActiveChannel]);

    const handleMarkerDialogSubmit = useCallback((marker: MarkerCreationData): void => {
        const current = dialogRef.current;
        moduleRef.current?.hideMarkerPreview();

        if (current.mode === 'edit' && current.markerName !== null) {
            moduleRef.current?.updateMarkerProperties(current.markerName, {
                label: marker.label,
                type: marker.type,
                color: marker.color,
                dir: marker.dir,
                size: marker.size,
                channel: marker.channel,
            });
        } else {
            moduleRef.current?.createMarker(marker);
        }

        closeMarkerDialog();
    }, [closeMarkerDialog]);

    const openMarkerMenu = useCallback((name: string, clientX: number, clientY: number): void => {
        if (!mapContainer) {
            return;
        }

        const rect = mapContainer.getBoundingClientRect();
        const maxX = Math.max(MARKER_MENU_MARGIN_PX, rect.width - MARKER_MENU_WIDTH_PX - MARKER_MENU_MARGIN_PX);
        const maxY = Math.max(MARKER_MENU_MARGIN_PX, rect.height - MARKER_MENU_HEIGHT_PX - MARKER_MENU_MARGIN_PX);

        onRequestCloseLayers();
        setMenu({
            name,
            x: Math.min(Math.max(clientX - rect.left, MARKER_MENU_MARGIN_PX), maxX),
            y: Math.min(Math.max(clientY - rect.top, MARKER_MENU_MARGIN_PX), maxY),
        });
    }, [mapContainer]);

    const closeMarkerMenu = useCallback((): void => {
        setMenu(null);
    }, []);

    const canShareMarker = useCallback((name: string): boolean => {
        return isMessengerInstalled() && moduleRef.current?.getMarkerChatData(name) != null;
    }, []);

    const showShareError = useCallback((detail: string | undefined): void => {
        window.TacPhone.notifications.show({
            title: 'Could not share marker',
            body: detail && detail !== '' ? detail : 'Messenger is not available.',
            app: MAP_APP_NAME,
            sound: 'alert',
        });
    }, []);

    const handleShareMarkerFromMenu = useCallback((name: string): void => {
        closeMarkerMenu();

        const data = moduleRef.current?.getMarkerChatData(name);
        if (!data) {
            return;
        }

        void shareMarkerToMessenger(data)
            .then((result) => {
                if (!result.ok && !result.cancelled) {
                    showShareError(result.error);
                }
            })
            .catch((error: unknown) => {
                console.error('Failed to share marker', error);
                showShareError(error instanceof Error ? error.message : undefined);
            });
    }, [closeMarkerMenu, showShareError]);

    // Keep the module's event callbacks pointing at the current React handlers.
    const callbacksRef = useRef({
        openCreate: openMarkerDialog,
        openEdit: openMarkerEditDialog,
        openMenu: openMarkerMenu,
        closeMenu: closeMarkerMenu,
    });
    callbacksRef.current = {
        openCreate: openMarkerDialog,
        openEdit: openMarkerEditDialog,
        openMenu: openMarkerMenu,
        closeMenu: closeMarkerMenu,
    };

    useLayoutEffect(() => {
        return layerSwitcher.register({
            id: 'markers',
            order: 10,
            ownsLayer: (layer) => typeof layer.get('markerChannel') === 'number',
            render: (props) => <MarkerLayerSwitcherSection {...props} channels={channels} />,
        });
    }, [layerSwitcher, channels]);

    useLayoutEffect(() => {
        if (!map) {
            return;
        }

        // Acquire the interest before the module requests the marker snapshot.
        const releaseInterest = window.TacPhone.interests.acquire(MAP_MARKERS_INTEREST);
        const module = new MarkerModule(map, {
            isDialogOpen: () => dialogRef.current.isOpen,
            onOpenCreateDialog: (coordinate) => callbacksRef.current.openCreate(coordinate),
            onOpenEditDialog: (name) => callbacksRef.current.openEdit(name),
            onOpenMarkerMenu: (name, clientX, clientY) => callbacksRef.current.openMenu(name, clientX, clientY),
            onCloseMarkerMenu: () => callbacksRef.current.closeMenu(),
            onPolylineStateChange: (state) => setPolylineDraw(state),
            flyTo: (options) => flyToRef.current(options),
        });

        moduleRef.current = module;
        channels.attach(module);
        setReady(true);
        setPolylineDraw(module.getPolylineState());

        const releaseRenderer = registerMarkerObjectRenderer();

        void module.whenChannelsLoaded().then(() => {
            if (moduleRef.current !== module) {
                return;
            }

            channels.update();
        });

        return () => {
            moduleRef.current = null;
            channels.detach(module);
            module.destroy();
            releaseInterest();
            releaseRenderer();
            setReady(false);
        };
    }, [map, channels]);

    useImperativeHandle(ref, () => ({
        hasMarker(name: string): boolean {
            return moduleRef.current?.hasMarker(name) ?? false;
        },
        focusMarker(name: string, options?: MapFocusMarkerOptions): Promise<boolean> {
            return moduleRef.current?.focusMarker(name, options) ?? Promise.resolve(false);
        },
        stopPolyline(): void {
            moduleRef.current?.stopPolyline();
        },
    }), []);

    if (!ready || !map) {
        return null;
    }

    return (
        <>
            <PolylineDrawControls
                isActive={polylineDraw.isActive}
                vertexCount={polylineDraw.vertexCount}
                colors={moduleRef.current?.getPolylineColors() ?? []}
                selectedColor={polylineDraw.color}
                clickPerPoint={polylineDraw.clickPerPoint}
                channelLabel={channelSnapshot.activeChannelLabel}
                onToggle={() => {
                    onRequestCloseLayers();
                    moduleRef.current?.togglePolyline();
                }}
                onSelectColor={(color) => moduleRef.current?.setPolylineColor(color)}
                onClickPerPointChange={(value) => moduleRef.current?.setPolylineClickPerPoint(value)}
                onUndo={() => moduleRef.current?.undoPolyline()}
                onCancel={() => moduleRef.current?.stopPolyline()}
                onFinish={() => moduleRef.current?.finishPolyline()}
            />

            {dialog.isOpen && dialog.coordinate !== null && (
                <MarkerCreateDialog
                    key={dialog.mode === 'edit' ? `edit:${dialog.markerName}` : 'create'}
                    mode={dialog.mode}
                    coordinate={dialog.coordinate}
                    markerTypes={dialog.markerTypes}
                    markerColors={dialog.markerColors}
                    channels={dialog.channels}
                    multiplayer={multiplayer}
                    loadMarkerIcon={loadMarkerIcon}
                    initialLabel={dialog.initialLabel}
                    initialType={dialog.initialType}
                    initialColor={dialog.initialColor}
                    initialDir={dialog.initialDir}
                    initialScale={dialog.initialScale}
                    initialChannel={dialog.initialChannel}
                    anchor={dialog.anchor}
                    containerSize={dialog.containerSize}
                    onChannelChange={handleMarkerChannelChange}
                    onDraftChange={handleMarkerDraftChange}
                    title={dialog.mode === 'edit' ? 'Edit Marker' : 'Add Marker'}
                    submitLabel={dialog.mode === 'edit' ? 'Save' : 'Create'}
                    onSubmit={handleMarkerDialogSubmit}
                    onCancel={closeMarkerDialog}
                />
            )}

            {menu !== null && (
                <MarkerContextMenu
                    x={menu.x}
                    y={menu.y}
                    onEdit={() => {
                        closeMarkerMenu();
                        openMarkerEditDialog(menu.name);
                    }}
                    onDelete={() => {
                        moduleRef.current?.deleteMarker(menu.name);
                        closeMarkerMenu();
                    }}
                    onShare={() => handleShareMarkerFromMenu(menu.name)}
                    canShare={canShareMarker(menu.name)}
                    canEdit={moduleRef.current?.getMarkerData(menu.name) != null}
                    canDelete={moduleRef.current?.getMarkerData(menu.name) != null}
                    onClose={closeMarkerMenu}
                />
            )}
        </>
    );
});
