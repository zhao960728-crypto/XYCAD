import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uploadExtensions } from '../public/cad-limits.mjs';

export function bdycOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('XYCAD_BDYC_ORIGIN 必须是 BDYC 本机 HTTP 源地址。');
  }
  return url;
}

export async function openBdycSource(request, response, query, origin, json) {
  if (request.method !== 'GET') return response.writeHead(405, { Allow: 'GET' }).end();
  if (!origin || request.headers.host !== origin.hostname + ':' + request.socket.localPort) {
    return json(response, 404, { error: 'BDYC 本机图纸入口未启用。' });
  }
  const params = new URLSearchParams(query);
  if (!params.size) return json(response, 200, { login: origin.origin + '/login' });
  if (request.headers['x-xycad-bdyc'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site') {
    return json(response, 403, { error: '请通过 XYCAD 页面读取内部图纸。' });
  }
  const path = params.get('path')?.trim().replaceAll('\\', '/');
  const filename = path?.split('/').at(-1);
  if (params.size !== 1 || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some(part => part === '..' || part === '.') ||
      !uploadExtensions.includes(filename?.split('.').at(-1)?.toLowerCase())) {
    return json(response, 400, { error: '请填写 BDYC 中受支持的图纸路径。' });
  }
  const session = /(?:^|;\s*)bdyc_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? '');
  if (!session) return json(response, 401, { error: '请先在同一浏览器登录 BDYC。' });
  const endpoint = new URL('/download', origin);
  endpoint.searchParams.set('path', path);
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort();
  response.once('close', cancel);
  try {
    const source = await fetch(endpoint, { redirect: 'manual',
      headers: { Cookie: 'bdyc_session=' + session[1], Accept: 'application/octet-stream' },
      signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(120_000)]) });
    if (source.status !== 200 || !source.body || !source.headers.has('content-disposition')) {
      await source.body?.cancel();
      const status = source.status === 401 || source.status === 403 || source.status === 302 ? 401 : source.status === 404 ? 404 : 502;
      return json(response, status, { error: status === 401 ? 'BDYC 登录失效，请重新登录。' :
        status === 404 ? 'BDYC 未找到该图纸。' : 'BDYC 未返回图纸原始文件。' });
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename) });
    await pipeline(Readable.fromWeb(source.body), response);
  } catch {
    if (!response.headersSent) json(response, 502, { error: '连接 BDYC 或读取图纸失败。' });
  } finally {
    response.removeListener('close', cancel);
  }
}
