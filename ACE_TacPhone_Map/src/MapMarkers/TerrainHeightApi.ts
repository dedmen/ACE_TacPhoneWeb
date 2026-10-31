/**
 * Runtime check for a single map position: a pair of finite numbers.
 */
function isPoint(value: unknown): value is [number, number] {
    return (
        Array.isArray(value) &&
        typeof value[0] === 'number' &&
        Number.isFinite(value[0]) &&
        typeof value[1] === 'number' &&
        Number.isFinite(value[1])
    );
}

/**
 * Fetches the terrain height for every requested map position.
 *
 * The heights are in meters above sea level and come back in the same order as
 * the requested coordinates, which are in the map projection (the same
 * coordinate space the marker layer uses for its features).
 *
 * All positions are sent in a single request, so callers can batch a whole
 * polyline (or any other set of points) instead of asking for one height at a
 * time. The game side is the `getTerrainHeight` handler in
 * `fnc_processBrowserRequest.sqf`; it answers with an array of numbers, one per
 * position.
 *
 * Throws synchronously when the input is empty or contains anything that is not
 * a pair of finite numbers, and rejects when the game replies with an array of
 * the wrong length or with non-numeric entries. Errors are not caught or logged
 * here: the caller decides how to handle them.
 */
export function getTerrainHeights(
    positions: ReadonlyArray<readonly [number, number]>,
): Promise<number[]> {
    if (positions.length === 0) {
        throw new Error('At least one position is needed to fetch terrain heights');
    }
    if (!positions.every(isPoint)) {
        throw new Error('Terrain heights need valid positions');
    }

    // Fresh arrays so the caller's input is never mutated or shared.
    const requestPositions: number[][] = [];
    for (const position of positions) {
        requestPositions.push([position[0], position[1]]);
    }

    return window.TacPhone.networking.Request({
        a: 'ACE_TacPhone_Map',
        c: 'getTerrainHeight',
        positions: requestPositions,
    }).then((result) => {
        const heights = result as unknown;
        if (!Array.isArray(heights) || heights.length !== positions.length) {
            throw new Error('Game returned invalid terrain heights');
        }
        for (const height of heights) {
            if (typeof height !== 'number' || !Number.isFinite(height)) {
                throw new Error('Game returned invalid terrain heights');
            }
        }
        return heights as number[];
    });
}

/**
 * Terrain heights for the current page session, keyed by whole-meter map
 * coordinate. Terrain does not change while the page is open, so a point only
 * has to be requested once, even across drawing previews and marker overlays.
 */
const terrainHeightCache = new Map<string, number>();

function terrainHeightKey(x: number, y: number): string {
    return `${Math.round(x)},${Math.round(y)}`;
}

export function getCachedTerrainHeight(x: number, y: number): number | undefined {
    return terrainHeightCache.get(terrainHeightKey(x, y));
}

export function setCachedTerrainHeight(x: number, y: number, height: number): void {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(height)) {
        terrainHeightCache.set(terrainHeightKey(x, y), height);
    }
}

/**
 * Resolves heights using the shared cache and one batched request for the
 * missing positions. Returns one height per input position (or null when the
 * input is invalid). Rejects only when the batched game request fails.
 */
export async function resolveTerrainHeights(
    positions: ReadonlyArray<readonly [number, number]>,
): Promise<Array<number | null>> {
    const results: Array<number | null> = positions.map(() => null);
    const missingPositions: Array<[number, number]> = [];
    const missingIndices: number[] = [];

    for (let index = 0; index < positions.length; index++) {
        const position = positions[index];
        if (!isPoint(position)) {
            continue;
        }

        const cached = getCachedTerrainHeight(position[0], position[1]);
        if (cached !== undefined) {
            results[index] = cached;
        } else {
            missingPositions.push([position[0], position[1]]);
            missingIndices.push(index);
        }
    }

    if (missingPositions.length === 0) {
        return results;
    }

    const heights = await getTerrainHeights(missingPositions);
    for (let index = 0; index < heights.length; index++) {
        const height = heights[index];
        const position = missingPositions[index];
        const targetIndex = missingIndices[index];
        results[targetIndex] = height;
        setCachedTerrainHeight(position[0], position[1], height);
    }

    return results;
}
