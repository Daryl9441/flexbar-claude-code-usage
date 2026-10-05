// Tests for the dual Usage Meter: remaining percentages, the two limits it
// reads from a usage response, its countdown format, the layout rules of its
// key face (dualLayout) and render checks, run against the tsc output (see
// `npm run test:usage`). All usage data here is synthetic.
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

  test('session and weekly carry the short tags of the dual rows', () => {
    const rich = U.getDualSnapshot(
      usage({ limits: [limit('session', 10), limit('weekly_all', 20)] })
    );
    const flat = U.getDualSnapshot(
      usage({ five_hour: window(10), seven_day: window(20) })
    );
    for (const dual of [rich, flat]) {
      assert.equal(dual.session.tag, '5h');
      assert.equal(dual.weekly.tag, '7d');
    }
    const model = U.getMetricSnapshot(
      usage({ limits: [limit('weekly_scoped', 70, null, 'Claude Test')] }),
      'weekly_model'
    );
    assert.equal(model.tag, undefined);
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

// --- layout ------------------------------------------------------------------

// Widths well inside each layout's range, so the tests hold with any of the
// usual sans-serif fonts (thresholds move by a few pixels between fonts)
const layout = (width, session, weekly, showResetTime = true) =>
  D.dualLayout(width, session, weekly, { showResetTime });
const fresh = () => [snapshot(8, inMinutes(252)), snapshot(31, inMinutes(7380))];
const WIDTHS = Array.from({ length: 381 }, (_, i) => 60 + i);

describe('dualLayout', () => {
  test('picks the richest layout the width allows', () => {
    const modes = width => layout(width, ...fresh()).mode;
    assert.equal(modes(60), 'bare');
    assert.equal(modes(72), 'bare');
    assert.equal(modes(90), 'bare');
    assert.equal(modes(120), 'bar');
    assert.equal(modes(160), 'stack');
    assert.equal(modes(200), 'stack');
    assert.equal(modes(240), 'inline');
    assert.equal(modes(300), 'inline');
  });

  test('without known reset times there is no countdown layout', () => {
    const unused = [snapshot(0), snapshot(0)];
    for (const width of [160, 240, 300]) {
      assert.equal(layout(width, ...unused).mode, 'bar');
      assert.equal(layout(width, ...fresh(), false).mode, 'bar');
    }
    for (const width of WIDTHS) {
      for (const row of layout(width, ...fresh(), false).rows) {
        assert.equal(row.countdownLayout, null, `${width} px`);
      }
    }
  });

  test('every row has a battery gauge except on gauge-less keys', () => {
    for (const width of [72, 90]) {
      const l = layout(width, ...fresh());
      assert.ok(l.rows.every(row => row.gaugeY === null));
    }
    for (const width of [120, 160, 240]) {
      const l = layout(width, ...fresh());
      assert.ok(l.gaugeWidth >= 20);
      assert.ok(l.rows.every(row => row.gaugeY !== null));
    }
  });

  test('an exhausted row shows its countdown in place of its gauge at 120 px', () => {
    for (const minutes of [23, 65, 178, 252, 599, 2970, 10079]) {
      const l = layout(120, snapshot(100, inMinutes(minutes)), snapshot(40));
      const [row] = l.rows;
      assert.equal(l.mode, 'bar');
      assert.equal(row.gaugeY, null, `${minutes} min`);
      assert.ok(row.countdownLayout, `${minutes} min`);
      // clear of the label, next to its "0%"
      const label = l.labelX + l.labelWidth;
      assert.ok(row.countdownLayout.right - 30 > label + 10, `${minutes} min`);
      assert.ok(row.countdownLayout.right < l.numberRight - 15);
    }
    // a row with something left keeps its gauge and shows no countdown
    const l = layout(120, snapshot(99, inMinutes(30)), snapshot(40));
    assert.notEqual(l.rows[0].gaugeY, null);
    assert.equal(l.rows[0].countdownLayout, null);
  });

  test('stacked rows sit on the digit baseline, rows without a caption stay centred', () => {
    const l = layout(160, snapshot(0), snapshot(5, inMinutes(6000)));
    assert.equal(l.mode, 'stack');
    const [plain, stacked] = l.rows;
    assert.equal(plain.countdownLayout, null);
    assert.equal(plain.gaugeY + 4.5, plain.cy);
    assert.ok(stacked.countdownLayout);
    assert.equal(stacked.labelBaseline, stacked.digitBaseline);
    assert.ok(stacked.gaugeY + 9 <= stacked.digitBaseline);
    assert.ok(stacked.countdownLayout.cy < stacked.gaugeY);
  });

  test('the countdown column sits right of the numbers on wide keys', () => {
    const l = layout(300, ...fresh());
    for (const row of l.rows) {
      assert.equal(row.countdownLayout.right, 300 - 12);
      assert.ok(row.countdownLayout.right - 45 > l.numberRight);
      assert.equal(row.countdownLayout.size, 11);
    }
  });

  test('"100" drops its "%" next to a gauge and keeps it on 72-96 px keys', () => {
    const full = [snapshot(0), snapshot(5)];
    for (const width of [120, 160, 240]) {
      const [hundred, ninetyFive] = layout(width, ...full).rows;
      assert.equal(hundred.percent, false);
      assert.equal(ninetyFive.percent, true);
    }
    for (const width of [72, 90]) {
      assert.equal(layout(width, ...full).rows[0].percent, true);
    }
  });

  test('narrow keys keep big digits by dropping the "%" of "100"', () => {
    const full = [snapshot(0), snapshot(5)];
    const l = layout(60, ...full);
    assert.equal(l.mode, 'bare');
    assert.equal(l.rows[0].percent, false);
    assert.equal(l.rows[1].percent, true);
    assert.ok(l.digitSize >= 17);
  });

  test('a missing window is a row without number, "%" or countdown', () => {
    for (const width of [72, 120, 160, 240]) {
      const l = layout(width, snapshot(40, inMinutes(130)), null);
      assert.equal(l.rows[1].remaining, null);
      assert.equal(l.rows[1].percent, false);
      assert.equal(l.rows[1].countdownLayout, null);
    }
  });

  test('no text under 10 px and no countdown off the key, at any width', () => {
    const states = [
      fresh(),
      [snapshot(100, inMinutes(599)), snapshot(100, inMinutes(10079))],
      [snapshot(0), snapshot(5, inMinutes(6000))],
      [snapshot(40, inMinutes(130)), null],
    ];
    for (const width of WIDTHS) {
      for (const [session, weekly] of states) {
        const l = layout(width, session, weekly);
        assert.ok(l.labelSize >= 10, `${width} px`);
        assert.ok(l.digitSize >= 17, `${width} px`);
        for (const row of l.rows) {
          if (row.percent) assert.ok(l.percentSize >= 10, `${width} px`);
          const c = row.countdownLayout;
          if (!c) continue;
          assert.ok(c.size >= 10, `${width} px`);
          assert.ok(c.right <= width, `${width} px`);
        }
      }
    }
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
    for (const bgColor of ['#1e3a5f', 'rgb(30, 58, 95)', '#1e3a5fff']) {
      const img = await decode(
        D.renderDualUsageKey(160, session, weekly, {
          showResetTime: true,
          bgColor,
        })
      );
      assert.deepEqual(pixel(img, 0, 0), [0x1e, 0x3a, 0x5f]);
    }
  });

  test('switches to dark text on a light background', async () => {
    const [session, weekly] = fresh();
    const darkest = async bgColor => {
      const img = await decode(
        D.renderDualUsageKey(160, session, weekly, {
          showResetTime: true,
          bgColor,
        })
      );
      // the "7d" label area of the bottom row
      const ctx = createCanvas(img.width, img.height).getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(12, 40, 14, 14).data;
      let min = 255;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return { min, max };
    };
    assert.ok((await darkest('#f5f5f4')).min < 120);
    assert.ok((await darkest('#1c1917')).max > 140);
  });

  test('draws the default background without a custom color', async () => {
    const img = await decode(
      D.renderDualUsageKey(120, null, null, { showResetTime: true })
    );
    assert.deepEqual(pixel(img, 0, 0), [0x1c, 0x19, 0x17]);
  });
});
