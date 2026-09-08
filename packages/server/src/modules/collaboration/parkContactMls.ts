/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID, verify } from 'node:crypto';
import type { ParkDirectoryReader } from './parkContactDirectory.js';
export interface ParkMlsAuthority {
  park_id: string;
  conversation_id: string;
  generation: number;
  members: string[];
}
export interface ParkMlsKey {
  device_scope: string;
  reference: string;
  key_package: string;
}
export interface ParkMlsCommand {
  action: 'package' | 'state' | 'activate';
  deviceId: string;
  payload: Record<string, unknown>;
  signature: string;
}
export interface ParkMlsPacket {
  encryption: 'mls';
  messageId: string;
  deviceId: string;
  payload: {
    conversationId: string;
    generation: number;
    groupId: string;
    epoch: number;
    ciphertext: string;
    eventId: string;
  };
  signature: string;
}
interface Tx extends ParkDirectoryReader {
  run(sql: string, values?: unknown[]): Promise<number>;
}
interface Device extends Record<string, unknown> {
  organization_id: string;
  account_id: string;
  device_id: string;
  identity_signing_public_key: string;
}
export const PARK_CONTACT_MLS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_contact_mls_keys (
 reference TEXT PRIMARY KEY,device_scope TEXT NOT NULL,account_id TEXT NOT NULL,device_id TEXT NOT NULL,key_package TEXT NOT NULL,
 created_at BIGINT NOT NULL,claimed_by TEXT
);
CREATE INDEX IF NOT EXISTS park_contact_mls_key_inventory ON park_contact_mls_keys(account_id,device_id,claimed_by);
CREATE TABLE IF NOT EXISTS park_contact_mls_sessions (
 conversation_id TEXT NOT NULL,generation INTEGER NOT NULL,park_id TEXT NOT NULL,state TEXT NOT NULL,
 authority TEXT NOT NULL,packages TEXT NOT NULL,initializer TEXT NOT NULL,lease_id TEXT NOT NULL,lease_until BIGINT NOT NULL,
 group_id TEXT,welcome TEXT,PRIMARY KEY(conversation_id,generation)
);`;
export function parkMlsSignaturePayload(
  action: string,
  accountId: string,
  deviceId: string,
  payload: unknown,
) {
  return Buffer.from(
    JSON.stringify([
      'otto:park-market-mls:v1',
      action,
      accountId,
      deviceId,
      payload,
    ]),
  );
}
function base64(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max * 2)
    throw new Error('invalid MLS payload');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value)
    throw new Error('invalid MLS payload');
  return value;
}
async function device(
  tx: Tx,
  accountId: string,
  deviceId: string,
): Promise<Device> {
  const [row] = await tx.all<Device>(
    "SELECT organization_id,account_id,device_id,identity_signing_public_key FROM e2ee_devices WHERE account_id=? AND device_id=? AND approval_state='approved' AND revoked_at IS NULL",
    [accountId, deviceId],
  );
  if (!row) throw new Error('MLS device is not approved');
  return row;
}
async function signed(
  tx: Tx,
  account: string,
  action: string,
  command: Pick<ParkMlsCommand, 'deviceId' | 'payload' | 'signature'>,
) {
  const sender = await device(tx, account, command.deviceId);
  if (
    !verify(
      null,
      parkMlsSignaturePayload(
        action,
        account,
        command.deviceId,
        command.payload,
      ),
      sender.identity_signing_public_key,
      Buffer.from(base64(command.signature, 64), 'base64'),
    )
  )
    throw new Error('invalid MLS device signature');
  return sender;
}
async function roster(tx: Tx, a: string, b: string, serverHash: string) {
  const rows = await tx.all<Device>(
    "SELECT organization_id,account_id,device_id,identity_signing_public_key FROM e2ee_devices WHERE account_id IN (?,?) AND approval_state='approved' AND revoked_at IS NULL ORDER BY organization_id,account_id,device_id",
    [a, b],
  );
  if (![a, b].every((id) => rows.some((d) => d.account_id === id)))
    throw new Error('MLS recipient device unavailable');
  return rows
    .map(
      (d) =>
        `${serverHash}/${d.organization_id}/${d.account_id}/${d.device_id}`,
    )
    .sort();
}
export function createParkContactMls(deps: {
  now(): number;
  authorize(
    tx: Tx,
    actor: string,
    conversationId: string,
    write: boolean,
  ): Promise<{ parkId: string; a: string; b: string }>;
}) {
  return {
    async execute(tx: Tx, actor: string, command: ParkMlsCommand) {
      if (
        !command ||
        !['package', 'state', 'activate'].includes(command.action) ||
        !command.payload ||
        typeof command.payload !== 'object'
      )
        throw new Error('invalid MLS operation');
      const sender = await signed(tx, actor, command.action, command);
      const input = command.payload;
      if (command.action === 'package') {
        const scope = String(input.device_scope);
        const reference = String(input.reference);
        const parts = scope.split('/');
        if (
          parts.length !== 4 ||
          !/^[a-f0-9]{64}$/.test(parts[0]) ||
          parts[1] !== sender.organization_id ||
          parts[2] !== actor ||
          parts[3] !== sender.device_id ||
          !/^[a-f0-9]{64}$/.test(reference)
        )
          throw new Error('invalid MLS key identity');
        const key = base64(input.key_package, 128 * 1024);
        const [existing] = await tx.all(
          'SELECT * FROM park_contact_mls_keys WHERE reference=?',
          [reference],
        );
        if (existing) {
          if (existing.device_scope !== scope || existing.key_package !== key)
            throw new Error('MLS key conflict');
          return {
            usable:
              !existing.claimed_by &&
              Number(existing.created_at) + 86400000 > deps.now(),
          };
        }
        const [{ count }] = await tx.all(
          'SELECT COUNT(*) AS count FROM park_contact_mls_keys WHERE device_scope=? AND claimed_by IS NULL AND created_at>?',
          [scope, deps.now() - 86400000],
        );
        if (Number(count) >= 20) throw new Error('MLS key inventory limit');
        await tx.run(
          'INSERT INTO park_contact_mls_keys VALUES (?,?,?,?,?,?,NULL)',
          [reference, scope, actor, sender.device_id, key, deps.now()],
        );
        return { usable: true };
      }
      const id = String(input.conversationId);
      const authority = await deps.authorize(
        tx,
        actor,
        id,
        command.action === 'activate' || input.prepare === true,
      );
      const scope = String(input.deviceScope);
      const parts = scope.split('/');
      if (
        parts.length !== 4 ||
        !/^[a-f0-9]{64}$/.test(parts[0]) ||
        parts[1] !== sender.organization_id ||
        parts[2] !== actor ||
        parts[3] !== sender.device_id
      )
        throw new Error('invalid MLS device scope');
      let sessions = await tx.all(
        'SELECT * FROM park_contact_mls_sessions WHERE conversation_id=? ORDER BY generation',
        [id],
      );
      let current = sessions.at(-1);
      const members =
        command.action === 'activate' || input.prepare === true
          ? await roster(tx, authority.a, authority.b, parts[0])
          : null;
      if (command.action === 'activate') {
        if (
          !current ||
          current.state !== 'preparing' ||
          current.initializer !== scope ||
          Number(current.generation) !== input.generation ||
          current.lease_id !== input.leaseId ||
          Number(current.lease_until) <= deps.now() ||
          JSON.stringify(JSON.parse(String(current.authority)).members) !==
            JSON.stringify(members)
        )
          throw new Error('MLS preparation changed');
        await tx.run(
          "UPDATE park_contact_mls_sessions SET state='active',group_id=?,welcome=? WHERE conversation_id=? AND generation=?",
          [
            base64(input.groupId, 256),
            base64(input.welcome, 2 * 1024 * 1024),
            id,
            input.generation,
          ],
        );
        return { activated: true };
      }
      if (
        input.recoverGeneration !== undefined &&
        (input.prepare !== true ||
          !Number.isSafeInteger(input.recoverGeneration) ||
          input.recoverGeneration !== Number(current?.generation))
      )
        throw new Error('MLS recovery generation changed');
      if (
        input.prepare === true &&
        (input.recoverGeneration !== undefined ||
          !current ||
          current.state === 'retired' ||
          JSON.stringify(JSON.parse(String(current.authority)).members) !==
            JSON.stringify(members) ||
          (current.state === 'preparing' &&
            Number(current.lease_until) <= deps.now()))
      ) {
        if (current)
          await tx.run(
            "UPDATE park_contact_mls_sessions SET state='retired' WHERE conversation_id=? AND generation=?",
            [id, current.generation],
          );
        const generation = Number(current?.generation ?? 0) + 1;
        const packages: ParkMlsKey[] = [];
        for (const member of members!) {
          if (member === scope) continue;
          const [key] = await tx.all(
            'SELECT * FROM park_contact_mls_keys WHERE device_scope=? AND claimed_by IS NULL AND created_at>? ORDER BY created_at,reference LIMIT 1',
            [member, deps.now() - 86400000],
          );
          if (!key)
            throw new Error(
              'MLS recipient key packages unavailable; recipient must sign in once',
            );
          packages.push({
            device_scope: member,
            reference: String(key.reference),
            key_package: String(key.key_package),
          });
          await tx.run(
            'UPDATE park_contact_mls_keys SET claimed_by=? WHERE reference=? AND claimed_by IS NULL',
            [`${id}:${generation}`, key.reference],
          );
        }
        const nativeAuthority: ParkMlsAuthority = {
          park_id: authority.parkId,
          conversation_id: id,
          generation,
          members: members!,
        };
        await tx.run(
          'INSERT INTO park_contact_mls_sessions VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)',
          [
            id,
            generation,
            authority.parkId,
            'preparing',
            JSON.stringify(nativeAuthority),
            JSON.stringify(packages),
            scope,
            randomUUID(),
            deps.now() + 60000,
          ],
        );
        sessions = await tx.all(
          'SELECT * FROM park_contact_mls_sessions WHERE conversation_id=? ORDER BY generation',
          [id],
        );
        current = sessions.at(-1);
      }
      return {
        generation: current ? Number(current.generation) : null,
        sessions: sessions
          .filter((s) =>
            (
              JSON.parse(String(s.authority)) as ParkMlsAuthority
            ).members.includes(scope),
          )
          .map((s) => ({
            generation: Number(s.generation),
            state: String(s.state),
            authority: JSON.parse(String(s.authority)) as ParkMlsAuthority,
            groupId: s.group_id === null ? null : String(s.group_id),
            welcome: s.welcome === null ? null : String(s.welcome),
            reference:
              (JSON.parse(String(s.packages)) as ParkMlsKey[]).find(
                (p) => p.device_scope === scope,
              )?.reference ?? null,
            initialization:
              s.state === 'preparing' && s.initializer === scope
                ? {
                    leaseId: String(s.lease_id),
                    packages: JSON.parse(String(s.packages)) as ParkMlsKey[],
                  }
                : null,
          })),
      };
    },
    async verify(
      tx: Tx,
      actor: string,
      conversationId: string,
      messageId: string,
      packet: ParkMlsPacket,
    ) {
      if (
        packet.encryption !== 'mls' ||
        packet.messageId !== messageId ||
        packet.payload?.conversationId !== conversationId ||
        packet.payload.eventId !== `${actor}:${messageId}`
      )
        throw new Error('invalid MLS message context');
      const sender = await signed(tx, actor, 'message', packet);
      const grant = await deps.authorize(tx, actor, conversationId, true);
      const [session] = await tx.all(
        'SELECT * FROM park_contact_mls_sessions WHERE conversation_id=? ORDER BY generation DESC LIMIT 1',
        [conversationId],
      );
      if (
        !session ||
        session.state !== 'active' ||
        Number(session.generation) !== packet.payload.generation ||
        session.group_id !== packet.payload.groupId ||
        packet.payload.epoch !== 1
      )
        throw new Error('MLS session changed');
      const authority = JSON.parse(
        String(session.authority),
      ) as ParkMlsAuthority;
      const serverHash = authority.members[0].split('/')[0];
      const scope = `${serverHash}/${sender.organization_id}/${actor}/${sender.device_id}`;
      if (
        !authority.members.includes(scope) ||
        JSON.stringify(authority.members) !==
          JSON.stringify(await roster(tx, grant.a, grant.b, serverHash))
      )
        throw new Error('MLS approved device roster changed');
      base64(packet.payload.ciphertext, 64 * 1024);
      return { ...packet, senderScope: scope, authority };
    },
  };
}
