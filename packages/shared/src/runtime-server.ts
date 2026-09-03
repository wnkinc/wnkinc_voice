/**
 * The AgentCore Runtime HTTP contract, hand-rolled so a single-file bundle has
 * no deps: `GET /ping` -> {"status":"Healthy"}, `POST /invocations` -> the
 * handler's JSON result (500 + {ok:false,error} when it throws). Listens on
 * 0.0.0.0:8080. Every agent is one call to this plus its handler.
 */
import * as http from 'node:http';
import { traceContextFromHeaders, type TraceContext } from './trace.js';

export type RuntimeHandler<P> = (payload: P, trace: TraceContext) => Promise<unknown>;

export function runtimeServer<P>(name: string, handler: RuntimeHandler<P>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/invocations')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const trace = traceContextFromHeaders(req.headers);
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as P;
            const result = await handler(payload, trace);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
          } catch (err) {
            console.error(JSON.stringify({ msg: 'invocation failed', err: String(err), ...trace }));
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
          }
        })();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ msg: `${name} listening`, port: 8080 })));
  return server;
}
