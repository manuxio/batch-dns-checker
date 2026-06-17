import dgram from 'node:dgram';
import net from 'node:net';
import dnsPacket from 'dns-packet';
import { config } from '../config';

/**
 * Minimal low-level DNS client used for iterative resolution. Unlike Node's
 * built-in resolver (c-ares), this lets us:
 *  - send queries to a specific server with recursion disabled (RD=0),
 *  - read the AUTHORITY and ADDITIONAL sections (referrals + glue),
 *  - get authoritative, uncached answers straight from the source.
 *
 * This is essential for a compliance checker: every record value is read
 * directly from the zone's authoritative nameservers, never via a caching
 * recursive resolver.
 */

export interface DnsRecord {
  name: string;
  type: string;
  ttl?: number;
  // dns-packet record data is a union per type; callers narrow by `type`.
  data: unknown;
}

export interface DnsResponse {
  rcode: string;
  authoritative: boolean;
  truncated: boolean;
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

function randomId(): number {
  return Math.floor(Math.random() * 65535);
}

function buildQuery(name: string, type: string): Buffer {
  return dnsPacket.encode({
    type: 'query',
    id: randomId(),
    flags: 0, // RD=0: we resolve iteratively ourselves
    questions: [{ type: type as dnsPacket.RecordType, name }],
    // EDNS0 with a large UDP payload to reduce truncation.
    additionals: [
      { type: 'OPT', name: '.', udpPayloadSize: 4096 } as dnsPacket.OptAnswer,
    ],
  });
}

interface DecodedLike {
  rcode?: string;
  flag_aa?: boolean;
  flag_tc?: boolean;
  answers?: dnsPacket.Answer[];
  authorities?: dnsPacket.Answer[];
  additionals?: dnsPacket.Answer[];
}

function toResponse(packet: dnsPacket.DecodedPacket): DnsResponse {
  const decoded = packet as unknown as DecodedLike;
  const records = (list: dnsPacket.Answer[] | undefined): DnsRecord[] =>
    (list ?? []).map((r) => ({
      name: r.name,
      type: r.type,
      ttl: (r as { ttl?: number }).ttl,
      data: (r as { data?: unknown }).data,
    }));
  return {
    rcode: decoded.rcode ?? 'NOERROR',
    authoritative: Boolean(decoded.flag_aa),
    truncated: Boolean(decoded.flag_tc),
    answers: records(decoded.answers),
    authorities: records(decoded.authorities),
    additionals: records(decoded.additionals),
  };
}

function timeoutError(): NodeJS.ErrnoException {
  return Object.assign(new Error('dns query timeout'), { code: 'ETIMEOUT' });
}

function queryUdp(
  server: string,
  name: string,
  type: string,
  timeoutMs: number,
): Promise<DnsResponse> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(timeoutError())), timeoutMs);

    socket.on('message', (msg) => {
      done(() => {
        try {
          resolve(toResponse(dnsPacket.decode(msg)));
        } catch (err) {
          reject(err);
        }
      });
    });
    socket.on('error', (err) => done(() => reject(err)));
    socket.send(buildQuery(name, type), 53, server, (err) => {
      if (err) done(() => reject(err));
    });
  });
}

function queryTcp(
  server: string,
  name: string,
  type: string,
  timeoutMs: number,
): Promise<DnsResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server, port: 53 });
    const query = buildQuery(name, type);
    const lengthPrefix = Buffer.alloc(2);
    lengthPrefix.writeUInt16BE(query.length, 0);

    let buffer = Buffer.alloc(0);
    let expectedLength = -1;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(timeoutError())), timeoutMs);

    socket.on('connect', () =>
      socket.write(Buffer.concat([lengthPrefix, query])),
    );
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength < 0 && buffer.length >= 2) {
        expectedLength = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);
      }
      if (expectedLength >= 0 && buffer.length >= expectedLength) {
        done(() => {
          try {
            resolve(toResponse(dnsPacket.decode(buffer.subarray(0, expectedLength))));
          } catch (err) {
            reject(err);
          }
        });
      }
    });
    socket.on('error', (err) => done(() => reject(err)));
  });
}

/** Sends one DNS query to a specific server (UDP, TCP fallback on truncation). */
export async function dnsQuery(
  server: string,
  name: string,
  type: string,
  timeoutMs: number = config.dnsTimeoutMs,
): Promise<DnsResponse> {
  const response = await queryUdp(server, name, type, timeoutMs);
  if (response.truncated) {
    return queryTcp(server, name, type, timeoutMs);
  }
  return response;
}
