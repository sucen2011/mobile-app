import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { apiFetch } from './client';

// iOS 真机上 expo-file-system.readAsStringAsync 读 Camera 目录大照片会卡住 JS 线程，
// 导致 Promise.race 都救不了。改用 expo-image-manipulator 读取 base64（异步 native，不阻塞）。

async function readBase64Robust(localUri: string): Promise<{ b64: string; mime: string }> {
  const lower = localUri.toLowerCase();

  // 关键修复：直接读取原始文件字节，保留相机原始分辨率（3000px+），杜绝降采样模糊。
  // 不再经过 ImageManipulator，避免它在 iOS 上把原图重编码并降采样到 ≤1920 长边。
  try {
    const b64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: (FileSystem as any).EncodingType.Base64,
    });
    const mime = lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.webp')
      ? 'image/webp'
      : lower.endsWith('.heic') || lower.endsWith('.heif')
      ? 'image/heic'
      : 'image/jpeg';
    return { b64, mime };
  } catch (e: any) {
    console.log('[upload] read original bytes failed, fallback to manipulator', e?.message || e);
  }

  // 兜底：ImageManipulator 转 JPEG（会重编码，分辨率可能下调）
  const manipulated = await ImageManipulator.manipulateAsync(
    localUri,
    [], // 不做变换
    { base64: true, format: ImageManipulator.SaveFormat.JPEG, compress: 1 }
  );
  if (!manipulated.base64) throw new Error('manipulator 未返回 base64');
  return { b64: manipulated.base64, mime: 'image/jpeg' };
}

export async function uploadImage(
  baseUrl: string,
  localUri: string,
  name: string,
  date: string,
  seq?: number,
  orderNo?: string
): Promise<string | null> {
  console.log('[upload] start', localUri);
  let b64: string;
  let mime = 'image/jpeg';
  try {
    const r = await readBase64Robust(localUri);
    b64 = r.b64;
    mime = r.mime;
    console.log('[upload] read b64 length', b64.length, 'mime', mime);
  } catch (e: any) {
    console.log('[upload] read file failed, skip this image', e?.message || e);
    return null; // 单张照片失败不卡整张单据
  }

  const dataUri = `data:${mime};base64,${b64}`;
  console.log('[upload] post', `${baseUrl}/api/upload`);
  const res = await apiFetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: JSON.stringify({ data: dataUri, name, date, seq, orderNo, terminal: 'mobile' }),
  });
  console.log('[upload] response', res.status, res.json);
  if (!res.ok || res.json?.code !== 0) {
    throw new Error(res.json?.msg || `上传失败 HTTP ${res.status}`);
  }
  return res.json.data.url as string;
}
