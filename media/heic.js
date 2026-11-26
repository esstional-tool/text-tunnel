// HEIC/HEIF 사진을 JPG 로 바꾼다 (이슈 #59). 안드로이드 크롬은 HEIC 를 읽지 못해서 서버가 대신 바꾼다.
// 외부 라이브러리는 heic-convert 하나만 쓴다 (순수 JS/WebAssembly, 서버 밖으로 나가는 호출 없음).
const convert = require('heic-convert');

const BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'];

// 파일 앞부분의 ftyp 상자를 보고 HEIC 인지 판단한다 (확장자·MIME 은 믿지 않는다)
function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  const head = buf.subarray(0, Math.min(buf.length, 64)).toString('latin1');
  return head.includes('ftyp') && BRANDS.some((b) => head.includes(b));
}

// 대표 사진 한 장을 JPG 로 바꾼다. 바꿀 수 없으면 예외
async function heicToJpeg(buf) {
  const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.9 });
  return Buffer.from(out);
}

module.exports = { isHeic, heicToJpeg };
