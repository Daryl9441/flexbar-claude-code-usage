// Tests for the dual Usage Meter: remaining percentages, the two limits it
// reads from a usage response, its countdown format and a render smoke test,
// run against the tsc output (see `npm run test:usage`). All usage data here
// is synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.USAGE_TEST_BUILD ?? path.join(here, '..', '.test-build');
const U = require(path.join(build, 'usage.js'));
const D = require(path.join(build, 'usageDualRender.js'));
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// A reset time this many minutes from now, a few seconds past the minute so
// formatTimeUntilReset (which rounds minutes up) is stable while tests run
const inMinutes = m => new Date(Date.now() + m * 60_000 + 5_000).toISOString();

const window = (utilization, resetsAt = null) => ({
  utilization,
  resets_at: resetsAt,
});
const limit = (kind, percent, resetsAt = null, model = null) => ({
  kind,
  group: kind === 'session' ? 'session' : 'weekly',
  percent,
  severity: 'normal',
  resets_at: resetsAt,
  scope: model
    ? { model: { id: null, display_name: model }, surface: null }
    : null,
  is_active: true,
});
const usage = (fields = {}) => ({
  five_hour: null,
  seven_day: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  ...fields,
});
const snapshot = (percent, resetsAt = null) => ({
  percent,
  resetsAt,
  label: 'Test',
});

// --- remaining percent -------------------------------------------------------

describe('remainingPercent', () => {
  test('is 100 minus the used percentage', () => {
    assert.equal(U.remainingPercent(snapshot(31)), 69);
    assert.equal(U.remainingPercent(snapshot(0)), 100);
    assert.equal(U.remainingPercent(snapshot(100)), 0);
    assert.equal(U.remainingPercent(snapshot(83)), 17);
  });

  test('rounds to an integer', () => {
    assert.equal(U.remainingPercent(snapshot(30.4)), 70);
    assert.equal(U.remainingPercent(snapshot(99.6)), 0);
    assert.equal(U.remainingPercent(snapshot(0.4)), 100);
  });

  test('clamps out-of-range usage to 0..100', () => {
    assert.equal(U.remainingPercent(snapshot(-20)), 100);
    assert.equal(U.remainingPercent(snapshot(140)), 0);
    assert.equal(U.remainingPercent(snapshot(Infinity)), null);
  });

  test('is null for a missing window or a non-numeric value', () => {
    assert.equal(U.remainingPercent(null), null);
    assert.equal(U.remainingPercent(undefined), null);
    assert.equal(U.remainingPercent(snapshot(NaN)), null);
    assert.equal(U.remainingPercent(snapshot(undefined)), null);
    assert.equal(U.remainingPercent(snapshot('n/a')), null);
  });
});

// --- the two limits ----------------------------------------------------------

describe('getDualSnapshot', () => {
  test('reads session and weekly (all models) from the limits array', () => {
    const resets = inMinutes(90);
    const dual = U.getDualSnapshot(
      usage({
        limits: [
          limit('weekly_scoped', 50, null, 'Claude Test'),
          limit('weekly_all', 47, null),
          limit('session', 83, resets),
        ],
        five_hour: window(10),
        seven_day: window(10),
      })
    );
    assert.equal(dual.session.percent, 83);
    assert.equal(dual.session.resetsAt, resets);
    assert.equal(dual.weekly.percent, 47);
    assert.equal(U.remainingPercent(dual.session), 17);
    assert.equal(U.remainingPercent(dual.weekly), 53);
  });

  test('falls back to the flat five_hour / seven_day windows', () => {
    const dual = U.getDualSnapshot(
      usage({ five_hour: window(8.2), seven_day: window(31) })
    );
    assert.equal(U.remainingPercent(dual.session), 92);
    assert.equal(U.remainingPercent(dual.weekly), 69);
  });

  test('clamps flat windows that report more than 100 %', () => {
    const dual = U.getDualSnapshot(
      usage({ five_hour: window(140), seven_day: window(-5) })
    );
    assert.equal(U.remainingPercent(dual.session), 0);
    assert.equal(U.remainingPercent(dual.weekly), 100);
  });

  test('a missing weekly window is null, the session still shows', () => {
    const dual = U.getDualSnapshot(usage({ five_hour: window(40) }));
    assert.equal(U.remainingPercent(dual.session), 60);
    assert.equal(dual.weekly, null);
    assert.equal(U.remainingPercent(dual.weekly), null);
  });

  test('a model-scoped weekly limit is not the weekly (all models) one', () => {
    const dual = U.getDualSnapshot(
      usage({ limits: [limit('weekly_scoped', 70, null, 'Claude Test')] })
    );
    assert.equal(dual.session, null);
    assert.equal(dual.weekly, null);
  });

  test('no windows at all gives two nulls', () => {
    assert.deepEqual(U.getDualSnapshot(usage()), {
      session: null,
      weekly: null,
    });
    assert.deepEqual(U.getDualSnapshot(usage({ limits: [] })), {
      session: null,
      weekly: null,
    });
  });
});

// --- countdown ---------------------------------------------------------------

describe('dualCountdown', () => {
  test('is empty for unknown or invalid reset times', () => {
    assert.equal(D.dualCountdown(null), '');
    assert.equal(D.dualCountdown(undefined), '');
    assert.equal(D.dualCountdown(''), '');
    assert.equal(D.dualCountdown('not a date'), '');
  });

  test('keeps hours and minutes below 10 hours', () => {
    assert.equal(D.dualCountdown(inMinutes(4 * 60 + 12)), '4h 13m');
    assert.equal(D.dualCountdown(inMinutes(4 * 60 + 12), true), '4h13m');
    assert.equal(D.dualCountdown(inMinutes(22)), '23m');
  });

  test('drops zero units', () => {
    assert.equal(D.dualCountdown(inMinutes(3 * 60 - 1)), '3h');
    assert.equal(D.dualCountdown(inMinutes(2 * 1440 - 1)), '2d');
  });

  test('keeps only the hours from 10 hours on', () => {
    assert.equal(D.dualCountdown(inMinutes(23 * 60 + 58)), '23h');
    assert.equal(D.dualCountdown(inMinutes(14 * 60 + 29)), '14h');
  });

  test('days keep their hours, compact drops the space', () => {
    const sixDays = inMinutes(6 * 1440 + 23 * 60 + 10);
    assert.equal(D.dualCountdown(sixDays), '6d 23h');
    assert.equal(D.dualCountdown(sixDays, true), '6d23h');
  });

  test('a reset time in the past reads "now"', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(D.dualCountdown(past), 'now');
  });
});

// --- rendering ---------------------------------------------------------------

const decode = async dataUrl => {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  return loadImage(Buffer.from(dataUrl.split(',')[1], 'base64'));
};

const pixel = (img, x, y) => {
  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
};

describe('renderDualUsageKey', () => {
  const states = {
    fresh: [snapshot(8, inMinutes(252)), snapshot(31, inMinutes(7380))],
    empty: [snapshot(100, inMinutes(23)), snapshot(100, inMinutes(2970))],
    unused: [snapshot(0), snapshot(0)],
    noWeekly: [snapshot(40, inMinutes(130)), null],
    noSession: [null, snapshot(12, inMinutes(4000))],
    outOfRange: [snapshot(-20, 'not a date'), snapshot(140, inMinutes(-5))],
  };

  test('is always exactly key width x 60 px', async () => {
    for (const [session, weekly] of Object.values(states)) {
      for (const showResetTime of [true, false]) {
        for (const width of [56, 72, 90, 100, 120, 134, 160, 200, 240, 300]) {
          const img = await decode(
            D.renderDualUsageKey(width, session, weekly, { showResetTime })
          );
          assert.equal(img.width, width);
          assert.equal(img.height, 60);
        }
      }
    }
  });

  test('rounds a fractional width', async () => {
    const [session, weekly] = states.fresh;
    const img = await decode(
      D.renderDualUsageKey(119.6, session, weekly, { showResetTime: true })
    );
    assert.equal(img.width, 120);
    assert.equal(img.height, 60);
  });

  test('uses a custom background color', async () => {
    const [session, weekly] = states.fresh;
    for (const bgColor of ['#1e3a5f', 'rgb(30, 58, 95)']) {
      const img = await decode(
        D.renderDualUsageKey(160, session, weekly, {
          showResetTime: true,
          bgColor,
        })
      );
      assert.deepEqual(pixel(img, 0, 0), [0x1e, 0x3a, 0x5f]);
    }
  });

  test('draws the default background without a custom color', async () => {
    const img = await decode(
      D.renderDualUsageKey(120, null, null, { showResetTime: true })
    );
    assert.deepEqual(pixel(img, 0, 0), [0x1c, 0x19, 0x17]);
  });
});
