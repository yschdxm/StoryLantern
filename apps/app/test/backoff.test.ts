import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelayMs,
  decideRetry,
  failureCodeOf,
  isRetryableChatFailure,
  withBackoffRetry,
} from '../src/data/backoff.ts';
import { DataError } from '../src/data/repository.ts';

/** 与 DataError 同形（测试只依赖 code 字段）。 */
function failure(code: string, message = ''): DataError {
  return new DataError(code, message);
}

test('退避序列：指数增长 + 上限；随机源注入，模块里不直接 Math.random', () => {
  const fixed = { random: () => 0 }; // jitter=0，序列可逐位断言
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, fixed)), [500, 1000, 2000, 4000, 8000, 8000]);
  // jitter：random=0.5、ratio=0.2 → +10%
  assert.equal(backoffDelayMs(1, { random: () => 0.5, jitterRatio: 0.2 }), 550);
  // 调用方可以完全关掉 jitter
  assert.equal(backoffDelayMs(2, { random: () => 1, jitterRatio: 0 }), 1000);
});

test('可重试判定：传输/超时/5xx/429 重试；配置错/offline/aborted/4xx 不重试', () => {
  assert.equal(isRetryableChatFailure(failure('transport-failed', '连接失败')), true);
  assert.equal(isRetryableChatFailure(failure('timeout', '请求超时')), true);
  assert.equal(isRetryableChatFailure(failure('model-error', '接口返回 500：oops')), true);
  assert.equal(isRetryableChatFailure(failure('model-error', '接口返回 429：rate limited')), true);
  assert.equal(isRetryableChatFailure(failure('model-error', '接口返回 400：bad stream_options')), false);
  assert.equal(isRetryableChatFailure(failure('not-configured', '还没填 key')), false);
  assert.equal(isRetryableChatFailure(failure('offline', '离线')), false);
  assert.equal(isRetryableChatFailure(failure('aborted', '已停止')), false);
  assert.equal(failureCodeOf({ code: 'transport-failed' }), 'transport-failed');
  assert.equal(failureCodeOf(new Error('no code')), undefined);
});

test('decideRetry：只重试一次；非可重试错误立即放弃', () => {
  assert.deepEqual(decideRetry(failure('transport-failed'), 0, { random: () => 0 }), { retry: true, waitMs: 500 });
  assert.deepEqual(decideRetry(failure('transport-failed'), 1), { retry: false, waitMs: 0 }, '最多一次');
  assert.deepEqual(decideRetry(failure('not-configured'), 0), { retry: false, waitMs: 0 });
});

test('withBackoffRetry：可重试失败等一次后成功；记录等待与次数', async () => {
  const waited: number[] = [];
  let calls = 0;
  const result = await withBackoffRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw failure('transport-failed', '断线');
      return 'ok';
    },
    {
      random: () => 0,
      onRetry: (cause, waitMs, attempt) => {
        assert.equal(failureCodeOf(cause), 'transport-failed');
        waited.push(waitMs);
        assert.equal(attempt, 1);
      },
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2, '失败后只补一次');
  assert.deepEqual(waited, [500]);
});

test('withBackoffRetry：不可重试错误立即抛；用完重试次数也原样抛', async () => {
  let calls = 0;
  await assert.rejects(
    withBackoffRetry(
      async () => {
        calls += 1;
        throw failure('not-configured', '缺 key');
      },
      { random: () => 0 },
    ),
    /缺 key/,
  );
  assert.equal(calls, 1, '配置错不重试');

  let always = 0;
  await assert.rejects(
    withBackoffRetry(
      async () => {
        always += 1;
        throw failure('transport-failed', '还是断');
      },
      { random: () => 0 },
    ),
    /还是断/,
  );
  assert.equal(always, 2, '传输错只重试一次');
});
