/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { MarketError } from './fleaMarketTypes.js';
const require = createRequire(import.meta.url);
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const sharp = require(workerData.sharpPath);
  const buffer = Buffer.from(workerData.content);
  let pipeline;
  const heif = buffer.length >= 12 && buffer.toString('ascii',4,8)==='ftyp' && ['heic','heix','hevc','hevx','mif1','msf1'].includes(buffer.toString('ascii',8,12));
  if (heif) {
    const decode = require(workerData.heicPath);
    const images = await decode.all({buffer});
    try {
      if (images.length < 1 || images.length > 20) throw new Error('INVALID_IMAGE');
      const image = images[0];
      if(image.width < 1 || image.height < 1 || image.width*image.height > 40000000) throw new Error('PIXEL_LIMIT');
      const result = await image.decode();
      pipeline = sharp(Buffer.from(result.data),{raw:{width:result.width,height:result.height,channels:4}});
    } finally { images.dispose(); }
  } else {
    pipeline = sharp(buffer,{limitInputPixels:40000000,failOn:'warning'});
    const metadata = await pipeline.metadata();
    if (!['jpeg','png','webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('INVALID_FORMAT');
    pipeline = pipeline.autoOrient();
  }
  const detail = await pipeline.resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
  const thumbnail = await sharp(detail).resize({width:640,height:640,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
  const metadata = await sharp(detail).metadata();
  parentPort.postMessage({detail,thumbnail,width:metadata.width,height:metadata.height});
})().catch(() => parentPort.postMessage({error:true}));
`;
export async function processMarketImage(content: Buffer): Promise<{
  detail: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
}> {
  if (
    !Buffer.isBuffer(content) ||
    !content.length ||
    content.length > 20 * 1024 * 1024
  )
    throw new MarketError('INVALID_INPUT', 'image');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        content,
        sharpPath: require.resolve('sharp'),
        heicPath: require.resolve('heic-decode'),
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (
      error: boolean,
      result?: {
        detail: Uint8Array;
        thumbnail: Uint8Array;
        width: number;
        height: number;
      },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error || !result) reject(new MarketError('INVALID_INPUT', 'image'));
      else
        resolve({
          ...result,
          detail: Buffer.from(result.detail),
          thumbnail: Buffer.from(result.thumbnail),
        });
    };
    const timer = setTimeout(() => finish(true), 15000);
    worker.once('message', (result) => finish(!!result.error, result));
    worker.once('error', () => finish(true));
    worker.once('exit', () => {
      if (!settled) finish(true);
    });
  });
}
