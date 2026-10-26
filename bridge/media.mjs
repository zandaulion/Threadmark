import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

const run = promisify(execFile);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export async function processMessageMedia(message, socket, logger, options = {}) {
  const descriptor = describeMedia(message?.message);
  if (!descriptor) return null;
  if (Number(descriptor.fileLength || 0) > MAX_MEDIA_BYTES) return { ...descriptor.public, processed: false, error: 'attachment_too_large' };
  const directory = await fs.mkdtemp(path.join(options.tempDir || os.tmpdir(), 'threadmark-media-'));
  try {
    const download = options.download || downloadMediaMessage;
    let stream;
    let rejectDownload;
    let abandoned = false;
    // This Baileys version does not forward AbortSignal to its fetch call.
    // Bound the caller's wait and close a stream that arrives after cancellation.
    const cancelled = new Promise((_, reject) => { rejectDownload = reject; });
    const abort = () => { abandoned = true; stream?.destroy(new Error('download_aborted')); rejectDownload(new Error('download_aborted')); };
    const timer = setTimeout(abort, 60_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    const chunks = [];
    let size = 0;
    try {
      if (options.signal?.aborted) throw new Error('aborted');
      const pending = download(message, 'stream', {}, { logger, reuploadRequest: socket?.updateMediaMessage })
        .then((value) => { if (abandoned) value.destroy(); return value; });
      stream = await Promise.race([pending, cancelled]);
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_MEDIA_BYTES) { stream.destroy(); return { ...descriptor.public, processed: false, error: 'attachment_too_large' }; }
        chunks.push(chunk);
      }
    } finally { abandoned = true; stream?.destroy(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    const buffer = Buffer.concat(chunks);
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
      const execute = options.run || run;
      const execution = { signal: options.signal, killSignal: 'SIGKILL', maxBuffer: 2_000_000 };
      const wav = path.join(directory, 'audio.wav');
      const output = path.join(directory, crypto.randomUUID());
      const probe = await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], { ...execution, timeout: 15_000 });
      const duration = Number(String(probe.stdout).trim());
      if (!Number.isFinite(duration) || duration <= 0) return { ...descriptor.public, processed: false, error: 'local_processing_failed' };
      if (duration > 600) return { ...descriptor.public, processed: false, error: 'audio_too_long' };
      await execute('ffmpeg', ['-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-t', '600', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { ...execution, timeout: 60_000 });
      const threads = String(Math.min(Math.max(Number(process.env.WHISPER_THREADS) || 2, 1), 4));
      await execute('/opt/whisper/bin/whisper-cli', ['-m', process.env.WHISPER_MODEL || '/opt/whisper/models/ggml-small.bin', '-f', wav, '-l', 'auto', '-t', threads, '-nt', '-otxt', '-of', output],
        { ...execution, timeout: Math.min(1_800_000, Math.max(180_000, Math.ceil(duration * 5000))) });
      return result(descriptor, await fs.readFile(`${output}.txt`, 'utf8'), 'whisper');
    }
    return { ...descriptor.public, processed: false, error: 'unsupported_attachment' };
  } catch (error) {
    console.warn(`Local media processing failed (${descriptor.kind}): ${error?.code || 'processing_failed'}`);
    return { ...descriptor.public, processed: false, error: 'local_processing_failed' };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cleanupMediaTemp(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && /^threadmark-media-[a-z0-9]{6}$/iu.test(entry.name)) {
      await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

export function serializeVoiceMessage(message) {
  let content = message?.message || {};
  for (let index = 0; index < 4; index += 1) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) return null;
    if (!content.ephemeralMessage?.message) break;
    content = content.ephemeralMessage.message;
  }
  const audio = content.audioMessage;
  if (!audio || audio.viewOnce) return null;
  const { contextInfo, ...reference } = audio; // Never retain quoted messages for a retry.
  return Buffer.from(proto.WebMessageInfo.encode({ key: message.key, messageTimestamp: message.messageTimestamp,
    message: { audioMessage: reference } }).finish()).toString('base64');
}

export function deserializeVoiceMessage(encoded) {
  return proto.WebMessageInfo.decode(Buffer.from(encoded, 'base64'));
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
  const cleaned = String(text || '').replace(/\s+/gu, ' ').trim();
  if (processor === 'whisper' && cleaned.length > 64_000) return { ...descriptor.public, processed: false, processor, error: 'transcript_too_long' };
  const extractedText = processor === 'whisper' ? cleaned : cleaned.slice(0, 12_000);
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
