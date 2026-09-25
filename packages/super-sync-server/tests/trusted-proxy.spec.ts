import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromEnv } from '../src/config';

afterEach(() => vi.unstubAllEnvs());

describe('trusted reverse-proxy addresses', () => {
  it.each(['true', '1', '*', '10.88.0.0/16', '10.88.0.1,'])(
    'rejects unsafe or malformed configuration %s',
    (value) => {
      vi.stubEnv('TRUST_PROXY_ADDRESSES', value);
      expect(() => loadConfigFromEnv()).toThrow('comma-separated IP addresses');
    },
  );

  it.each([
    {
      configured: '',
      peer: '10.88.0.1',
      ip: '10.88.0.1',
      protocol: 'http',
      hostname: 'origin.test',
    },
    {
      configured: '10.88.0.1, ::1',
      peer: '10.88.0.1',
      ip: '203.0.113.25',
      protocol: 'https',
      hostname: 'proxy.test',
    },
    {
      configured: '10.88.0.1',
      peer: '198.51.100.8',
      ip: '198.51.100.8',
      protocol: 'http',
      hostname: 'origin.test',
    },
    {
      configured: '10.88.0.1',
      peer: '::ffff:10.88.0.1',
      ip: '203.0.113.25',
      protocol: 'https',
      hostname: 'proxy.test',
    },
  ])(
    'only trusts the configured immediate peer: $peer ($configured)',
    async ({ configured, peer, ip, protocol, hostname }) => {
      vi.stubEnv('TRUST_PROXY_ADDRESSES', configured);
      const config = loadConfigFromEnv();
      const server = Fastify({ trustProxy: config.trustedProxyAddresses ?? false });
      server.get('/', (request) => ({
        ip: request.ip,
        protocol: request.protocol,
        hostname: request.hostname,
      }));
      try {
        const response = await server.inject({
          url: '/',
          remoteAddress: peer,
          headers: {
            host: 'origin.test',
            'x-forwarded-for': '192.0.2.7, 203.0.113.25',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'proxy.test',
          },
        });
        expect(response.json()).toEqual({ ip, protocol, hostname });
      } finally {
        await server.close();
      }
    },
  );
});
