// One real day of the live board, committed.
//
// Six tests measure properties of live data — how selective the ranking is,
// whether pooling produces anything, how many cards can be priced. Those are
// worth measuring, and they were measured against whatever the feed happened
// to contain when the test ran, with a silent fetch from GitHub when the local
// snapshot was missing.
//
// That is not a test. It passes on a quiet day and fails on a busy one, and
// nothing about the code changed in between. Worse, it fails long after the
// commit that would explain it, and it hid a missing fixture behind a network
// call that usually succeeded.
//
// So the snapshot is in the repo: 30 instruments across all six asset classes,
// taken from the live feed with the drawing data stripped. Real events, real
// records, real baselines and real stop grids — a fixture built from the market
// rather than built to pass. Pass a path as the first argument to run any of
// these against a different snapshot, including today's.
import { readFileSync } from 'fs';

export const FIXTURE = new URL('./fixtures/feed.json', import.meta.url).pathname;

export function loadFeed(override = process.argv[2]) {
  return JSON.parse(readFileSync(override || FIXTURE, 'utf8'));
}
