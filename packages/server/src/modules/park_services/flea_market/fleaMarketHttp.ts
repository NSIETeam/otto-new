import type { ParkMlsCommand } from '../../collaboration/parkContactMls.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MarketApplication } from './fleaMarketApplication.js';
import { MarketError } from './fleaMarketTypes.js';
import type { MarketFilters } from './fleaMarketDiscovery.js';
export interface MarketHttpInput {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: { id: string } | null;
  application: MarketApplication;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}
async function imageBody(req: IncomingMessage) {
  const max = 20 * 1024 * 1024;
  if (Number(req.headers['content-length'] ?? 0) > max)
    throw new MarketError('INVALID_INPUT', 'imageSize');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > max) throw new MarketError('INVALID_INPUT', 'imageSize');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function handleMarketHttp(
  input: MarketHttpInput,
): Promise<boolean> {
  const prefix = '/enterprise/park-market';
  if (input.path !== prefix && !input.path.startsWith(`${prefix}/`))
    return false;
  const { res, req, method, application: app } = input;
  const send = (data: unknown) => input.sendJSON(res, 200, data);
  res.setHeader('Cache-Control', 'private, no-store');
  if (!input.memberAccount) {
    input.sendJSON(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }
  const actor = input.memberAccount.id;
  try {
    const parts = input.path
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const [resource, id, action] = parts;
    if (parts.length > 3) throw new MarketError('NOT_FOUND');
    if (
      resource === 'listings' &&
      id &&
      action === 'hide' &&
      method === 'POST'
    ) {
      send(await app.market.hide(actor, id));
      return true;
    }
    if (resource === 'roles' && id && !action && method === 'GET') {
      send(await app.roles.list(actor, id));
      return true;
    }
    if (resource === 'mls' && !id && method === 'POST') {
      send(
        await app.mls(
          actor,
          (await input.readBody(req)) as unknown as ParkMlsCommand,
        ),
      );
      return true;
    }
    if (resource === 'contacts' && !id && method === 'GET') {
      send(
        await app.contacts.inbox(
          actor,
          input.url.searchParams.get('cursor') ?? undefined,
        ),
      );
      return true;
    }
    if (
      resource === 'contact-prepare' &&
      id &&
      ['listing', 'conversation'].includes(id) &&
      action &&
      method === 'GET'
    ) {
      send(
        await app.contacts.prepare(
          actor,
          id as 'listing' | 'conversation',
          action,
        ),
      );
      return true;
    }
    if (
      resource === 'listings' &&
      id &&
      action === 'contact' &&
      method === 'POST'
    ) {
      send(await app.contacts.contact(actor, id, await input.readBody(req)));
      return true;
    }
    if (resource === 'contacts' && id && !action && method === 'POST') {
      send(await app.contacts.resolve(actor, id, await input.readBody(req)));
      return true;
    }
    if (
      resource === 'conversations' &&
      id &&
      action === 'items' &&
      method === 'GET'
    ) {
      send(
        await app.contacts.associated(
          actor,
          id,
          input.url.searchParams.has('beforeSequence')
            ? Number(input.url.searchParams.get('beforeSequence'))
            : undefined,
        ),
      );
      return true;
    }
    if (resource === 'conversations' && id && !action && method === 'GET') {
      send(
        await app.contacts.messages(
          actor,
          id,
          input.url.searchParams.has('beforeSequence')
            ? Number(input.url.searchParams.get('beforeSequence'))
            : undefined,
        ),
      );
      return true;
    }
    if (resource === 'conversations' && id && !action && method === 'POST') {
      send(await app.contacts.send(actor, id, await input.readBody(req)));
      return true;
    }
    if (
      resource === 'conversations' &&
      id &&
      action === 'read' &&
      method === 'POST'
    ) {
      const body = await input.readBody(req);
      send(
        await app.contacts.read(
          actor,
          id,
          body.throughSequence === undefined
            ? undefined
            : Number(body.throughSequence),
        ),
      );
      return true;
    }
    if (resource === 'blocks' && id && !action && method === 'PUT') {
      send(await app.contacts.block(actor, id, await input.readBody(req)));
      return true;
    }

    if (method === 'GET' && !resource) {
      const params = input.url.searchParams;
      const filters: MarketFilters = {};
      for (const key of ['query', 'category', 'sort', 'cursor'] as const)
        if (params.has(key)) Object.assign(filters, { [key]: params.get(key) });
      for (const key of ['minCents', 'maxCents'] as const)
        if (params.has(key)) filters[key] = Number(params.get(key));
      for (const key of ['free', 'unreserved'] as const)
        if (params.has(key)) {
          if (!['true', 'false'].includes(params.get(key)!))
            throw new MarketError('INVALID_INPUT', key);
          filters[key] = params.get(key) === 'true';
        }
      send(await app.market.discover(actor, filters));
    } else if (resource === 'settings' && method === 'GET' && !id)
      send(await app.settings.read(actor));
    else if (resource === 'settings' && method === 'PUT' && id && !action)
      send(await app.settings.update(actor, id, await input.readBody(req)));
    else if (resource === 'mine' && method === 'GET' && !id)
      send({ items: await app.market.mine(actor) });
    else if (resource === 'listings' && !id && method === 'POST')
      send(await app.market.publish(actor, await input.readBody(req)));
    else if (resource === 'listings' && id && !action && method === 'GET')
      send(await app.market.detail(actor, id));
    else if (resource === 'listings' && id && !action && method === 'PUT')
      send(await app.market.edit(actor, id, await input.readBody(req)));
    else if (
      resource === 'listings' &&
      id &&
      action === 'report' &&
      method === 'POST'
    )
      send(await app.moderation.report(actor, id, await input.readBody(req)));
    else if (
      resource === 'listings' &&
      id &&
      action === 'appeal' &&
      method === 'POST'
    )
      send(await app.governance.appeal(actor, id, await input.readBody(req)));
    else if (resource === 'listings' && id && action && method === 'POST')
      send(
        await app.market.command(actor, id, action, await input.readBody(req)),
      );
    else if (resource === 'favorites' && method === 'GET' && !id)
      send(await app.market.favorites(actor));
    else if (
      resource === 'favorites' &&
      id &&
      !action &&
      ['PUT', 'DELETE'].includes(method)
    )
      send(await app.market.favorite(actor, id, method === 'PUT'));
    else if (resource === 'notifications' && method === 'GET' && !id)
      send(
        await app.inbox.list(
          actor,
          input.url.searchParams.has('before')
            ? Number(input.url.searchParams.get('before'))
            : undefined,
          input.url.searchParams.get('cursor') ?? undefined,
        ),
      );
    else if (resource === 'notifications' && id === 'read' && method === 'POST')
      send(await app.inbox.markRead(actor, (await input.readBody(req)).ids));
    else if (resource === 'roles' && id && !action && method === 'PUT')
      send(await app.roles.assign(actor, id, await input.readBody(req)));
    else if (resource === 'records' && !id && method === 'GET')
      send(await app.governance.ownRecords(actor));
    else if (resource === 'admin' && id && !action && method === 'GET')
      send(await app.governance.records(actor, id));
    else if (
      resource === 'reports' &&
      id &&
      method === 'POST' &&
      action === 'decide'
    ) {
      await app.moderation.decide(actor, id, await input.readBody(req));
      send({ success: true });
    } else if (
      resource === 'appeals' &&
      id &&
      method === 'POST' &&
      action === 'resolve'
    )
      send(
        await app.governance.resolveAppeal(
          actor,
          id,
          await input.readBody(req),
        ),
      );
    else if (resource === 'restore' && id && method === 'POST' && !action)
      send(await app.governance.restore(actor, id, await input.readBody(req)));
    else if (
      resource === 'restrictions' &&
      id &&
      method === 'POST' &&
      action === 'revoke'
    )
      send(
        await app.governance.revokeRestriction(
          actor,
          id,
          await input.readBody(req),
        ),
      );
    else if (
      resource === 'restrictions' &&
      id &&
      method === 'POST' &&
      !action
    ) {
      const body = await input.readBody(req);
      send(
        await app.governance.restrict(
          actor,
          id,
          String(body.accountId ?? ''),
          body,
        ),
      );
    } else if (resource === 'images' && method === 'POST' && !id)
      send(
        await app.attachments.upload(
          actor,
          input.url.searchParams.get('draftId') ?? '',
          await imageBody(req),
        ),
      );
    else if (resource === 'images' && method === 'GET' && id && !action) {
      const image = await app.attachments.read(
        actor,
        id,
        input.url.searchParams.get('thumbnail') === 'true',
      );
      if (input.url.searchParams.get('format') === 'data') {
        send({
          data: image.content.toString('base64'),
          contentType: image.contentType,
        });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': image.contentType,
        'Cache-Control': image.cacheControl,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(image.content);
    } else if (resource === 'drafts' && method === 'PUT' && id && !action) {
      const body = await input.readBody(req);
      if (
        !Array.isArray(body.imageIds) ||
        body.imageIds.some((id) => typeof id !== 'string')
      )
        throw new MarketError('INVALID_INPUT', 'imageIds');
      await app.attachments.lease(actor, id, body.imageIds);
      send({ success: true });
    } else throw new MarketError('NOT_FOUND');
  } catch (error) {
    if (error instanceof MarketError)
      input.sendJSON(
        res,
        {
          INVALID_INPUT: 400,
          UNAUTHENTICATED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          LIMIT_REACHED: 429,
          DEPENDENCY_UNAVAILABLE: 503,
        }[error.code],
        { error: error.code, field: error.field, retryAt: error.retryAt },
      );
    else input.sendJSON(res, 500, { error: 'INTERNAL_ERROR' });
  }
  return true;
}
