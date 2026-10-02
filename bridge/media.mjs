import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const run = promisify(execFile);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export async function processMessageMedia(message, socket, logger, options = {}) {
  const descriptor = describeMedia(message?.message);
  if (!descriptor) return null;
  if (Number(descriptor.fileLength || 0) > MAX_MEDIA_BYTES) return { ...descriptor.public, processed: false, error: 'attachment_too_large' };
  const directory = await fs.mkdtemp(path.join(options.tempDir || os.tmpdir(), 'threadmark-media-'));
  try {
    const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: socket?.updateMediaMessage });
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_MEDIA_BYTES) return { ...descriptor.public, processed: false, error: 'attachment_too_large' };
    const input = path.join(directory, `input${descriptor.extension}`);
    await fs.writeFile(input, buffer, { mode: 0o600 });
    if (descriptor.kind === 'image') {
      const { stdout } = await run('tesseract', [input, 'stdout', '-l', 'ron+eng'], { timeout: 90_000, maxBuffer: 2_000_000 });
      return result(descriptor, stdout, 'ocr');
    }
    if (descriptor.kind === 'document' && descriptor.mimeType === 'application/pdf') {
      const { stdout } = await run('pdftotext', ['-layout', input, '-'], { timeout: 60_000, maxBuffer: 2_000_000 });
      if (String(stdout || '').trim()) return result(descriptor, stdout, 'pdf_text');
      const page = path.join(directory, 'page');
      await run('pdftoppm', ['-f', '1', '-singlefile', '-png', '-r', '180', input, page], { timeout: 90_000, maxBuffer: 200_000 });
      const ocr = await run('tesseract', [`${page}.png`, 'stdout', '-l', 'ron+eng'], { timeout: 90_000, maxBuffer: 2_000_000 });
      return result(descriptor, ocr.stdout, 'ocr');
    }
    if (descriptor.kind === 'document' && descriptor.mimeType.startsWith('image/')) {
      const { stdout } = await run('tesseract', [input, 'stdout', '-l', 'ron+eng'], { timeout: 90_000, maxBuffer: 2_000_000 });
      return result(descriptor, stdout, 'ocr');
    }
    if (descriptor.kind === 'audio') {
      const wav = path.join(directory, 'audio.wav');
      const output = path.join(directory, crypto.randomUUID());
      await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 60_000, maxBuffer: 200_000 });
      await run('/opt/whisper/bin/whisper-cli', ['-m', '/opt/whisper/models/ggml-tiny.bin', '-f', wav, '-l', 'auto', '-nt', '-otxt', '-of', output], { timeout: 180_000, maxBuffer: 2_000_000 });
      return result(descriptor, await fs.readFile(`${output}.txt`, 'utf8'), 'whisper');
    }
    return { ...descriptor.public, processed: false, error: 'unsupported_attachment' };
  } catch (error) {
    console.warn(`Local media processing failed (${descriptor.kind}): ${error?.code || error?.message || 'unknown error'}`);
    return { ...descriptor.public, processed: false, error: 'local_processing_failed' };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export function describeMedia(content) {
  const unwrapped = unwrap(content);
  const entry = unwrapped.imageMessage ? ['image', unwrapped.imageMessage]
    : unwrapped.audioMessage ? ['audio', unwrapped.audioMessage]
      : unwrapped.documentMessage ? ['document', unwrapped.documentMessage]
        : unwrapped.videoMessage ? ['video', unwrapped.videoMessage] : null;
  if (!entry) return null;
  const [kind, media] = entry;
  const mimeType = String(media.mimetype || defaultMime(kind));
  return {
    kind,
    mimeType,
    fileLength: numeric(media.fileLength),
    extension: extensionFor(mimeType, kind),
    public: { kind, mimeType, fileName: String(media.fileName || `${kind}${extensionFor(mimeType, kind)}`).slice(0, 240) },
  };
}

function result(descriptor, text, processor) {
  const extractedText = String(text || '').replace(/\s+/gu, ' ').trim().slice(0, 12_000);
  return { ...descriptor.public, processed: Boolean(extractedText), processor, extractedText, error: extractedText ? null : 'no_text_found' };
}

function unwrap(content) {
  let current = content || {};
  for (let index = 0; index < 4; index += 1) {
    const next = current.ephemeralMessage?.message || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message || current.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current;
}

function extensionFor(mime, kind) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('ogg') || mime.includes('opus')) return '.ogg';
  if (mime.includes('mp4')) return '.mp4';
  return kind === 'audio' ? '.bin' : '.dat';
}

function defaultMime(kind) {
  return kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/ogg' : kind === 'video' ? 'video/mp4' : 'application/octet-stream';
}

function numeric(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value?.toNumber) return value.toNumber();
  return Number(value || 0);
}
