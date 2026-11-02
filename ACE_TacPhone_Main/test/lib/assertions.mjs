/**
 * Tiny assertion helpers and the sequential scenario runner for the TacPhone
 * host test suite.
 *
 * The helpers exist so a failed live test says what was expected and what the
 * game actually sent. They use `node:util` only; there are no test framework
 * dependencies.
 */

import { isDeepStrictEqual, inspect } from 'node:util';

/** Failure raised by every assertion helper. */
export class AssertionError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'AssertionError';
        this.details = details;
    }
}

/** Formats a value for a readable failure message. */
export function formatValue(value, depth = 5) {
    return inspect(value, {
        depth,
        colors: false,
        breakLength: 120,
        compact: 3,
        sorted: false,
    });
}

/** Always throws. Use for branches that should be unreachable. */
export function fail(message = 'Assertion failed') {
    throw new AssertionError(message);
}

/** Asserts that `condition` is truthy. */
export function assert(condition, message = 'Expected a truthy value') {
    if (!condition) {
        throw new AssertionError(`${message}\n  received: ${formatValue(condition)}`);
    }

    return condition;
}

/** Alias with the common `ok(value)` name. */
export function ok(value, message = 'Expected a truthy value') {
    return assert(value, message);
}

/** Asserts strict equality (`Object.is`). */
export function equal(actual, expected, message = 'Values are not equal') {
    if (!Object.is(actual, expected)) {
        throw new AssertionError(
            `${message}\n  expected: ${formatValue(expected)}\n  actual:   ${formatValue(actual)}`,
            { actual, expected },
        );
    }

    return actual;
}

/** Asserts strict inequality. */
export function notEqual(actual, expected, message = 'Values should differ') {
    if (Object.is(actual, expected)) {
        throw new AssertionError(
            `${message}\n  both values: ${formatValue(actual)}`,
            { actual, expected },
        );
    }

    return actual;
}

/** Asserts a deep, structural equality of JSON-like values. */
export function deepEqual(actual, expected, message = 'Values are not deeply equal') {
    if (!isDeepStrictEqual(actual, expected)) {
        throw new AssertionError(
            `${message}\n  expected: ${formatValue(expected)}\n  actual:   ${formatValue(actual)}`,
            { actual, expected },
        );
    }

    return actual;
}

/** Asserts that an array/string/Map/Set contains a value. */
export function includes(collection, value, message = 'Collection does not include the value') {
    let found = false;

    if (typeof collection === 'string') {
        found = collection.includes(String(value));
    } else if (Array.isArray(collection)) {
        found = collection.some(item => Object.is(item, value));
    } else if (collection instanceof Set) {
        found = collection.has(value);
    } else if (collection instanceof Map) {
        found = collection.has(value);
    } else {
        throw new AssertionError(
            `${message}\n  collection is not array/string/Map/Set: ${formatValue(collection)}`,
        );
    }

    if (!found) {
        throw new AssertionError(
            `${message}\n  missing:  ${formatValue(value)}\n  in:       ${formatValue(collection)}`,
            { collection, value },
        );
    }

    return collection;
}

/** Asserts `typeof value === type`. */
export function isType(value, type, message = `Expected a ${type}`) {
    if (typeof value !== type) {
        throw new AssertionError(`${message}\n  actual: ${formatValue(value)}`);
    }

    return value;
}

export function isString(value, message = 'Expected a string') {
    return isType(value, 'string', message);
}

export function isNumber(value, message = 'Expected a number') {
    return isType(value, 'number', message);
}

export function isBoolean(value, message = 'Expected a boolean') {
    return isType(value, 'boolean', message);
}

export function isArray(value, message = 'Expected an array') {
    if (!Array.isArray(value)) {
        throw new AssertionError(`${message}\n  actual: ${formatValue(value)}`);
    }

    return value;
}

export function isObject(value, message = 'Expected a non-null object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AssertionError(`${message}\n  actual: ${formatValue(value)}`);
    }

    return value;
}

/** Asserts the value is one of the allowed values. */
export function oneOf(value, allowed, message = 'Value is not one of the allowed values') {
    if (!allowed.includes(value)) {
        throw new AssertionError(
            `${message}\n  allowed: ${formatValue(allowed)}\n  actual:  ${formatValue(value)}`,
            { value, allowed },
        );
    }

    return value;
}

/** Asserts an object has all listed own keys. */
export function hasKeys(object, keys, message = 'Object is missing expected keys') {
    isObject(object, `${message}: object check`);

    const missing = keys.filter(key => !(key in object));

    if (missing.length > 0) {
        throw new AssertionError(
            `${message}\n  missing: ${formatValue(missing)}\n  object:  ${formatValue(object)}`,
            { object, keys, missing },
        );
    }

    return object;
}

/** Asserts a string matches a regular expression. */
export function matchString(value, expression, message = 'String does not match') {
    isString(value, `${message}: string check`);

    if (!expression.test(value)) {
        throw new AssertionError(
            `${message}\n  pattern: ${String(expression)}\n  actual:  ${formatValue(value)}`,
            { value, expression },
        );
    }

    return value;
}

function indent(text, prefix) {
    return String(text)
        .split('\n')
        .map(line => `${prefix}${line}`)
        .join('\n');
}

function printFailure(error) {
    if (error instanceof AssertionError) {
        console.error(indent(error.message, '  '));
        return;
    }

    console.error(indent(error?.stack || String(error), '  '));
}

/**
 * Runs scenario modules sequentially and prints a PASS/FAIL line for each.
 *
 * A scenario module exports `name`, an optional `description`, and
 * `async run(context)`. The runner never aborts on a failed scenario; every
 * scenario sees the same context, so one failure does not hide later ones.
 *
 * @param {Array<{name: string, description?: string, run: Function}>} scenarios
 * @param {object} context Passed to every `run()` unchanged.
 * @param {{ title?: string }} [options]
 */
export async function runSuite(scenarios, context, options = {}) {
    const title = options.title || 'TacPhone host test suite';
    const suiteStartedAt = Date.now();
    const failures = [];
    let passed = 0;
    let skipped = 0;

    console.log(`\n${title}`);
    console.log(`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} queued.\n`);

    for (const scenario of scenarios) {
        const label = scenario?.name || 'unnamed scenario';
        const startedAt = Date.now();

        try {
            if (!scenario || typeof scenario.run !== 'function') {
                throw new Error('Scenario module must export an async run(context) function.');
            }

            await scenario.run(context);
            passed += 1;
            console.log(`PASS ${label} (${Date.now() - startedAt} ms)`);
        } catch (error) {
            if (error?.name === 'SkipError') {
                skipped += 1;
                console.log(`SKIP ${label}: ${error.message}`);
                continue;
            }
            failures.push({ label, error });
            console.log(`FAIL ${label} (${Date.now() - startedAt} ms)`);
            printFailure(error);
        }
    }

    const duration = Date.now() - suiteStartedAt;
    const failed = failures.length;

    console.log(
        `\n${passed} passed, ${failed} failed, ${skipped} skipped, ${scenarios.length} total (${duration} ms)`,
    );

    if (failed > 0) {
        console.log('Failed scenarios:');
        for (const failure of failures) {
            console.log(`  - ${failure.label}`);
        }
    }

    return { passed, failed, skipped, total: scenarios.length, duration, failures };
}
