import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  json: unknown;
}

type Responder = (request: ReceivedRequest, res: http.ServerResponse) => void;

/** A local stand-in for an OpenAI-compatible JSON API (chat, models). */
export async function startFakeOpenAi(respond: Responder) {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        json: raw ? (JSON.parse(raw) as unknown) : null,
      };
      received.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    received,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const chatReply = (content: string) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});
