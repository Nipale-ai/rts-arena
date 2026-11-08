import test from 'node:test';
import assert from 'node:assert/strict';
import { plainOrders } from '../tools/plain-orders.mjs';

test('plain orders: no command word reaches the viewer', () => {
  assert.equal(plainOrders('scout, train 3x worker, build farm, build lumber_camp'), 'send the scout, train 3 workers, build a farm, build a lumber camp');
  assert.equal(plainOrders('cancel_standing, cancel_standing, advance tier, train 1x archer'), 'cancel 2 standing orders, go up a tier, train 1 archer');
  assert.equal(plainOrders('auto_train, say'), 'keep training, send a chat message');
  assert.equal(plainOrders('build farm, build farm'), 'build 2 farms');
  assert.equal(plainOrders('build archery_range, attack_wave, group, group'), 'build an archery range, send attack waves, form 2 groups');
  assert.equal(plainOrders('research wood_axe'), 'research wood axe');
  assert.equal(plainOrders('train 3x spearman'), 'train 3 spearmen');
  assert.equal(plainOrders(''), '');
  assert.equal(plainOrders(undefined), '');
});
