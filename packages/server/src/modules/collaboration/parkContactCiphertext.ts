/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createPublicKey, verify } from 'node:crypto';
import {
  e2eeMessageSignaturePayload,
  type SendE2eeDirectMessageInput,
} from './e2eeRepository.js';
/** A separate, explicit scope; this never loosens enterprise private-message membership. */
export type ParkCiphertextInput = Omit<
  SendE2eeDirectMessageInput,
  'organizationId' | 'senderAccountId' | 'recipientAccountId'
>;
export interface ParkApprovedDevice {
  accountId: string;
  deviceId: string;
  identitySigningPublicKey: string;
}
export function verifyParkCiphertext(input: {
  parkId: string;
  senderId: string;
  recipientId: string;
  message: ParkCiphertextInput;
  approvedDevices: ParkApprovedDevice[];
}): ParkCiphertextInput {
  const message = input.message;
  if (
    !message ||
    message.protocolVersion !== 1 ||
    message.contentType !== 'message' ||
    message.inReplyToMessageId ||
    message.attachments?.length ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(message.messageId)
  )
    throw new Error('invalid park message');
  const base64 = (value: unknown, max: number, exact?: number) => {
    if (typeof value !== 'string' || value.length > max * 2)
      throw new Error('invalid ciphertext');
    const bytes = Buffer.from(value, 'base64');
    if (
      bytes.toString('base64') !== value ||
      !bytes.length ||
      bytes.length > max ||
      (exact !== undefined && bytes.length !== exact)
    )
      throw new Error('invalid ciphertext');
    return bytes;
  };
  if (base64(message.ciphertext, 32768).length <= 16)
    throw new Error('invalid ciphertext');
  base64(message.nonce, 12, 12);
  const signature = base64(message.signature, 64, 64);
  if (!Array.isArray(message.envelopes) || message.envelopes.length > 100)
    throw new Error('invalid device envelopes');
  const sender = input.approvedDevices.find(
    (d) =>
      d.accountId === input.senderId && d.deviceId === message.senderDeviceId,
  );
  if (
    !sender ||
    !input.approvedDevices.some((d) => d.accountId === input.recipientId)
  )
    throw new Error('approved recipient device unavailable');
  const envelopeKeys = new Set<string>();
  for (const envelope of message.envelopes) {
    const key = `${envelope.accountId}\0${envelope.deviceId}`;
    if (
      envelopeKeys.has(key) ||
      !input.approvedDevices.some(
        (d) =>
          d.accountId === envelope.accountId &&
          d.deviceId === envelope.deviceId,
      ) ||
      ![input.senderId, input.recipientId].includes(envelope.accountId)
    )
      throw new Error('device authority changed');
    envelopeKeys.add(key);
    base64(envelope.nonce, 12, 12);
    base64(envelope.wrappedKey, 128);
    if (
      typeof envelope.ephemeralPublicKey !== 'string' ||
      envelope.ephemeralPublicKey.length > 1000 ||
      createPublicKey(envelope.ephemeralPublicKey).asymmetricKeyType !==
        'x25519'
    )
      throw new Error('invalid envelope key');
  }
  if (
    input.approvedDevices.some(
      (d) => !envelopeKeys.has(`${d.accountId}\0${d.deviceId}`),
    )
  )
    throw new Error('device authority changed');
  if (
    !verify(
      null,
      e2eeMessageSignaturePayload({
        ...message,
        organizationId: `park-market:${input.parkId}`,
        senderAccountId: input.senderId,
        recipientAccountId: input.recipientId,
      }),
      sender.identitySigningPublicKey,
      signature,
    )
  )
    throw new Error('invalid park message signature');
  return {
    protocolVersion: 1,
    messageId: message.messageId,
    senderDeviceId: message.senderDeviceId,
    contentType: 'message',
    inReplyToMessageId: null,
    ciphertext: message.ciphertext,
    nonce: message.nonce,
    signature: message.signature,
    envelopes: message.envelopes.map((e) => ({
      accountId: e.accountId,
      deviceId: e.deviceId,
      ephemeralPublicKey: e.ephemeralPublicKey,
      wrappedKey: e.wrappedKey,
      nonce: e.nonce,
    })),
    attachments: [],
  };
}
export const PARK_CONTACT_MESSAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_contact_messages (
 id TEXT PRIMARY KEY,park_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
 created_at BIGINT NOT NULL,payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS park_contact_message_order ON park_contact_messages(conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS park_contact_read_receipts (
 account_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES park_contact_messages(id),read_at BIGINT NOT NULL,
 PRIMARY KEY(account_id,message_id)
);`;
export const PARK_CONTACT_ORDER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_contact_sequences (
 message_id TEXT PRIMARY KEY REFERENCES park_contact_messages(id),conversation_id TEXT NOT NULL,sequence BIGINT NOT NULL,
 UNIQUE(conversation_id,sequence)
);
INSERT INTO park_contact_sequences(message_id,conversation_id,sequence)
 SELECT id,conversation_id,ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at,id)
 FROM park_contact_messages WHERE TRUE ON CONFLICT DO NOTHING;
`;
