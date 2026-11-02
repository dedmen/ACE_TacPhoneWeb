/**
 * Width-aware routing graph built from the parsed road polylines.
 *
 * The game exports centerlines without shared vertices, so simple
 * endpoint-to-endpoint joining is not enough: nearby endpoints are snapped to
 * each other and to the nearest segment, splitting that segment at the
 * projection. Road width decides the snap tolerance; a wide main road accepts
 * a slightly larger gap than a narrow trail.
 */

import { aStar, type AStarEdge, type AStarGraph } from '../routing/AStar';
import type { RoadKind, RoadPolyline } from './RoadSvgParser';

export interface RoadPath {
    points: Array<[number, number]>;
    kinds: RoadKind[];
    /** Total path length in metres. */
    length: number;
}

interface RawSegment {
    a: number;
    b: number;
    kind: RoadKind;
    width: number;
    length: number;
}

interface Node {
    point: [number, number];
}

interface Edge {
    to: number;
    length: number;
    kind: RoadKind;
}

/** Nodes are merged on a 0.5 m grid; enough for SVG export noise, small
 * enough that two nearby roads are not collapsed into one. */
const NODE_GRID_M = 0.5;
const MAX_SNAP_M = 60;
const MIN_SNAP_M = 4;
/** Spatial cell for the junction lookup; must be at least the query radius. */
const JUNCTION_CELL_M = 32;
/** Minimally different branch bearings for a junction, degrees. */
const JUNCTION_MIN_ANGLE_DEG = 25;

function distance(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(bx - ax, by - ay);
}

/** Smallest angle between two bearings, 0..180 degrees. */
function angleDifference(a: number, b: number): number {
    return Math.abs(((a - b + 540) % 360) - 180);
}

function nodeKey(point: [number, number]): string {
    return `${Math.round(point[0] / NODE_GRID_M)},${Math.round(point[1] / NODE_GRID_M)}`;
}

function projectOnSegment(
    point: [number, number],
    a: [number, number],
    b: [number, number],
): { x: number; y: number; t: number; distance: number } {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return { x: a[0], y: a[1], t: 0, distance: distance(point[0], point[1], a[0], a[1]) };
    }

    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    const x = a[0] + dx * t;
    const y = a[1] + dy * t;
    return { x, y, t, distance: distance(point[0], point[1], x, y) };
}

interface LineIntersection {
    x: number;
    y: number;
    t: number;
    u: number;
}

function segmentIntersection(
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
): LineIntersection | null {
    const rx = b[0] - a[0];
    const ry = b[1] - a[1];
    const sx = d[0] - c[0];
    const sy = d[1] - c[1];
    const denominator = rx * sy - ry * sx;

    if (Math.abs(denominator) < 1e-9) {
        return null;
    }

    const qpx = c[0] - a[0];
    const qpy = c[1] - a[1];
    const t = (qpx * sy - qpy * sx) / denominator;
    const u = (qpx * ry - qpy * rx) / denominator;

    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) {
        return null;
    }

    return { x: a[0] + rx * t, y: a[1] + ry * t, t, u };
}

/** Routing graph over the parsed road network. */
export class RoadNetwork {
    private readonly nodes: Node[] = [];
    private readonly nodeIds = new Map<string, number>();
    private readonly adjacency = new Map<number, Edge[]>();
    private readonly segments: RawSegment[] = [];
    /** Spatial index over node ids, for fast junction queries. */
    private readonly nodeGrid = new Map<string, number[]>();

    public readonly polylineCount: number;

    constructor(polylines: readonly RoadPolyline[]) {
        this.polylineCount = polylines.length;
        const endpoints: Array<{ node: number; kind: RoadKind; width: number }> = [];

        for (const polyline of polylines) {
            let previous: number | null = null;
            for (const point of polyline.points) {
                const node = this.nodeFor(point);
                if (previous !== null) {
                    this.addSegment(previous, node, polyline.kind, polyline.width);
                }
                previous = node;
            }
            if (polyline.points.length >= 2) {
                endpoints.push({
                    node: this.nodeFor(polyline.points[0]),
                    kind: polyline.kind,
                    width: polyline.width,
                });
                endpoints.push({
                    node: this.nodeFor(polyline.points[polyline.points.length - 1]),
                    kind: polyline.kind,
                    width: polyline.width,
                });
            }
        }

        this.splitCrossings();
        this.snapEndpoints(endpoints);
        this.connectNearbyNodes();
        this.buildAdjacency();
    }

    public get nodeCount(): number {
        return this.nodes.length;
    }

    public get segmentCount(): number {
        return this.segments.length;
    }

    /** Nearest graph node within `maxDistance`, or null. */
    public nearestNode(point: [number, number], maxDistance = 150): number | null {
        let best: number | null = null;
        let bestDistance = maxDistance;

        for (let index = 0; index < this.nodes.length; index += 1) {
            const node = this.nodes[index].point;
            const current = distance(point[0], point[1], node[0], node[1]);
            if (current <= bestDistance) {
                bestDistance = current;
                best = index;
            }
        }

        return best;
    }

    /** Nearest endpoint of a segment whose class is in `kinds`, or null. */
    public nearestNodeOnRoad(
        point: [number, number],
        maxDistance: number,
        kinds: readonly RoadKind[],
    ): number | null {
        const allowed = new Set(kinds);
        let best: number | null = null;
        let bestDistance = maxDistance;

        for (const segment of this.segments) {
            if (!allowed.has(segment.kind)) {
                continue;
            }
            for (const nodeIndex of [segment.a, segment.b]) {
                const node = this.nodes[nodeIndex].point;
                const current = distance(point[0], point[1], node[0], node[1]);
                if (current <= bestDistance) {
                    bestDistance = current;
                    best = nodeIndex;
                }
            }
        }

        return best;
    }

    public nodePoint(index: number): [number, number] | null {
        return this.nodes[index]?.point ?? null;
    }

    /** All node positions, for debug/waypoint finding. */
    public nodePoints(): Array<[number, number]> {
        return this.nodes.map((node) => [node.point[0], node.point[1]]);
    }

    /**
     * Position of the nearest real junction node within `radius`, or null.
     *
     * A junction has road branches in at least three different directions;
     * that is a crossing/T-junction. A bend, two road ends meeting
     * head-to-head, or an end joined to the interior of the same road (a split
     * made by snapping) only has two directions.
     *
     * The node position is stable across fixes, so callers can use it as the
     * identity of the junction.
     */
    public junctionPoint(point: [number, number], radius = 15): [number, number] | null {
        let best: [number, number] | null = null;
        let bestDistance = radius;

        for (const index of this.nodesWithin(point, radius)) {
            const origin = this.nodes[index].point;
            const directions: number[] = [];

            for (const edge of this.adjacency.get(index) ?? []) {
                if (edge.length <= 0.1) {
                    continue;
                }
                const target = this.nodes[edge.to].point;
                const angle = (Math.atan2(target[1] - origin[1], target[0] - origin[0])
                    * 180 / Math.PI + 360) % 360;
                // Collapse duplicate/split edges that point the same way.
                if (!directions.some((existing) => angleDifference(existing, angle) < JUNCTION_MIN_ANGLE_DEG)) {
                    directions.push(angle);
                }
            }

            if (directions.length < 3) {
                continue;
            }

            const current = distance(point[0], point[1], origin[0], origin[1]);
            if (current <= bestDistance) {
                bestDistance = current;
                best = [origin[0], origin[1]];
            }
        }

        return best;
    }

    /** True when {@link junctionPoint} finds a junction within `radius`. */
    public isJunction(point: [number, number], radius = 15): boolean {
        return this.junctionPoint(point, radius) !== null;
    }

    /**
     * Snaps a world point to the closest point **along a road segment**,
     * splitting that segment so the graph can start/end there instead of at an
     * arbitrary intersection. Returns the graph node, or null.
     */
    public snapToSegment(
        point: [number, number],
        maxDistance: number,
        kinds?: readonly RoadKind[],
    ): number | null {
        const allowed = kinds ? new Set(kinds) : null;
        let bestIndex = -1;
        let bestProjection: ReturnType<typeof projectOnSegment> | null = null;

        for (let index = 0; index < this.segments.length; index += 1) {
            const segment = this.segments[index];
            if (allowed && !allowed.has(segment.kind)) {
                continue;
            }
            const a = this.nodes[segment.a].point;
            const b = this.nodes[segment.b].point;
            const projection = projectOnSegment(point, a, b);
            if (projection.distance > maxDistance) {
                continue;
            }
            if (bestProjection === null || projection.distance < bestProjection.distance) {
                bestProjection = projection;
                bestIndex = index;
            }
        }

        if (bestProjection === null || bestIndex < 0) {
            return null;
        }

        const segment = this.segments[bestIndex];
        if (bestProjection.t <= 0.02) {
            return segment.a;
        }
        if (bestProjection.t >= 0.98) {
            return segment.b;
        }

        const split = this.nodeFor([bestProjection.x, bestProjection.y]);
        const a = this.nodes[segment.a].point;
        const b = this.nodes[segment.b].point;
        const first = {
            a: segment.a,
            b: split,
            kind: segment.kind,
            width: segment.width,
            length: distance(a[0], a[1], bestProjection.x, bestProjection.y),
        };
        const second = {
            a: split,
            b: segment.b,
            kind: segment.kind,
            width: segment.width,
            length: distance(bestProjection.x, bestProjection.y, b[0], b[1]),
        };
        this.segments.splice(bestIndex, 1, first, second);
        this.buildAdjacency();
        return split;
    }

    /**
     * Finds a road path between two points.
     * `speed` returns metres per second for a road edge; 0 means unusable.
     * The endpoints are passed so the caller can apply the slope model.
     */
    public findPath(
        start: [number, number],
        goal: [number, number],
        speed: (kind: RoadKind, a: [number, number], b: [number, number]) => number,
        cancelled?: () => boolean,
        maxSnapM = 500,
    ): RoadPath | null {
        const startNode = this.nearestNode(start, maxSnapM);
        const goalNode = this.nearestNode(goal, maxSnapM);
        if (startNode === null || goalNode === null) {
            return null;
        }
        return this.findPathNodes(startNode, goalNode, speed, cancelled);
    }

    /** A* between two graph nodes; the caller owns the snapping policy. */
    public findPathNodes(
        startNode: number,
        goalNode: number,
        speed: (kind: RoadKind, a: [number, number], b: [number, number]) => number,
        cancelled?: () => boolean,
    ): RoadPath | null {
        const goalPoint = this.nodes[goalNode]?.point;
        if (!goalPoint) {
            return null;
        }

        const level: [number, number] = [0, 0];
        const maxSpeed = Math.max(
            0.5,
            ...(['main', 'road', 'track', 'rail', 'trail'] as RoadKind[])
                .map((kind) => speed(kind, level, level)),
        );
        const graph: AStarGraph<number> = {
            neighbors: (node): Iterable<AStarEdge<number>> => {
                const edges = this.adjacency.get(node) ?? [];
                const result: AStarEdge<number>[] = [];
                const from = this.nodes[node].point;
                for (const edge of edges) {
                    const edgeSpeed = speed(edge.kind, from, this.nodes[edge.to].point);
                    if (edgeSpeed > 0) {
                        result.push({ node: edge.to, cost: edge.length / edgeSpeed });
                    }
                }
                return result;
            },
            heuristic: (node): number => {
                const point = this.nodes[node]?.point;
                if (!point) {
                    return 0;
                }
                return distance(point[0], point[1], goalPoint[0], goalPoint[1]) / maxSpeed;
            },
        };

        const path = aStar(startNode, goalNode, graph, { cancelled });
        if (!path) {
            return null;
        }

        const points: Array<[number, number]> = [];
        const kinds: RoadKind[] = [];
        let length = 0;

        for (let index = 0; index + 1 < path.length; index += 1) {
            const from = path[index];
            const to = path[index + 1];
            const edge = (this.adjacency.get(from) ?? []).find((candidate) => candidate.to === to);
            if (!edge) {
                return null;
            }

            const fromPoint = this.nodes[from].point;
            const toPoint = this.nodes[to].point;
            if (points.length === 0) {
                points.push(fromPoint);
            }
            points.push(toPoint);
            kinds.push(edge.kind);
            length += edge.length;
        }

        return points.length >= 2 ? { points, kinds, length } : null;
    }

    private nodeFor(point: [number, number]): number {
        const key = nodeKey(point);
        const existing = this.nodeIds.get(key);
        if (existing !== undefined) {
            return existing;
        }

        const id = this.nodes.length;
        this.nodes.push({ point: [point[0], point[1]] });
        this.nodeIds.set(key, id);
        this.indexNode(id);
        return id;
    }

    private indexNode(index: number): void {
        const point = this.nodes[index].point;
        const key = `${Math.floor(point[0] / JUNCTION_CELL_M)},${Math.floor(point[1] / JUNCTION_CELL_M)}`;
        const bucket = this.nodeGrid.get(key) ?? [];
        bucket.push(index);
        this.nodeGrid.set(key, bucket);
    }

    private nodesWithin(point: [number, number], radius: number): number[] {
        const found: number[] = [];
        const minX = Math.floor((point[0] - radius) / JUNCTION_CELL_M);
        const maxX = Math.floor((point[0] + radius) / JUNCTION_CELL_M);
        const minY = Math.floor((point[1] - radius) / JUNCTION_CELL_M);
        const maxY = Math.floor((point[1] + radius) / JUNCTION_CELL_M);

        for (let x = minX; x <= maxX; x += 1) {
            for (let y = minY; y <= maxY; y += 1) {
                for (const index of this.nodeGrid.get(`${x},${y}`) ?? []) {
                    const node = this.nodes[index].point;
                    if (distance(point[0], point[1], node[0], node[1]) <= radius) {
                        found.push(index);
                    }
                }
            }
        }

        return found;
    }

    private addSegment(a: number, b: number, kind: RoadKind, width: number): void {
        if (a === b) {
            return;
        }
        const pa = this.nodes[a].point;
        const pb = this.nodes[b].point;
        this.segments.push({
            a,
            b,
            kind,
            width,
            length: distance(pa[0], pa[1], pb[0], pb[1]),
        });
    }

    /** Splits segments at real crossings (roads with no shared vertex). */
    private splitCrossings(): void {
        const cellSize = 100;
        const grid = new Map<string, number[]>();
        const bboxCells = (segment: RawSegment): string[] => {
            const a = this.nodes[segment.a].point;
            const b = this.nodes[segment.b].point;
            const minX = Math.floor(Math.min(a[0], b[0]) / cellSize);
            const maxX = Math.floor(Math.max(a[0], b[0]) / cellSize);
            const minY = Math.floor(Math.min(a[1], b[1]) / cellSize);
            const maxY = Math.floor(Math.max(a[1], b[1]) / cellSize);
            const keys: string[] = [];
            for (let x = minX; x <= maxX; x += 1) {
                for (let y = minY; y <= maxY; y += 1) {
                    keys.push(`${x},${y}`);
                }
            }
            return keys;
        };

        for (let index = 0; index < this.segments.length; index += 1) {
            for (const key of bboxCells(this.segments[index])) {
                const bucket = grid.get(key) ?? [];
                bucket.push(index);
                grid.set(key, bucket);
            }
        }

        const splits = new Map<number, LineIntersection[]>();
        const addSplit = (index: number, hit: LineIntersection, t: number): void => {
            const list = splits.get(index) ?? [];
            if (!list.some((entry) => Math.abs(entry.t - t) < 1e-6)) {
                list.push({ ...hit, t });
                splits.set(index, list);
            }
        };

        for (let index = 0; index < this.segments.length; index += 1) {
            const first = this.segments[index];
            const a = this.nodes[first.a].point;
            const b = this.nodes[first.b].point;
            const candidates = new Set<number>();
            for (const key of bboxCells(first)) {
                for (const other of grid.get(key) ?? []) {
                    if (other > index) {
                        candidates.add(other);
                    }
                }
            }

            for (const otherIndex of candidates) {
                const second = this.segments[otherIndex];
                if (second.a === first.a || second.a === first.b || second.b === first.a || second.b === first.b) {
                    continue;
                }
                const c = this.nodes[second.a].point;
                const d = this.nodes[second.b].point;
                const hit = segmentIntersection(a, b, c, d);
                if (!hit) {
                    continue;
                }

                const distanceToEnds = Math.min(
                    distance(hit.x, hit.y, a[0], a[1]),
                    distance(hit.x, hit.y, b[0], b[1]),
                    distance(hit.x, hit.y, c[0], c[1]),
                    distance(hit.x, hit.y, d[0], d[1]),
                );
                if (distanceToEnds < 0.5) {
                    continue;
                }

                addSplit(index, { x: hit.x, y: hit.y, t: hit.t, u: hit.u }, hit.t);
                addSplit(otherIndex, { x: hit.x, y: hit.y, t: hit.u, u: hit.t }, hit.u);
            }
        }

        if (splits.size === 0) {
            return;
        }

        const next: RawSegment[] = [];
        for (let index = 0; index < this.segments.length; index += 1) {
            const segment = this.segments[index];
            const points = splits.get(index) ?? [];
            if (points.length === 0) {
                next.push(segment);
                continue;
            }

            points.sort((left, right) => left.t - right.t);
            let previousNode = segment.a;
            let previousPoint = this.nodes[segment.a].point;

            for (const split of points) {
                const splitNode = this.nodeFor([split.x, split.y]);
                next.push({
                    a: previousNode,
                    b: splitNode,
                    kind: segment.kind,
                    width: segment.width,
                    length: distance(previousPoint[0], previousPoint[1], split.x, split.y),
                });
                previousNode = splitNode;
                previousPoint = [split.x, split.y];
            }

            next.push({
                a: previousNode,
                b: segment.b,
                kind: segment.kind,
                width: segment.width,
                length: distance(previousPoint[0], previousPoint[1], this.nodes[segment.b].point[0], this.nodes[segment.b].point[1]),
            });
        }

        this.segments.length = 0;
        this.segments.push(...next);
    }

    private snapEndpoints(endpoints: Array<{ node: number; kind: RoadKind; width: number }>): void {
        // Endpoint to endpoint: cheap and covers most exported connection gaps.
        for (let i = 0; i < endpoints.length; i += 1) {
            const first = endpoints[i];
            const firstPoint = this.nodes[first.node].point;

            for (let j = i + 1; j < endpoints.length; j += 1) {
                const second = endpoints[j];
                if (first.node === second.node) {
                    continue;
                }

                const tolerance = Math.min(
                    MAX_SNAP_M,
                    Math.max(MIN_SNAP_M, (first.width + second.width) / 2 + 2),
                );
                const secondPoint = this.nodes[second.node].point;
                if (distance(firstPoint[0], firstPoint[1], secondPoint[0], secondPoint[1]) <= tolerance) {
                    this.addSegment(
                        first.node,
                        second.node,
                        first.width >= second.width ? first.kind : second.kind,
                        Math.max(first.width, second.width),
                    );
                }
            }
        }

        // Endpoint to segment: split the target at the projection point.
        for (const endpoint of endpoints) {
            const point = this.nodes[endpoint.node].point;

            for (let index = 0; index < this.segments.length; index += 1) {
                const segment = this.segments[index];
                if (segment.a === endpoint.node || segment.b === endpoint.node) {
                    continue;
                }

                const a = this.nodes[segment.a].point;
                const b = this.nodes[segment.b].point;
                const projection = projectOnSegment(point, a, b);
                const tolerance = Math.min(
                    MAX_SNAP_M,
                    Math.max(MIN_SNAP_M, (endpoint.width + segment.width) / 2 + 2),
                );

                if (
                    projection.distance > tolerance
                    || projection.t <= 0.02
                    || projection.t >= 0.98
                ) {
                    continue;
                }

                const split = this.nodeFor([projection.x, projection.y]);
                this.segments[index] = {
                    a: segment.a,
                    b: split,
                    kind: segment.kind,
                    width: segment.width,
                    length: distance(a[0], a[1], projection.x, projection.y),
                };
                this.segments.push({
                    a: split,
                    b: segment.b,
                    kind: segment.kind,
                    width: segment.width,
                    length: distance(projection.x, projection.y, b[0], b[1]),
                });
                this.addSegment(
                    endpoint.node,
                    split,
                    endpoint.kind,
                    Math.max(endpoint.width, segment.width),
                );
                break;
            }
        }
    }

    /**
     * Bridges tiny gaps left by the SVG export (duplicate nodes at junctions)
     * without inventing long shortcuts across open terrain.
     */
    private connectNearbyNodes(): void {
        const maxDistance = 60;
        const cellSize = maxDistance * 2;
        const grid = new Map<string, number[]>();
        const keyFor = (x: number, y: number): string =>
            `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;

        for (let index = 0; index < this.nodes.length; index += 1) {
            const point = this.nodes[index].point;
            const key = keyFor(point[0], point[1]);
            const bucket = grid.get(key) ?? [];
            bucket.push(index);
            grid.set(key, bucket);
        }

        const existing = new Set<string>();
        const degree = new Uint16Array(this.nodes.length);
        for (const segment of this.segments) {
            existing.add(`${Math.min(segment.a, segment.b)}:${Math.max(segment.a, segment.b)}`);
            degree[segment.a] += 1;
            degree[segment.b] += 1;
        }

        for (let index = 0; index < this.nodes.length; index += 1) {
            const point = this.nodes[index].point;
            const cellX = Math.floor(point[0] / cellSize);
            const cellY = Math.floor(point[1] / cellSize);

            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    for (const other of grid.get(`${cellX + dx},${cellY + dy}`) ?? []) {
                        if (other <= index) {
                            continue;
                        }
                        // Only a dangling road end may bridge a gap. Joining two
                        // interior nodes creates shortcuts between parallel
                        // roads and makes the graph zigzag across lanes.
                        if (degree[index] > 1 && degree[other] > 1) {
                            continue;
                        }
                        const pair = `${index}:${other}`;
                        if (existing.has(pair)) {
                            continue;
                        }
                        const otherPoint = this.nodes[other].point;
                        if (distance(point[0], point[1], otherPoint[0], otherPoint[1]) <= maxDistance) {
                            this.addSegment(index, other, 'road', 6);
                            existing.add(pair);
                        }
                    }
                }
            }
        }
    }

    private buildAdjacency(): void {
        for (const segment of this.segments) {
            if (segment.length <= 0) {
                continue;
            }

            const forward = this.adjacency.get(segment.a) ?? [];
            forward.push({ to: segment.b, length: segment.length, kind: segment.kind });
            this.adjacency.set(segment.a, forward);

            const backward = this.adjacency.get(segment.b) ?? [];
            backward.push({ to: segment.a, length: segment.length, kind: segment.kind });
            this.adjacency.set(segment.b, backward);
        }
    }
}

