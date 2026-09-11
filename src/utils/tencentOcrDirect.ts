import CryptoJS from 'crypto-js';

export type OcrCredential = { secretId: string; secretKey: string; region?: string };

export type DirectOcrResult = { text: string; lines: { text: string; confidence?: number }[] };

const OCR_HOST = 'ocr.tencentcloudapi.com';
const OCR_ENDPOINT = 'https://ocr.tencentcloudapi.com';
const OCR_ACTION = 'GeneralAccurateOCR';
const OCR_VERSION = '2018-11-19';

function sha256Hex(message: string): string {
  return CryptoJS.SHA256(message).toString(CryptoJS.enc.Hex);
}

// key 可为字符串（UTF-8 字节）或上一轮 HMAC 产出的 WordArray（原始字节），与 Node crypto 行为一致
function hmac(message: string, key: string | CryptoJS.lib.WordArray): CryptoJS.lib.WordArray {
  return CryptoJS.HmacSHA256(message, key);
}

/**
 * 构造 TC3-HMAC-SHA256 的 Authorization 头值。
 * 严格按腾讯云文档：canonicalRequest / stringToSign 的换行、SignedHeaders、credentialScope 顺序固定。
 */
function buildAuthorization(
  secretId: string,
  secretKey: string,
  timestamp: number,
  hashedPayload: string
): string {
  // 日期必须是 UTC
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const credentialScope = `${date}/ocr/tc3_request`;

  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' + `host:${OCR_HOST}\n`;
  const signedHeaders = 'content-type;host';

  const canonicalRequest = [
    'POST',
    '/',
    '', // CanonicalQueryString（无查询参数）
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(date, 'TC3' + secretKey);
  const kService = hmac('ocr', kDate);
  const kSigning = hmac('tc3_request', kService);
  const signature = hmac(stringToSign, kSigning).toString(CryptoJS.enc.Hex);

  return (
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/**
 * 手机直连腾讯云 OCR（GeneralAccurateOCR）。
 * @param base64 纯 base64（不含 data: 前缀）
 * @param cred 腾讯云密钥
 */
export async function recognizeWithTencentDirect(
  base64: string,
  cred: OcrCredential
): Promise<DirectOcrResult> {
  if (!cred.secretId || !cred.secretKey) {
    throw new Error('腾讯云密钥不完整（缺少 secretId / secretKey）');
  }
  const body = JSON.stringify({ ImageBase64: base64 });
  const hashedPayload = sha256Hex(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildAuthorization(
    cred.secretId,
    cred.secretKey,
    timestamp,
    hashedPayload
  );
  const region = cred.region || 'ap-guangzhou';

  let res: Response;
  try {
    res = await fetch(OCR_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': OCR_ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': OCR_VERSION,
        'X-TC-Region': region,
      },
      body,
    });
  } catch (e: any) {
    throw new Error(`腾讯云直连请求失败：${e?.message || e}`);
  }

  let json: any = {};
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch (e: any) {
    throw new Error(`腾讯云响应解析失败（HTTP ${res.status}）`);
  }

  const resp = json?.Response;
  if (!resp) {
    throw new Error(`腾讯云返回异常（HTTP ${res.status}）：缺少 Response 字段`);
  }
  if (resp.Error) {
    throw new Error(
      `腾讯云识别失败：${resp.Error.Message || resp.Error.Code || '未知错误'}`
    );
  }

  const detections: any[] = Array.isArray(resp.TextDetections) ? resp.TextDetections : [];
  const lines = detections
    .map((d) => {
      const t = typeof d?.DetectedText === 'string' ? d.DetectedText : '';
      const conf = typeof d?.Confidence === 'number' ? d.Confidence : undefined;
      return {
        text: t,
        // 置信度归一 0~1（腾讯云给 0~100），保留 4 位小数，与后端一致
        confidence: conf != null ? Number((conf / 100).toFixed(4)) : undefined,
      };
    })
    .filter((l) => l.text.trim().length > 0);

  const text = lines.map((l) => l.text).join('\n');
  return { text, lines };
}
