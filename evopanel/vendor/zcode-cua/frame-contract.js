export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

export function isOfficialCuaImageRefText(_text) {
  return false;
}

export function containsOfficialCuaImageRefCredentialText(_text) {
  return false;
}

export function containsImageRefAuthority(_text) {
  return false;
}

export function parseOfficialCuaImageRef(_text) {
  return undefined;
}

export function readRasterEnvelopeIdentity(_input) {
  return undefined;
}

export async function preserveOfficialCuaFrameResult(result) {
  return result;
}

export function attestOfficialCuaFrameContent(_content, _expectedKind) {
  return undefined;
}

export function findOfficialCuaFrameContentPair(_content) {
  return undefined;
}
