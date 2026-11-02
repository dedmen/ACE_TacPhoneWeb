/**
 * Parses the Map's `roads` SVG layer into routable polylines.
 *
 * The game's SVG export draws the road network as stroked paths. Filled
 * variants (`*Fill`) are the road surface, not the centerline, and are
 * skipped. The parser flips the SVG top-down Y to the map's bottom-up world Y;
 * missing that flip mirrors the whole road graph vertically. Only the path
 * commands used by the export are interpreted (`M/m`, `L/l`, `H/h`, `V/v`,
 * `Z/z`); a path with curves is kept up to the first unsupported command.
 */

export type RoadKind = 'main' | 'road' | 'track' | 'rail' | 'trail';

export interface RoadPolyline {
    points: Array<[number, number]>;
    /** Stroke width in world metres before the 2 m edge correction. */
    strokeWidth: number;
    /** Effective drivable width in metres. */
    width: number;
    kind: RoadKind;
    /** Stroke paint/class that classified the road, useful in debug mode. */
    paint: string;
}

const TOKEN = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function parsePathData(data: string): Array<Array<[number, number]>> {
    const paths: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    let command = '';

    const tokens: string[] = [];
    let match: RegExpExecArray | null;
    TOKEN.lastIndex = 0;
    while ((match = TOKEN.exec(data)) !== null) {
        tokens.push(match[1] ?? match[2]);
    }

    let index = 0;
    const number = (): number => {
        const value = Number(tokens[index]);
        index += 1;
        return Number.isFinite(value) ? value : 0;
    };
    const finish = (): void => {
        if (current.length >= 2) {
            paths.push(current);
        }
        current = [];
    };

    while (index < tokens.length) {
        const token = tokens[index];
        if (/^[a-zA-Z]$/.test(token)) {
            command = token;
            index += 1;
        }

        const absolute = command === command.toUpperCase();
        switch (command.toLowerCase()) {
            case 'm': {
                const nx = number();
                const ny = number();
                finish();
                x = absolute ? nx : x + nx;
                y = absolute ? ny : y + ny;
                startX = x;
                startY = y;
                current.push([x, y]);
                // Following pairs after M are implicit L.
                command = absolute ? 'L' : 'l';
                break;
            }
            case 'l': {
                const nx = number();
                const ny = number();
                x = absolute ? nx : x + nx;
                y = absolute ? ny : y + ny;
                current.push([x, y]);
                break;
            }
            case 'h': {
                const nx = number();
                x = absolute ? nx : x + nx;
                current.push([x, y]);
                break;
            }
            case 'v': {
                const ny = number();
                y = absolute ? ny : y + ny;
                current.push([x, y]);
                break;
            }
            case 'z': {
                if (current.length >= 2 && (x !== startX || y !== startY)) {
                    current.push([startX, startY]);
                }
                x = startX;
                y = startY;
                finish();
                break;
            }
            default:
                // Curves/arcs are not used by the road export; stop this
                // subpath instead of guessing its geometry.
                finish();
                command = '';
                index += 1;
                break;
        }
    }

    finish();
    return paths;
}

function attribute(element: Element, name: string): string {
    const direct = element.getAttribute(name);
    if (direct !== null) {
        return direct;
    }

    const style = element.getAttribute('style') ?? '';
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style);
    return match?.[1]?.trim() ?? '';
}

function classifyRoad(paint: string, width: number): RoadKind {
    const lower = paint.toLowerCase();
    if (lower.includes('rail')) {
        return 'rail';
    }
    if (lower.includes('track')) {
        return 'track';
    }
    if (width >= 10) {
        return 'main';
    }
    if (width >= 6) {
        return 'road';
    }
    if (width >= 3) {
        return 'track';
    }
    return 'trail';
}

/** Parses one roads-layer SVG document. Never throws on malformed input. */
export function parseRoadLayer(svg: string): RoadPolyline[] {
    if (typeof DOMParser === 'undefined' || svg.trim() === '') {
        return [];
    }

    let document: Document;
    try {
        document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    } catch {
        return [];
    }
    if (document.getElementsByTagName('parsererror').length > 0) {
        return [];
    }

    const result: RoadPolyline[] = [];
    const root = document.documentElement;
    const worldHeight = Number(root?.getAttribute('height') ?? Number.NaN);
    const flipY = Number.isFinite(worldHeight) && worldHeight > 0;

    for (const element of Array.from(document.getElementsByTagName('path'))) {
        const paint = `${attribute(element, 'stroke')} ${element.getAttribute('id') ?? ''} ${element.getAttribute('class') ?? ''}`;
        if (paint.trim() === '' || /fill/i.test(paint)) {
            continue;
        }

        const strokeWidth = Number(attribute(element, 'stroke-width'));
        if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) {
            continue;
        }

        const data = element.getAttribute('d') ?? '';
        if (data === '') {
            continue;
        }

        for (const points of parsePathData(data)) {
            if (points.length < 2) {
                continue;
            }
            result.push({
                // SVG Y is top-down; the map/world Y is bottom-up. Raster
                // masks and map tiles flip it, so the road graph must too.
                points: flipY
                    ? points.map(([x, y]) => [x, worldHeight - y] as [number, number])
                    : points,
                strokeWidth,
                width: Math.max(0, strokeWidth - 2),
                kind: classifyRoad(paint, strokeWidth),
                paint: paint.trim(),
            });
        }
    }

    return result;
}
