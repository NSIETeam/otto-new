import { createMarketReadiness } from './fleaMarketReadiness.js';
import { marketSearchPending } from './fleaMarketSearchIndex.js';
import { processMarketImage } from './fleaMarketImageProcessing.js';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createParkContactAttachments } from '../../collaboration/parkContactAttachments.js';
import { parkMlsSignaturePayload } from '../../collaboration/parkContactMls.js';
import { verify } from 'node:crypto';
import { backfillMarketSearch } from './fleaMarketSearchIndex.js';
import { hasParkContactPrivateAuthority } from '../../collaboration/parkContactPrivateAuthority.js';
import type { MarketImageQuota } from './fleaMarketStorageQuota.js';
import {
  createParkContactMls,
  type ParkMlsCommand,
  type ParkMlsPacket,
} from '../../collaboration/parkContactMls.js';
import { MarketError } from './fleaMarketTypes.js';
import { createMarketContacts } from './fleaMarketContacts.js';
import {
  verifyParkCiphertext,
  type ParkCiphertextInput,
} from '../../collaboration/parkContactCiphertext.js';
import { readParkContactDirectory } from '../../collaboration/parkContactDirectory.js';
import { createMarketRoles } from './fleaMarketRoles.js';
import type { MarketTransaction } from './fleaMarketRepository.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecurringTaskRegistry } from 'otto-core';
import type { MarketObjectStore } from './fleaMarketObjectStore.js';
import type { MarketServiceDependencies } from './fleaMarketService.js';
import { createMarketService } from './fleaMarketService.js';
import { createMarketSettings } from './fleaMarketSettings.js';
import { createMarketGovernance } from './fleaMarketGovernance.js';
import { createMarketModeration } from './fleaMarketModeration.js';
import { createMarketAttachments } from './fleaMarketAttachments.js';
import { createMarketInbox } from './fleaMarketInbox.js';
import { runMarketJobs } from './fleaMarketJobs.js';
import {
  canDiscover,
  canModerate,
  samePark,
  requireActive,
} from './fleaMarketAccess.js';
import type { Listing } from './fleaMarketTypes.js';
export function createMarketApplication(
  input: Omit<MarketServiceDependencies, 'config'> & {
    objects: MarketObjectStore;
    imageQuota?: MarketImageQuota;
    reuseEnterpriseConversations?: boolean;
    ready?: () => boolean;
    localAcceptance?: boolean;
    localDatabaseProbe?(): Promise<void>;
    requiresMls?: () => boolean;
    canAssign?(
      tx: MarketTransaction,
      actor: string,
      park: string,
    ): Promise<boolean>;
  },
) {
  const readiness = createMarketReadiness({
    localAcceptance: input.localAcceptance === true,
    probes: {
      isolation: async () => {
        if (input.localAcceptance) await input.localDatabaseProbe?.();
      },
      database: async () => {
        await input.repository.read(async (tx) => {
          for (const table of [
            'park_market_listings',
            'park_market_search_documents',
            'park_market_search_terms',
            'park_market_maintenance',
            'park_contact_attachments',
            'park_contact_mls_sessions',
          ])
            await tx.all(`SELECT * FROM ${table} LIMIT 0`);
        });
      },
      encryption: async () => {
        const value = randomUUID();
        const context = 'park-market-readiness';
        if (
          input.cipher.decryptText(
            input.cipher.encryptText(value, context),
            context,
          ) !== value
        )
          throw new Error('cipher probe failed');
      },
      objects: async () => {
        const content = Buffer.from(randomUUID());
        const object = await input.objects.put({
          namespace: 'park-market-readiness',
          objectId: randomUUID(),
          content,
        });
        try {
          if (!(await input.objects.read(object.key)).equals(content))
            throw new Error('object probe failed');
        } finally {
          await input.objects.delete(object.key);
        }
      },
      images: async () => {
        await processMarketImage(
          await sharp({
            create: { width: 2, height: 2, channels: 3, background: '#557799' },
          })
            .png()
            .toBuffer(),
        );
      },
    },
  });
  const settings = createMarketSettings(
    input,
    input.ready ?? (() => readiness.status().ready),
  );
  const deps: MarketServiceDependencies = { ...input, config: settings.config };
  const mls = createParkContactMls({
    now: input.now ?? Date.now,
    async authorize(tx, actorId, conversationId, write) {
      const actor = await input.principal(tx, actorId);
      requireActive(actor);
      const [thread] = await tx.all(
        'SELECT * FROM park_market_conversations WHERE id=? AND (account_a=? OR account_b=?)',
        [conversationId, actorId, actorId],
      );
      if (!thread) throw new MarketError('NOT_FOUND');
      const parkId = String(thread.park_id);
      const a = String(thread.account_a);
      const b = String(thread.account_b);
      if (write) {
        if (
          !samePark(actor, parkId) ||
          !samePark(await input.principal(tx, a === actorId ? b : a), parkId)
        )
          throw new MarketError('FORBIDDEN');
        if (
          (
            await tx.all(
              'SELECT park_id FROM park_market_blocks WHERE park_id=? AND ((blocker_id=? AND peer_id=?) OR (blocker_id=? AND peer_id=?))',
              [parkId, a, b, b, a],
            )
          ).length
        )
          throw new MarketError('FORBIDDEN');
        if (
          thread.state !== 'active' &&
          !canDiscover(actor, await settings.config(tx, parkId), parkId)
        )
          throw new MarketError('FORBIDDEN');
      }
      return { parkId, a, b };
    },
  });
  const attachments = createMarketAttachments({
    ...input,
    async listingReadable(tx, actor, id) {
      const [row] = await tx.all(
        'SELECT payload FROM park_market_listings WHERE id=?',
        [id],
      );
      if (!row) return false;
      const item: Listing = JSON.parse(
        input.cipher.decryptText(
          JSON.parse(String(row.payload)),
          `park-market-listing:${id}`,
        ),
      );
      if (
        !samePark(actor, item.parkId) ||
        !samePark(await input.principal(tx, item.ownerId), item.parkId) ||
        ['removed', 'deleted'].includes(item.state) ||
        item.cleanedAt !== null
      )
        return false;
      if (actor.accountId === item.ownerId) return true;
      const grants = await tx.all(
        'SELECT listing_id FROM park_market_grants WHERE park_id=? AND listing_id=? AND account_id=? LIMIT 1',
        [item.parkId, id, actor.accountId],
      );
      if (grants.length) return true;
      return (
        ['active', 'reserved'].includes(item.state) &&
        item.expiresAt > (input.now ?? Date.now)() &&
        canDiscover(actor, await settings.config(tx, item.parkId), item.parkId)
      );
    },
    async evidenceReadable(tx, actor, id) {
      for (const table of ['reports', 'appeals']) {
        const [row] = await tx.all(
          `SELECT park_id,closed_at FROM park_market_${table} WHERE id=?`,
          [id],
        );
        if (
          row &&
          canModerate(actor, String(row.park_id)) &&
          (row.closed_at === null ||
            Number(row.closed_at) + 180 * 86400000 > (input.now ?? Date.now)())
        )
          return true;
      }
      return false;
    },
  });
  const chatAttachments = createParkContactAttachments({
    ...input,
    quota: input.imageQuota,
    async deviceAllowed(tx, actor, device) {
      return (
        (
          await tx.all(
            "SELECT device_id FROM e2ee_devices WHERE account_id=? AND device_id=? AND approval_state='approved' AND revoked_at IS NULL",
            [actor, device],
          )
        ).length > 0
      );
    },
  });
  const runJobs = async () => {
    await backfillMarketSearch(deps);
    await runMarketJobs(deps);
    await attachments.cleanup();
    await chatAttachments.cleanup();
  };
  let stopWorker: (() => void) | undefined;
  return {
    initialize: readiness.initialize,
    readiness: readiness.status,
    chatAttachments,
    async authorizeAttachmentDevice(
      actor: string,
      action: 'attachment-upload' | 'attachment-read',
      command: {
        deviceId: string;
        signature: string;
        payload: Record<string, unknown>;
      },
    ) {
      return input.repository.read(async (tx) => {
        requireActive(await input.principal(tx, actor));
        const [device] = await tx.all(
          "SELECT identity_signing_public_key FROM e2ee_devices WHERE account_id=? AND device_id=? AND approval_state='approved' AND revoked_at IS NULL",
          [actor, command.deviceId],
        );
        if (
          !device ||
          typeof command.signature !== 'string' ||
          command.signature.length > 100 ||
          !verify(
            null,
            parkMlsSignaturePayload(
              action,
              actor,
              command.deviceId,
              command.payload,
            ),
            String(device.identity_signing_public_key),
            Buffer.from(command.signature, 'base64'),
          )
        )
          throw new MarketError('FORBIDDEN', 'device');
      });
    },
    async mls(actor: string, command: ParkMlsCommand) {
      return input.repository.transaction(async (tx) => {
        requireActive(await input.principal(tx, actor));
        return mls.execute(tx, actor, command);
      });
    },
    contacts: createMarketContacts({
      ...deps,
      bindAttachments: chatAttachments.bind,
      directory: readParkContactDirectory,
      async privateConversation(tx, a, b) {
        if (!input.reuseEnterpriseConversations) return false;
        const first = await input.principal(tx, a);
        const second = await input.principal(tx, b);
        if (!first?.active || !second?.active) return false;
        return hasParkContactPrivateAuthority(tx, first, second);
      },
      async verifyMessage(tx, context, envelope) {
        if ((envelope as ParkMlsPacket)?.encryption === 'mls')
          return mls.verify(
            tx,
            context.senderId,
            context.conversationId,
            context.messageId,
            envelope as ParkMlsPacket,
          );
        if (
          input.requiresMls?.() ||
          (
            await tx.all(
              'SELECT generation FROM park_contact_mls_sessions WHERE conversation_id=? LIMIT 1',
              [context.conversationId],
            )
          ).length
        )
          throw new MarketError('FORBIDDEN', 'encryption');
        const sender = await input.principal(tx, context.senderId);
        const recipient = await input.principal(tx, context.recipientId);
        if (!sender || !recipient)
          throw new Error('contact identity unavailable');
        const directory = await readParkContactDirectory(tx, [
          sender,
          recipient,
        ]);
        const devices = directory
          .flatMap((d) => d.devices)
          .filter((d) => d.approvalState === 'approved' && !d.revokedAt);
        const message = envelope as ParkCiphertextInput;
        if (message?.messageId !== context.messageId)
          throw new Error('contact message identifier mismatch');
        const verified = verifyParkCiphertext({
          parkId: context.parkId,
          senderId: context.senderId,
          recipientId: context.recipientId,
          message,
          approvedDevices: devices,
        });
        return {
          ...verified,
          senderIdentitySigningPublicKey: devices.find(
            (d) =>
              d.accountId === context.senderId &&
              d.deviceId === verified.senderDeviceId,
          )!.identitySigningPublicKey,
        };
      },
    }),
    market: createMarketService(deps),
    settings: {
      ...settings,
      async read(actor: string) {
        const value = await settings.read(actor);
        const canAssign = value.parkId
          ? await input.repository.read(
              (tx) =>
                input.canAssign?.(tx, actor, value.parkId!) ??
                Promise.resolve(false),
            )
          : false;
        const searchPending = value.parkId
          ? await input.repository.read((tx) =>
              marketSearchPending(tx, value.parkId!),
            )
          : false;
        return {
          ...value,
          canAssign,
          dependencies: readiness.status(),
          search: {
            state: searchPending ? 'backfilling' : 'ready',
            batchSize: 100,
            retryAfterMs: 60000,
          },
        };
      },
    },
    attachments,
    roles: createMarketRoles({
      ...input,
      canAssign: input.canAssign ?? (async () => false),
    }),
    governance: createMarketGovernance(deps),
    moderation: createMarketModeration(deps),
    inbox: createMarketInbox(deps),
    runJobs,
    start(registry: RecurringTaskRegistry) {
      if (stopWorker) return stopWorker;
      let stopped=false;
      const unregister = registry.register({
        name: 'enterprise.park-flea-market.maintenance',
        source:
          'packages/server/src/modules/park_services/flea_market/fleaMarketApplication.ts',
        intervalMs: 60_000,
        estimatedCostUsdPerRun: 0,
        getInputVersion: () =>
          String(Math.floor((input.now ?? Date.now)() / 60_000)),
        run: async () => {
          if(stopped)return;
          try {
            await runJobs();
          } catch (error) {
            if(!stopped)readiness.worker(false);
            throw error;
          }
          if(!stopped)readiness.worker(true);
        },
      });
      stopWorker = () => {
        if(stopped)return;
        stopped=true;
        readiness.worker(false);
        unregister?.();
        stopWorker = undefined;
      };
      readiness.worker(true);
      void readiness.initialize();
      return stopWorker;
    },
  };
}
export type MarketApplication = ReturnType<typeof createMarketApplication>;
