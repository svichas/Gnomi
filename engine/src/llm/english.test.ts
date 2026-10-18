import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeSchema } from '../audience/write.ts';

test('the persona writer rejects a candidate named or described in another script', () => {
  const candidate = { name: 'Chen Jing', job_title: 'UAT tester', industry: 'Medical software', background: 'I test releases.', context_of_use: 'At home.', goal_interpretation: 'Find the price.', voice: 'Plain.', probability: 0.25 };
  const four = (c: object) => ({ candidates: [c, candidate, candidate, candidate] });
  assert.equal(writeSchema.safeParse(four(candidate)).success, true);
  assert.equal(writeSchema.safeParse(four({ ...candidate, name: '陈静' })).success, false);
  assert.equal(writeSchema.safeParse(four({ ...candidate, job_title: '用户验收测试员' })).success, false);
});
