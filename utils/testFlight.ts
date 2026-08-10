import {Platform} from 'react-native';

export const TEST_FLIGHT_ORIGIN = 'https://alistserver.99999987.xyz';
export const TEST_FLIGHT_APPLICATION_PATH = '/tf';

export type TestFlightCredentialDisplayInfo = {
  credentialId: string;
};

export function isTestFlightAutomaticApplicationSupported(): boolean {
  if (Platform.OS !== 'ios') {
    return false;
  }

  const majorVersion = Number.parseInt(String(Platform.Version).split('.')[0], 10);
  return Number.isFinite(majorVersion) && majorVersion >= 16;
}

/** 只把经过收窄的凭证放进固定站点 fragment，避免进入服务端访问日志。 */
export function buildTestFlightApplicationURL(credentialId: unknown): string | null {
  if (
    typeof credentialId !== 'string' ||
    !/^[A-Za-z0-9._-]{6,128}$/.test(credentialId)
  ) {
    return null;
  }

  return `${TEST_FLIGHT_ORIGIN}${TEST_FLIGHT_APPLICATION_PATH}#tid=${encodeURIComponent(credentialId)}`;
}

export function isAllowedTestFlightTopLevelURL(value: string): boolean {
  if (value === 'about:blank') {
    return true;
  }

  try {
    const url = new URL(value);
    return (
      url.origin === TEST_FLIGHT_ORIGIN &&
      url.pathname === TEST_FLIGHT_APPLICATION_PATH &&
      url.username === '' &&
      url.password === '' &&
      url.port === ''
    );
  } catch {
    return false;
  }
}

export function isAllowedTestFlightEmbeddedURL(value: string): boolean {
  if (value === 'about:blank' || value === 'about:srcdoc') {
    return true;
  }

  try {
    const url = new URL(value);
    return (
      (url.origin === TEST_FLIGHT_ORIGIN ||
        url.origin === 'https://challenges.cloudflare.com') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}
