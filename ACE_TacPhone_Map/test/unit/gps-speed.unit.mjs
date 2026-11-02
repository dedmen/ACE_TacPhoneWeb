/**
 * Unit tests for the GPS speed model (`legSpeed` in `routing/SpeedModel.ts`).
 *
 * The model is what every ETA in the app is built from: the HUD countdown, the
 * route summary, the advisor comparison and the shared-route per-leg eta. It is
 * pure, so the whole table is pinned here instead of being inferred from a
 * live route.
 *
 * Every case documents the formula it pins; comparisons are relative (1e-9) so
 * they do not depend on float formatting.
 */

import { equal, ok, fail } from '../../../ACE_TacPhone_Main/test/lib/assertions.mjs';
import {
    FOOT_MAX_RUN_SLOPE,
    FOOT_MIN_RUN_SLOPE,
    FOOT_SPEED,
    FOOT_WALK_SPEED,
    footSpeed,
    legSpeed,
    MAX_GROUND_SLOPE,
} from '../../src/routing/SpeedModel.ts';

export const name = 'gps-speed';
export const description = 'legSpeed speed model: maxSpeed caps, climb, water, surfaces';

// Constants mirrored from routing/SpeedModel.ts (a change there must show up here).
const SWIM_SPEED = 0.5;
const NOMINAL_AIR = 55;
const NOMINAL_BOAT = 8;
const NOMINAL_ROAD = 12;
const AVERAGE_SPEED_FACTOR = 0.8;
const DRIVETRAIN_EFFICIENCY = 0.85;
const GRAVITY = 9.81;
const ROAD_ROLLING = 0.015;
const OFFROAD_ROLLING = 0.1;

const RELATIVE_TOLERANCE = 1e-9;

/** Asserts `actual ≈ expected` with a relative tolerance. */
function approx(actual, expected, message) {
    if (!Number.isFinite(actual)) {
        fail(`${message}: expected ≈ ${expected}, got ${actual}`);
    }

    const tolerance = RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected));
    if (Math.abs(actual - expected) > tolerance) {
        fail(`${message}: expected ≈ ${expected}, got ${actual} (tolerance ${tolerance})`);
    }
}

/** Force-balance speed limit from engine power, mass, slope and rolling resistance. */
function climbSpeed(enginePowerKw, massKg, slope = 0, rolling = ROAD_ROLLING) {
    const angle = Math.atan(Math.abs(slope));
    const resistance = Math.sin(angle) + rolling * Math.cos(angle);
    return (enginePowerKw * 1000 * DRIVETRAIN_EFFICIENCY) / (massKg * GRAVITY * resistance);
}

export async function run() {
    // 1. maxSpeed caps ground speed: speed = maxSpeed/3.6 * 0.8.
    const road30 = legSpeed('ground', 'road', { maxSpeedKmh: 30 }, false);
    approx(road30, (30 / 3.6) * AVERAGE_SPEED_FACTOR, 'road speed follows maxSpeedKmh');
    ok(road30 < 30 / 3.6, 'the average-speed factor keeps the result below the top speed');
    ok(road30 >= 1.5, 'ground speed never drops below the 1.5 m/s floor');

    const road200 = legSpeed('ground', 'road', { maxSpeedKmh: 200 }, false);
    approx(road200, (200 / 3.6) * AVERAGE_SPEED_FACTOR, 'a fast vehicle scales the same way');
    ok(
        road200 <= Math.max((200 / 3.6) * AVERAGE_SPEED_FACTOR, 1.5) + RELATIVE_TOLERANCE,
        'ground speed never exceeds the computed value or the floor',
    );

    // 2. maxSpeed caps boat and air speed.
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 30 }, false),
        Math.max(1.5, (30 / 3.6) * 0.7),
        'boat speed = maxSpeed/3.6 * default water coefficient',
    );
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 5, waterResistanceCoef: 4 }, false),
        1.5,
        'a slow, draggy boat hits the 1.5 m/s floor',
    );
    approx(
        legSpeed('air', 'air', { maxSpeedKmh: 20 }, false),
        Math.max(20, (20 / 3.6) * AVERAGE_SPEED_FACTOR),
        'air speed has a 20 m/s floor',
    );
    approx(
        legSpeed('air', 'air', { maxSpeedKmh: 200 }, false),
        Math.max(20, (200 / 3.6) * AVERAGE_SPEED_FACTOR),
        'air speed = maxSpeed/3.6 * 0.8 above the floor',
    );

    // 3. Heavy vs light climb on a 20% grade: speed = min(maxSpeed*0.8, climb term).
    const slope = 0.2;
    const lightClimb = legSpeed(
        'ground',
        'road',
        { maxSpeedKmh: 100, enginePowerKw: 10, massKg: 1000 },
        false,
        slope,
    );
    const heavyClimb = legSpeed(
        'ground',
        'road',
        { maxSpeedKmh: 100, enginePowerKw: 20, massKg: 4000 },
        false,
        slope,
    );
    approx(lightClimb, climbSpeed(10, 1000, slope), 'a light vehicle is limited by its climb term');
    approx(heavyClimb, climbSpeed(20, 4000, slope), 'a heavy vehicle is limited by its climb term');
    ok(heavyClimb < lightClimb, 'a heavier vehicle must be strictly slower');
    ok(
        climbSpeed(20, 4000, slope) < (100 / 3.6) * AVERAGE_SPEED_FACTOR,
        'the case must make the climb term the binding one',
    );

    const strongClimb = legSpeed(
        'ground',
        'road',
        { maxSpeedKmh: 100, enginePowerKw: 40, massKg: 4000 },
        false,
        slope,
    );
    approx(strongClimb, climbSpeed(40, 4000, slope), 'more power raises the climb term');
    ok(strongClimb > heavyClimb, 'more power at the same mass must be faster');

    // A climb that cannot beat the crawl speed is treated as impassable.
    approx(
        legSpeed(
            'ground',
            'road',
            { maxSpeedKmh: 100, enginePowerKw: 1, massKg: 4000 },
            false,
            slope,
        ),
        0.5,
        'a climb below the crawl speed is capped at 0.5 m/s',
    );
    ok(
        legSpeed(
            'ground',
            'road',
            { maxSpeedKmh: 100, enginePowerKw: 100, massKg: 1500 },
            false,
            MAX_GROUND_SLOPE + 0.05,
        ) === 0.5,
        'slopes beyond the hard maximum are impassable',
    );

    // 3b. Engine damage reduces the sustainable speed and the climb power.
    const healthy = legSpeed('ground', 'road', { maxSpeedKmh: 100 }, false);
    const damaged = legSpeed('ground', 'road', { maxSpeedKmh: 100, engineHealth: 0.2 }, false);
    approx(
        legSpeed('ground', 'road', { maxSpeedKmh: 100, engineHealth: 1 }, false),
        healthy,
        'engineHealth 1 is the undamaged baseline',
    );
    ok(damaged < healthy, 'a damaged engine must be slower');
    ok(damaged > 0, 'a damaged engine still moves');
    ok(
        legSpeed(
            'ground',
            'road',
            { maxSpeedKmh: 100, enginePowerKw: 40, massKg: 4000, engineHealth: 0.2 },
            false,
            slope,
        ) < strongClimb,
        'engine damage also reduces the climb speed',
    );

    // 4. Missing configuration falls back to the nominal speeds.
    for (const performance of [{}, undefined]) {
        approx(legSpeed('ground', 'road', performance, false), NOMINAL_ROAD * AVERAGE_SPEED_FACTOR, 'nominal road = 12 * 0.8 = 9.6');
        // Offroad uses its own nominal (5 m/s), not the road one.
        approx(
            legSpeed('ground', 'offroad', performance, false),
            5 * AVERAGE_SPEED_FACTOR * 0.45,
            'nominal offroad = 5 * 0.8 * 0.45 = 1.8',
        );
        approx(legSpeed('boat', 'water', performance, false), NOMINAL_BOAT * 0.7, 'nominal boat 5.6');
        approx(legSpeed('air', 'air', performance, false), NOMINAL_AIR * AVERAGE_SPEED_FACTOR, 'nominal air 44');
        approx(legSpeed('foot', 'walk', performance, false), FOOT_SPEED, 'flat jog is 14 km/h');
        approx(legSpeed('foot', 'water', performance, false), SWIM_SPEED, 'swim 0.5');
        approx(footSpeed(FOOT_MAX_RUN_SLOPE), FOOT_WALK_SPEED, 'uphill run limit walks at 5 km/h');
        approx(footSpeed(FOOT_MIN_RUN_SLOPE), FOOT_WALK_SPEED, 'downhill run limit walks at 5 km/h');
        approx(footSpeed(0.3), FOOT_SPEED, 'flat-to-16.7-degree uphill keeps the jog');
        approx(footSpeed(-0.5), FOOT_SPEED, 'flat-to-26.6-degree downhill keeps the jog');
        ok(
            footSpeed(0.45) < FOOT_SPEED && footSpeed(0.45) > FOOT_WALK_SPEED,
            'the uphill blend between sprint and run limits is between walk and jog',
        );
    }

    // 5. Boat water coefficients: coef in [0.1, 1], drag = 1/(1+r), floor 1.5.
    approx(legSpeed('boat', 'water', { maxSpeedKmh: 36, waterSpeedCoef: 5 }, false), 10, 'coefficient clamps at 1');
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 100, waterSpeedCoef: 0.01 }, false),
        (100 / 3.6) * 0.1,
        'coefficient clamps at 0.1',
    );
    approx(legSpeed('boat', 'water', { maxSpeedKmh: 36 }, false), 7, 'the boat coefficient defaults to 0.7');
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 36, waterResistanceCoef: 1 }, false),
        3.5,
        'water resistance halves the speed',
    );
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 36, waterResistanceCoef: -5 }, false),
        7,
        'a negative resistance is treated as zero',
    );
    approx(
        legSpeed('boat', 'water', { maxSpeedKmh: 1, waterResistanceCoef: 2 }, false),
        1.5,
        'a slow draggy boat hits the 1.5 m/s floor',
    );

    // 6. Amphibious ground vehicle in water.
    equal(
        legSpeed('ground', 'water', { maxSpeedKmh: 36 }, false),
        0,
        'water is a hard block for a non-amphibious vehicle',
    );
    approx(
        legSpeed('ground', 'water', { maxSpeedKmh: 36 }, true),
        3,
        'amphibious default coefficient 0.3',
    );
    approx(
        legSpeed('ground', 'water', { maxSpeedKmh: 36, waterSpeedCoef: 0.9 }, true),
        9,
        'amphibious coefficient is used',
    );
    approx(
        legSpeed('ground', 'water', { maxSpeedKmh: 36, waterSpeedCoef: 5 }, true),
        10,
        'amphibious coefficient clamps at 1',
    );
    approx(
        legSpeed('ground', 'water', { maxSpeedKmh: 72, waterSpeedCoef: 0.01 }, true),
        1,
        'amphibious coefficient clamps at 0.05',
    );
    const amphibiousDrag1 = legSpeed('ground', 'water', { maxSpeedKmh: 36, waterResistanceCoef: 1 }, true);
    approx(amphibiousDrag1, 1.5, 'amphibious speed halves with drag 1 and floors at 0.8');
    ok(
        amphibiousDrag1 < legSpeed('ground', 'water', { maxSpeedKmh: 36 }, true),
        'more drag must be slower',
    );
    approx(
        legSpeed('ground', 'water', { maxSpeedKmh: 1 }, true),
        0.8,
        'an amphibious vehicle floors at 0.8 m/s',
    );

    // 7. Surface costs: offroad = roadBeforeFloor * 0.45 * terrainCoef when both
    //    start from the same maxSpeed.
    const at36 = (extra = {}) => ({ maxSpeedKmh: 36, ...extra });
    const roadBeforeFloor = (36 / 3.6) * AVERAGE_SPEED_FACTOR; // 8 m/s
    approx(legSpeed('ground', 'road', at36(), false), roadBeforeFloor, 'road speed before the floor');
    approx(
        legSpeed('ground', 'offroad', at36(), false),
        roadBeforeFloor * 0.45,
        'offroad costs 45% of the road speed',
    );
    const offroadHalf = legSpeed('ground', 'offroad', at36({ terrainCoef: 0.5 }), false);
    const offroadFull = legSpeed('ground', 'offroad', at36({ terrainCoef: 1 }), false);
    approx(offroadHalf, roadBeforeFloor * 0.45 * 0.5, 'terrainCoef 0.5 halves the offroad speed');
    approx(offroadFull, roadBeforeFloor * 0.45, 'terrainCoef 1 is the default');
    approx(offroadFull, offroadHalf * 2, 'terrainCoef 0.5 and 1.0 are exactly 2x apart');
    approx(
        legSpeed('ground', 'offroad', at36({ terrainCoef: 3 }), false),
        offroadFull,
        'terrainCoef above 1 clamps to 1',
    );
    equal(
        legSpeed('ground', 'road', at36({ terrainCoef: 0.5 }), false),
        legSpeed('ground', 'road', at36({ terrainCoef: 1 }), false),
        'the road speed ignores terrainCoef',
    );
    approx(legSpeed('ground', 'road', { maxSpeedKmh: 1 }, false), 1.5, 'road floors at 1.5 m/s');
    approx(legSpeed('ground', 'offroad', { maxSpeedKmh: 1 }, false), 0.5, 'offroad floors at 0.5 m/s');

    // Off-road rolling resistance is higher than asphalt on the same grade.
    const offroadClimb = legSpeed(
        'ground',
        'offroad',
        { maxSpeedKmh: 100, enginePowerKw: 20, massKg: 4000 },
        false,
        0.2,
    );
    approx(
        offroadClimb,
        climbSpeed(20, 4000, 0.2, OFFROAD_ROLLING) * 0.45,
        'offroad uses the higher rolling resistance and the 0.45 surface multiplier',
    );
    ok(offroadClimb < heavyClimb, 'offroad is slower than road on the same grade');

    // 8. On foot the vehicle snapshot is irrelevant.
    const aircraft = { maxSpeedKmh: 250, enginePowerKw: 500, massKg: 5000, terrainCoef: 0.5 };
    equal(legSpeed('foot', 'walk', {}, false), legSpeed('foot', 'walk', aircraft, false), 'foot ignores performance');
    equal(legSpeed('foot', 'water', {}, false), legSpeed('foot', 'water', aircraft, false), 'swim ignores performance');

    // 9. Robustness: garbage numbers never produce NaN, negatives or zero.
    const garbage = [
        { maxSpeedKmh: 0 },
        { maxSpeedKmh: -5 },
        { maxSpeedKmh: Number.NaN },
        { maxSpeedKmh: Number.POSITIVE_INFINITY },
        { enginePowerKw: 0, massKg: 0 },
        { enginePowerKw: -1, massKg: -1 },
        { enginePowerKw: Number.NaN, massKg: Number.NaN },
        { enginePowerKw: Number.POSITIVE_INFINITY, massKg: Number.POSITIVE_INFINITY },
        { enginePowerKw: 1, massKg: Number.POSITIVE_INFINITY },
        { waterResistanceCoef: -1 },
        { waterResistanceCoef: Number.POSITIVE_INFINITY },
        { waterSpeedCoef: Number.NaN },
        { waterSpeedCoef: -1 },
        { terrainCoef: Number.NaN },
        { terrainCoef: Number.POSITIVE_INFINITY },
    ];

    const floors = [
        ['ground', 'road', false, 1.5],
        ['ground', 'offroad', false, 0.5],
        ['boat', 'water', false, 1.5],
        ['air', 'air', false, 20],
        ['foot', 'walk', false, FOOT_SPEED],
        ['foot', 'water', false, SWIM_SPEED],
        ['ground', 'water', true, 0.8],
    ];

    for (const performance of garbage) {
        for (const [mode, kind, waterCapable, floor] of floors) {
            const speed = legSpeed(mode, kind, performance, waterCapable);
            ok(
                Number.isFinite(speed) && speed >= floor,
                `${mode}/${kind} with ${JSON.stringify(performance)} must be finite and >= ${floor}, got ${speed}`,
            );
        }

        equal(
            legSpeed('ground', 'water', performance, false),
            0,
            'a non-amphibious vehicle never gets a water speed',
        );
    }

    // 10. A `cost` key is never read (the planner owns costs, not the vehicle).
    const performance = {
        maxSpeedKmh: 90,
        enginePowerKw: 150,
        massKg: 1800,
        terrainCoef: 0.7,
        waterSpeedCoef: 0.4,
        waterResistanceCoef: 0.2,
    };
    const withCost = { ...performance, cost: 1e9 };

    for (const [mode, kind, waterCapable] of [
        ['foot', 'walk', false],
        ['foot', 'water', false],
        ['ground', 'road', false],
        ['ground', 'offroad', false],
        ['ground', 'water', true],
        ['boat', 'water', false],
        ['air', 'air', false],
    ]) {
        equal(
            legSpeed(mode, kind, withCost, waterCapable),
            legSpeed(mode, kind, performance, waterCapable),
            `${mode}/${kind} must ignore an unknown "cost" key`,
        );
    }
}
