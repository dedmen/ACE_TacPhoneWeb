/**
 * Small weighted A* search shared by the terrain grid and the road graph.
 *
 * The implementation is deliberately dependency-free: the app bundles a
 * single ESM file, and the search core is too small to justify a pathfinding
 * package. Costs are "seconds to traverse"; the heuristic must be admissible
 * (straight-line distance divided by the fastest allowed speed).
 */

/** One outgoing edge of a graph node. */
export interface AStarEdge<T> {
    node: T;
    /** Non-negative traversal cost. */
    cost: number;
}

/** The graph callbacks A* needs. */
export interface AStarGraph<T> {
    /** Neighbours of a node, with their edge costs. */
    neighbors(node: T): Iterable<AStarEdge<T>>;
    /** Admissible estimate of the remaining cost. */
    heuristic(node: T): number;
}

/** Options for {@link aStar}. */
export interface AStarOptions<T> {
    /** Stable key for a node; defaults to `String(node)`. */
    key?(node: T): string | number;
    /** Returns true when the search was cancelled. */
    cancelled?(): boolean;
    /** Hard iteration cap; defaults to 2,000,000. */
    maxIterations?: number;
}

/** Binary min-heap keyed by priority. */
export class MinHeap<T> {
    private readonly items: Array<{ value: T; priority: number }> = [];

    public get size(): number {
        return this.items.length;
    }

    public push(value: T, priority: number): void {
        const items = this.items;
        items.push({ value, priority });
        let index = items.length - 1;

        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (items[parent].priority <= items[index].priority) {
                break;
            }
            [items[parent], items[index]] = [items[index], items[parent]];
            index = parent;
        }
    }

    public pop(): T | undefined {
        const items = this.items;
        if (items.length === 0) {
            return undefined;
        }

        const root = items[0].value;
        const last = items.pop();

        if (last && items.length > 0) {
            items[0] = last;
            let index = 0;

            while (true) {
                const left = index * 2 + 1;
                const right = left + 1;
                let smallest = index;

                if (left < items.length && items[left].priority < items[smallest].priority) {
                    smallest = left;
                }
                if (right < items.length && items[right].priority < items[smallest].priority) {
                    smallest = right;
                }
                if (smallest === index) {
                    break;
                }

                [items[index], items[smallest]] = [items[smallest], items[index]];
                index = smallest;
            }
        }

        return root;
    }
}

/**
 * Finds the cheapest path from `start` to `goal`.
 *
 * Returns the node sequence including both ends, or `null` when no path
 * exists, the search was cancelled, or the iteration cap was reached.
 */
export function aStar<T>(
    start: T,
    goal: T,
    graph: AStarGraph<T>,
    options: AStarOptions<T> = {},
): T[] | null {
    const key = options.key ?? ((node: T): string => String(node));
    const startKey = key(start);
    const goalKey = key(goal);
    const maxIterations = options.maxIterations ?? 2_000_000;

    const open = new MinHeap<T>();
    const gScore = new Map<string | number, number>();
    const cameFrom = new Map<string | number, T>();
    const closed = new Set<string | number>();

    gScore.set(startKey, 0);
    open.push(start, graph.heuristic(start));

    let iterations = 0;

    while (open.size > 0) {
        const current = open.pop();
        if (current === undefined) {
            break;
        }

        const currentKey = key(current);
        if (closed.has(currentKey)) {
            continue;
        }
        if (currentKey === goalKey) {
            const path: T[] = [current];
            let cursor: T | undefined = current;
            while (cursor !== undefined) {
                const previous = cameFrom.get(key(cursor));
                if (previous === undefined) {
                    break;
                }
                path.push(previous);
                cursor = previous;
            }
            path.reverse();
            return path;
        }

        closed.add(currentKey);
        iterations += 1;
        if (iterations > maxIterations || options.cancelled?.() === true) {
            return null;
        }

        const currentScore = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;

        for (const edge of graph.neighbors(current)) {
            if (!(edge.cost >= 0) || !Number.isFinite(edge.cost)) {
                continue;
            }

            const nextKey = key(edge.node);
            if (closed.has(nextKey)) {
                continue;
            }

            const tentative = currentScore + edge.cost;
            const existing = gScore.get(nextKey) ?? Number.POSITIVE_INFINITY;
            if (tentative >= existing) {
                continue;
            }

            gScore.set(nextKey, tentative);
            cameFrom.set(nextKey, current);
            open.push(edge.node, tentative + graph.heuristic(edge.node));
        }
    }

    return null;
}
