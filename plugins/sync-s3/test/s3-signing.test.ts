import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, signS3Request } from '../src/index.ts';

/**
 * SigV4 用**官方测试向量**验，不是"自己算自己验"。
 *
 * 向量来源（botocore 的 aws4_testsuite，`get-vanilla`）：
 *   `.../aws4_testsuite/get-vanilla/get-vanilla.req`
 *     GET / HTTP/1.1
 *     Host:example.amazonaws.com
 *     X-Amz-Date:20150830T123600Z
 *   `.../get-vanilla.authz`
 *     AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request,
 *     SignedHeaders=host;x-amz-date,
 *     Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31
 *
 * 注意：向量用的是 `service` 这个服务名（不是 `s3`），所以 `signS3Request` 把服务名留成参数。
 * 如果密钥或算法有一处不对，这个断言就红 —— 这正是要它的原因。
 */

const EXPECTED =
  'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
  'SignedHeaders=host;x-amz-date, ' +
  'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';

test('SigV4：官方 get-vanilla 向量必须逐字符相同', async () => {
  const authorization = await signS3Request({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: '',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: await sha256Hex(''),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20150830T123600Z',
    service: 'service',
  });
  assert.equal(authorization, EXPECTED);
});

test('空体的 SHA-256 就是那个众所周知的常量（签名的 payload 哈希靠它）', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('同样的输入两次签名结果一致（签名的 date 由调用方给，不能自己取当前时间）', async () => {
  const base = {
    method: 'PUT',
    canonicalUri: '/bucket/sessions/abc.json.gz',
    canonicalQuery: '',
    headers: { host: 'minio.local', 'x-amz-content-sha256': 'x', 'x-amz-date': '20150830T123600Z' },
    payloadHash: 'x',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20150830T123600Z',
  } as const;
  const first = await signS3Request({ ...base });
  const second = await signS3Request({ ...base });
  assert.equal(first, second);
  assert.match(first, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/s3\/aws4_request, /);
});
