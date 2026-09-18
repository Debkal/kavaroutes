import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCostProfileDefaults, estimateRouteCost, defaultTripsPerMonth } from '../dist/index.js';

const profile = routeCostProfileDefaults;

test('a route estimate prices fuel, maintenance, the driver, insurance and overhead', () => {
  const estimate = estimateRouteCost(profile, { miles: 20, tripMinutes: 90, tripsPerMonth: 167 });
  // Fuel: 20 loaded miles x 1.15 deadhead = 23 miles at 14 mpg x 416 cents = 683 cents.
  assert.equal(estimate.fuelCents, 683);
  // Maintenance: 23 miles x 15 cents = 345 cents.
  assert.equal(estimate.maintenanceCents, 345);
  // Driver: 1.5 hours x 1800 cents x 1.30 burden = 3510 cents; the wait is paid for.
  assert.equal(estimate.driverCents, 3510);
  // Fixed costs are spread over the month's trips: 100000/167 and 80000/167.
  assert.equal(estimate.insuranceCents, 599);
  assert.equal(estimate.overheadCents, 479);
  assert.equal(estimate.totalCents, 683 + 345 + 3510 + 599 + 479);
  assert.equal(estimate.costPerMileCents, Math.round(estimate.totalCents / 20));
});

test('the suggested price is the cost grossed up to the target margin', () => {
  const estimate = estimateRouteCost({ ...profile, targetMarginPercent: 20 }, { miles: 10, tripMinutes: 45, tripsPerMonth: 167 });
  assert.equal(estimate.suggestedPriceCents, Math.round(estimate.totalCents / 0.8));
  assert.ok(estimate.suggestedPriceCents > estimate.totalCents);
});

test('the margin at the contracted rate tells the operator whether the trip is worth running', () => {
  const below = estimateRouteCost({ ...profile, contractedBaseCents: 2000, contractedCentsPerMile: 50 }, { miles: 10, tripMinutes: 60, tripsPerMonth: 167 });
  assert.match(below.marginAdvice, /floor/);
  assert.equal(below.meetsTarget, false);
  const broker = estimateRouteCost({ ...profile, contractedBaseCents: 4500, contractedCentsPerMile: 250, targetMarginPercent: 18 }, { miles: 10, tripMinutes: 60, tripsPerMonth: 167 });
  assert.ok(broker.marginAtContractedPercent > 8, broker.marginAtContractedPercent);
  const privatePay = estimateRouteCost({ ...profile, contractedBaseCents: 12000, contractedCentsPerMile: 300, targetMarginPercent: 18 }, { miles: 10, tripMinutes: 60, tripsPerMonth: 167 });
  assert.ok(privatePay.marginAtContractedPercent >= 20, privatePay.marginAtContractedPercent);
  assert.match(privatePay.marginAdvice, /At or above the margin target/);
});

test('fixed costs are spread further as a vehicle runs more trips, and a free trip still costs the fixed share', () => {
  const few = estimateRouteCost(profile, { miles: 10, tripMinutes: 30, tripsPerMonth: 50 });
  const many = estimateRouteCost(profile, { miles: 10, tripMinutes: 30, tripsPerMonth: 500 });
  assert.ok(few.insuranceCents > many.insuranceCents);
  const zeroMiles = estimateRouteCost(profile, { miles: 0, tripMinutes: 0, tripsPerMonth: defaultTripsPerMonth });
  assert.equal(zeroMiles.fuelCents + zeroMiles.maintenanceCents, 0);
  assert.ok(zeroMiles.totalCents > 0, 'insurance and overhead are owed whether or not the van moves');
  assert.equal(zeroMiles.costPerMileCents, 0);
});
