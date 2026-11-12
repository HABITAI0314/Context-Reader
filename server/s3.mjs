// 极简 S3 客户端（AWS Signature V4），只用 Web 标准 API，Cloudflare 和 Node 都能跑。
// 用来通过 S3 接口访问 Cloudflare R2（可以是另一个 Cloudflare 账号下的 R2）。

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * @param {{ endpoint: string, accessKeyId: string, secretAccessKey: string, bucket: string, region?: string }} cfg
 */
export function s3Client({ endpoint, accessKeyId, secretAccessKey, bucket, region = 'auto' }) {
  const base = new URL(endpoint);

  /**
   * @param {string} method
   * @param {string} key 对象名，空字符串表示存储桶本身
   * @param {{ query?: Record<string, string>, body?: ArrayBuffer, headers?: Record<string, string> }} [opts]
   */
  async function send(method, key, opts = {}) {
    const path = '/' + bucket + (key ? '/' + key : '');
    const uri = path.split('/').map(rfc3986).join('/');
    const query = opts.query || {};
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
      .join('&');
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    // 上传时不对文件内容做哈希（省 CPU），R2 支持 UNSIGNED-PAYLOAD
    const payloadHash = opts.body ? 'UNSIGNED-PAYLOAD' : await sha256('');
    const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    const canonical = [method, uri, qs, names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join(''), signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
    let k = await hmac('AWS4' + secretAccessKey, date);
    k = await hmac(k, region);
    k = await hmac(k, 's3');
    k = await hmac(k, 'aws4_request');
    const signature = hex(await hmac(k, toSign));
    const { host, ...sendHeaders } = headers;
    sendHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetch(`${base.origin}${uri}${qs ? '?' + qs : ''}`, { method, headers: sendHeaders, body: opts.body });
  }

  const fail = async (res, what) => {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`R2 ${what}失败（${res.status}）${text.match(/<Code>([^<]+)/)?.[1] || ''}`);
  };

  return {
    request: send,
    async put(key, body, contentType) {
      const res = await send('PUT', key, { body, headers: { 'content-type': contentType } });
      if (!res.ok) await fail(res, '上传');
    },
    /** 不存在时返回 null */
    async get(key) {
      const res = await send('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, '下载');
      return res;
    },
    async head(key) {
      const res = await send('HEAD', key);
      return res.ok;
    },
    async delete(key) {
      const res = await send('DELETE', key);
      if (!res.ok && res.status !== 404) await fail(res, '删除');
    },
    /** 列出前缀下的全部对象名 */
    async list(prefix) {
      const keys = [];
      let token = '';
      for (;;) {
        const query = { 'list-type': '2', prefix };
        if (token) query['continuation-token'] = token;
        const res = await send('GET', '', { query });
        if (!res.ok) await fail(res, '列出文件');
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
        token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] || '';
        if (!/<IsTruncated>true</.test(xml) || !token) return keys;
      }
    },
    /** 存储桶不存在时创建 */
    async ensureBucket() {
      const head = await send('HEAD', '');
      if (head.ok) return 'exists';
      const res = await send('PUT', '');
      if (!res.ok) await fail(res, '创建存储桶');
      return 'created';
    },
  };
}
