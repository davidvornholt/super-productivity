import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('serves public assets without bypassing guarded paths through normalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supersync-static-test-'));
  const server = Fastify();
  try {
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'public.txt'), 'public asset');
    await writeFile(join(root, 'private', 'secret.txt'), 'guarded fixture');
    server.get('/private/*', async (_, reply) => reply.code(401).send('unauthorized'));
    await server.register(fastifyStatic, { root, prefix: '/' });
    expect((await server.inject('/public.txt')).body).toBe('public asset');
    expect((await server.inject('/private/secret.txt')).statusCode).toBe(401);
    for (const url of [
      '/other/../private/secret.txt',
      '/other/%2e%2e/private/secret.txt',
      '/other/%2E%2E/private/secret.txt',
      '/private%2fsecret.txt',
      '/private/secret.txt/.',
    ]) {
      const response = await server.inject({ url });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.body, url).not.toContain('guarded fixture');
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
