import {
  TEST_FLIGHT_ORIGIN,
  buildTestFlightApplicationURL,
  isAllowedTestFlightEmbeddedURL,
  isAllowedTestFlightTopLevelURL,
} from '../testFlight';

describe('TestFlight 申请 URL', () => {
  it('只把合法凭证放进固定域名的 fragment', () => {
    expect(buildTestFlightApplicationURL('credential_123-ABC')).toBe(
      `${TEST_FLIGHT_ORIGIN}/tf#tid=credential_123-ABC`,
    );
    expect(buildTestFlightApplicationURL('bad/value')).toBeNull();
    expect(buildTestFlightApplicationURL('short')).toBeNull();
    expect(buildTestFlightApplicationURL(undefined)).toBeNull();
  });

  it('顶层页面只允许固定同源申请路径', () => {
    expect(isAllowedTestFlightTopLevelURL(`${TEST_FLIGHT_ORIGIN}/tf#tid=abc123`)).toBe(true);
    expect(isAllowedTestFlightTopLevelURL(`${TEST_FLIGHT_ORIGIN}/other`)).toBe(false);
    expect(isAllowedTestFlightTopLevelURL('https://example.com/tf')).toBe(false);
    expect(isAllowedTestFlightTopLevelURL('https://user@example.com/tf')).toBe(false);
  });

  it('子 frame 仅允许本站和 Cloudflare Turnstile', () => {
    expect(isAllowedTestFlightEmbeddedURL(`${TEST_FLIGHT_ORIGIN}/tf`)).toBe(true);
    expect(isAllowedTestFlightEmbeddedURL('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/')).toBe(true);
    expect(isAllowedTestFlightEmbeddedURL('https://example.com/frame')).toBe(false);
  });
});
