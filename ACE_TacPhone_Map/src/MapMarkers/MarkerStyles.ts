/**
 * OpenLayers style builders for the marker layers.
 *
 * Builds the per-feature icon and polyline styles used by
 * MarkerLayerManager. The manager keeps the channel dimming, marker
 * config and texture cache; the builders reach them through the back
 * reference. The color helpers are shared with the manager's debug
 * snapshot and property application.
 */

import type { FeatureLike } from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import { Style, Icon, Text, Fill, Stroke } from 'ol/style';
import { shared as iconImageCache } from 'ol/style/IconImageCache';
import { markerColorToOpaqueCss, markerLabelColor } from './MarkerColorUtils';
import type { MarkerLayerManager } from './MarkerLayers';

// Custom RGBA drags create a tinted icon per color, and OpenLayers caches each
// by texture + color. Keep that cache bounded so a long drag cannot accumulate
// thousands of tinted canvases; styles already in use keep their reference.
iconImageCache.setSize(256);

/** Alpha component of a resolved CSS color, used for the debug opacity. */
export function colorAlpha(color: string): number {
    if (/^#[0-9a-f]{8}$/i.test(color)) {
        return parseInt(color.slice(7, 9), 16) / 255;
    }

    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)$/.exec(color);
    if (rgba) {
        const value = Number(rgba[1]);
        return Number.isFinite(value) ? value : 1;
    }

    return 1;
}

export function applyAlphaToColor(color: string, alpha: number): string {
    const effectiveAlpha = Number.isFinite(alpha) ? alpha : 1;
    if (effectiveAlpha === 1) {
        return color;
    }

    // Hex colors from the game are #rrggbbaa. Strokes have no separate opacity,
    // so the marker alpha has to be part of the stroke color.
    if (color.startsWith('#') && color.length === 7) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${effectiveAlpha})`;
    }

    if (color.startsWith('#') && color.length === 9) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        // A hex color may already carry alpha (CfgMarkerColors is #rrggbbaa, and
        // an 8-digit custom color keeps its own alpha); multiply, never replace.
        const baseAlpha = parseInt(color.slice(7, 9), 16) / 255;
        return `rgba(${r}, ${g}, ${b}, ${baseAlpha * effectiveAlpha})`;
    }

    if (color.startsWith('rgba')) {
        return color.replace(
            /rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)/,
            (_match, r, g, b, alphaPart) => `rgba(${r},${g},${b},${Number(alphaPart) * effectiveAlpha})`,
        );
    }

    if (color.startsWith('rgb(')) {
        return color.replace(/rgb\(([^,]+),([^,]+),([^,]+)\)/, `rgba($1,$2,$3,${effectiveAlpha})`);
    }

    return color;
}

export class MarkerStyles {
    private readonly m: MarkerLayerManager;

    constructor(m: MarkerLayerManager) {
        this.m = m;
    }

    public dynamicIconStyleFunction = (feature: FeatureLike, resolution: number) => {
        // Each feature owns its base style. Anything that changes per update is
        // baked into that style in createFeatureStyle; only render-time values
        // are applied here.

        const baseStyle = feature.get('baseStyle') as Style;
        if (!baseStyle) {
            return baseStyle;
        }

        const geometry = feature.getGeometry();
        if (geometry instanceof LineString) {
            // The line color (including marker alpha) is baked into this
            // feature's own style when it is created/updated.
            return baseStyle;
        }

        // Everything we can dynamically solve here, is slower (updated every render, instead of once at marker creation), but we don't fill the style cache with lots of crap

        const rotationInRadians = (feature.get('dir') || 0) * (Math.PI / 180);
        const rawAlpha = feature.get('alpha') as number | undefined;
        const markerAlpha = (Number.isFinite(rawAlpha) ? rawAlpha as number : 1)
            * this.m.getChannelDim(feature.get('channel'));
        // A custom `#(r,g,b,a)` color keeps its alpha in the resolved CSS color.
        // OpenLayers cannot express that through the icon tint (a translucent
        // tint washes the icon toward white), so apply it as icon opacity. That
        // also fades the cloned shadow style, which copies the opacity.
        const rawColorAlpha = feature.get('colorAlpha') as number | undefined;
        const colorAlphaValue = Number.isFinite(rawColorAlpha)
            ? Math.max(0, Math.min(1, rawColorAlpha as number))
            : 1;
        const alpha = markerAlpha * colorAlphaValue;
        const size = feature.get('size') as [number, number];
        const shadow = feature.get('shadow') as boolean;
        const elevated = feature.get('elevated') === true;


        // Try to replicate Arma's text zooming size behavior
        var zoom = 1 / resolution;
        if (zoom > 1.5)
            zoom = 1.5;
        if (zoom < 0.5)
            zoom = 0.5;

        //var textSize = 32 * zoom;

        var labelText = feature.get('label');

        if (labelText != '')
        {
            // The resolved color is stored on the feature when its style is
            // created; Icon.getColor() may return an OL Color object instead of
            // a CSS string, which used to force every label to white.
            const labelColor = markerLabelColor(feature.get('resolvedColor') as string | undefined);
            var text = new Text({
                text: feature.get('label'), // Will be updated per feature
                font: `normal bold condensed 24px "Roboto", sans-serif`,
                fill: new Fill({ color: applyAlphaToColor(labelColor, markerAlpha) }),
                offsetX: size ? 32*size[1] : 32, //#TODO offset depends on icon size, text is right side of icon
                scale: zoom,
                declutterMode: "declutter",
                textAlign: "left",
            });

            baseStyle.setText(text);
        }

        if (shadow)
        {
            // To annoying, makes it too hard to read
            //text.setStroke(new Stroke({ color: '#000000', width: 2 }));
        }

        baseStyle.getImage()?.setRotation(rotationInRadians);
        baseStyle.getImage()?.setOpacity(alpha);
        baseStyle.getImage()?.setScale(size);


        if (shadow || elevated)
        {
            // One cloned style drawn behind the marker. It never carries the
            // label, otherwise the text would be rendered twice.
            var subShadow = baseStyle.clone();
            subShadow.setText(new Text({ text: '' }));

            if (elevated) {
                // A lifted marker always gets a shadow, even when its type has
                // none, so the drag target reads as "picked up".
                subShadow.getImage()?.setDisplacement([5, -5]);
                (subShadow.getImage() as Icon).setColor('rgba(0, 0, 0, 0.55)');
            } else {
                subShadow.getImage()?.setDisplacement([3, -3]); //#TODO thats not the correct offset, it also depends on scale?
                (subShadow.getImage() as Icon).setColor('rgba(0, 0, 0, 0.8)');
            }

            return [
                subShadow,
                baseStyle
            ];
        }

        return baseStyle;
    };

    public createFeatureStyle(
        type: string,
        shape: string,
        color: string,
        _brush: string,
        _size: string,
        alpha: number,
        channel: number = this.m.activeChannelId,
    ): Style {

        if (shape === 'POLYLINE' || shape === 'polyline') {
            var lineColor = this.m.resolveColorFor(type, color);
            var strokeWidth = 2;

            // Styles are per-feature, so applying the alpha here cannot leak
            // into another polyline and is restored when alpha becomes 1.
            return new Style({
                stroke: new Stroke({
                    color: applyAlphaToColor(lineColor, alpha * this.m.getChannelDim(channel)),
                    width: strokeWidth,
                }),
            });
        }

        var markerIcon = new Icon({
                // Placeholder spinner image
                src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIj4KICA8c3R5bGU+CiAgICAuc3Bpbm5lciB7CiAgICAgIGFuaW1hdGlvbjogcm90YXRlIDJzIGxpbmVhciBpbmZpbml0ZTsKICAgICAgdHJhbnNmb3JtLW9yaWdpbjogY2VudGVyIGNlbnRlcjsKICAgIH0KICAgIC5wYXRoIHsKICAgICAgc3Ryb2tlOiAjM2I4MmY2OwogICAgICBzdHJva2UtbGluZWNhcDogcm91bmQ7CiAgICAgIGFuaW1hdGlvbjogZGFzaCAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwogICAgfQogICAgQGtleWZyYW1lcyByb3RhdGUgewogICAgICAxMDAlIHsgdHJhbnNmb3JtOiByb3RhdGUoMzYwZGVnKTsgfQogICAgfQogICAgQGtleWZyYW1lcyBkYXNoIHsKICAgICAgMCUgewogICAgICAgIHN0cm9rZS1kYXNoYXJyYXk6IDEsIDE1MDsKICAgICAgICBzdHJva2UtZGFzaG9mZnNldDogMDsKICAgICAgfQogICAgICA1MCUgewogICAgICAgIHN0cm9rZS1kYXNoYXJyYXk6IDkwLCAxNTA7CiAgICAgICAgc3Ryb2tlLWRhc2hvZmZzZXQ6IC0zNTsKICAgICAgfQogICAgICAxMDAlIHsKICAgICAgICBzdHJva2UtZGFzaGFycmF5OiA5MCwgMTUwOwogICAgICAgIHN0cm9rZS1kYXNob2Zmc2V0OiAtMTI0OwogICAgICB9CiAgICB9CiAgPC9zdHlsZT4KICA8Y2lyY2xlIGNsYXNzPSJzcGlubmVyIiBjeD0iMjUiIGN5PSIyNSIgcj0iMjAiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNCIgc3Ryb2tlPSIjZTJlOGYwIiAvPgogIDxjaXJjbGUgY2xhc3M9InNwaW5uZXIgcGF0aCIgY3g9IjI1IiBjeT0iMjUiIHI9IjIwIiBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjQiIC8+Cjwvc3ZnPg==",
                anchor: [0.5, 0.5], // Centers horizontal axis, anchors bottom vertical axis
                scale: 1,
                crossOrigin: 'anonymous',
                // Icons must stay out of the declutter tree: a feature with a
                // marker shadow returns two styles (shadow + icon) at the same
                // position, and OpenLayers would otherwise declutter the icon
                // (and the label rendered with it) away, leaving only the
                // black shadow. Labels still declutter on their own.
                declutterMode: 'none',
            });

        var resStyle = new Style({
            image: markerIcon,
        });


        /// Texture from main type

        var typeResolved = this.m.markerTypes.get(type);

        if (typeResolved == null) {
            console.warn(`Unknown marker type "${type}"`);
            return resStyle;
        }

        var cachedTexture = this.m.markerTextures.get(typeResolved.icon);
        if (typeof cachedTexture === 'string') {
            markerIcon.setSrc(cachedTexture);
        } else {
            this.m.loadMarkerIcon(typeResolved.icon).then((iconData) => {
                if (!this.m.destroyed) {
                    markerIcon.setSrc(iconData);
                }
            }).catch(() => {
                // Keep the placeholder spinner if the icon could not be loaded
            });
        }

        // `color` is a CfgMarkerColors class name, or empty for the marker type's
        // own color. markerColors is keyed by class name, not by a hex value.
        // The custom color's alpha is applied as icon opacity (see
        // dynamicIconStyleFunction); the tint itself stays opaque.
        markerIcon.setColor(markerColorToOpaqueCss(this.m.resolveColorFor(type, color)));
        return resStyle;
    }
}