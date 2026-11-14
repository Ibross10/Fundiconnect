import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, resolveApiUrl } from '../src/api-client';

test('frontend API URL resolution preserves relative development requests and supports configured API origins', () => {
  assert.equal(resolveApiUrl('/api/auth/login'), '/api/auth/login');
  assert.equal(resolveApiUrl('api/auth/login', 'https://api.example.test/'), 'https://api.example.test/api/auth/login');
  assert.equal(apiUrl('/api/auth/login'), '/api/auth/login');
});
