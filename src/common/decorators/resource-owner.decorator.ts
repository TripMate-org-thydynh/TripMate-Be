import { SetMetadata } from '@nestjs/common';

export const OWNED_RESOURCE_KEY = 'ownedResource';

export interface OwnedResourceMeta {
  /** Prisma model name (camelCase, e.g. 'packingItem') */
  model: string;
  /** Route param that carries the resource ID (e.g. 'itemId') */
  paramName: string;
}

/**
 * Marks a controller method as requiring resource-ownership verification.
 * Only the record owner **or** the trip creator may proceed; everyone
 * else receives 403.
 *
 * Usage:
 * ```
 * @OwnedResource('packingItem', 'itemId')
 * @Delete(':itemId')
 * deleteItem(…) { … }
 * ```
 */
export const OwnedResource = (model: string, paramName: string) =>
  SetMetadata(OWNED_RESOURCE_KEY, { model, paramName });
