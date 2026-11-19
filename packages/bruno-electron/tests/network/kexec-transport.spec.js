const {
  assertShouldUseKexec,
  isKexecEnabled,
  getKexecConfig,
  buildCurlArgv,
  parseCurlMinusIOutput,
  serializeBody,
  DEFAULT_NS,
  DEFAULT_POD_GREP
} = require('../../src/ipc/network/kexec-transport');

describe('kexec-transport', () => {
  describe('isKexecEnabled / getKexecConfig', () => {
    it('treats common truthy strings as enabled', () => {
      expect(isKexecEnabled({ KUBE_EXEC: '1' })).toBe(true);
      expect(isKexecEnabled({ KUBE_EXEC: 'true' })).toBe(true);
      expect(isKexecEnabled({ KUBE_EXEC: '0' })).toBe(false);
      expect(isKexecEnabled({})).toBe(false);
    });

    it('applies defaults for ns and pod grep', () => {
      expect(getKexecConfig({})).toEqual({
        suffix: undefined,
        ns: DEFAULT_NS,
        podGrep: DEFAULT_POD_GREP,
        context: undefined,
        container: undefined
      });
    });
  });

  describe('assertShouldUseKexec', () => {
    const clusterUrl = 'http://server-gofood-merchant-bff-cgk.service.p.gojek.com/ui/v1/app/G355673405/homepage';

    it('returns false when disabled', () => {
      expect(assertShouldUseKexec({ url: clusterUrl }, {})).toBe(false);
    });

    it('throws when enabled without host suffix', () => {
      expect(() => assertShouldUseKexec({ url: clusterUrl }, { KUBE_EXEC: '1' })).toThrow(
        /KUBE_EXEC_HOST_SUFFIX/
      );
    });

    it('throws when host does not match suffix', () => {
      expect(() =>
        assertShouldUseKexec(
          { url: 'https://example.com/' },
          { KUBE_EXEC: '1', KUBE_EXEC_HOST_SUFFIX: 'service.p.gojek.com' }
        )
      ).toThrow(/does not end with required suffix/);
    });

    it('returns true for matching cluster host', () => {
      expect(
        assertShouldUseKexec(
          { url: clusterUrl },
          { KUBE_EXEC: '1', KUBE_EXEC_HOST_SUFFIX: 'service.p.gojek.com' }
        )
      ).toBe(true);
    });
  });

  describe('buildCurlArgv', () => {
    it('builds GET without body', () => {
      const { argv, body } = buildCurlArgv({
        method: 'GET',
        url: 'http://svc.service.p.gojek.com/path',
        headers: { Accept: 'application/json', Authorization: 'Bearer t' },
        settings: { followRedirects: false }
      });

      expect(body).toBeUndefined();
      expect(argv).toEqual([
        'curl',
        '-sS',
        '-i',
        '--http1.1',
        '-X',
        'GET',
        '-H',
        'Accept: application/json',
        '-H',
        'Authorization: Bearer t',
        'http://svc.service.p.gojek.com/path'
      ]);
    });

    it('uses stdin body for POST', () => {
      const { argv, body } = buildCurlArgv({
        method: 'POST',
        url: 'http://svc.service.p.gojek.com/path',
        headers: { 'Content-Type': 'application/json' },
        data: '{"a":1}',
        settings: { followRedirects: true, maxRedirects: 3 }
      });

      expect(body.toString('utf8')).toBe('{"a":1}');
      expect(argv).toContain('-L');
      expect(argv).toContain('--max-redirs');
      expect(argv).toContain('--data-binary');
      expect(argv).toContain('@-');
    });

    it('skips false content-type header values', () => {
      const { argv } = buildCurlArgv({
        method: 'GET',
        url: 'http://svc.service.p.gojek.com/',
        headers: { 'Content-Type': false, 'Accept': '*/*' },
        settings: { followRedirects: false }
      });

      expect(argv.join('\n')).not.toMatch(/Content-Type/);
      expect(argv).toContain('Accept: */*');
    });
  });

  describe('serializeBody', () => {
    it('returns undefined for empty bodies', () => {
      expect(serializeBody(undefined)).toBeUndefined();
      expect(serializeBody(null)).toBeUndefined();
      expect(serializeBody('')).toBeUndefined();
    });

    it('json-stringifies objects', () => {
      expect(serializeBody({ a: 1 }).toString('utf8')).toBe('{"a":1}');
    });
  });

  describe('parseCurlMinusIOutput', () => {
    it('parses a single HTTP/1.1 response', () => {
      const raw = [
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        'X-Request-Id: abc',
        '',
        '{"ok":true}'
      ].join('\r\n');

      const parsed = parseCurlMinusIOutput(raw);
      expect(parsed.status).toBe(200);
      expect(parsed.statusText).toBe('OK');
      expect(parsed.headers['content-type']).toBe('application/json');
      expect(parsed.headers.get('Content-Type')).toBe('application/json');
      expect(parsed.body.toString('utf8')).toBe('{"ok":true}');
    });

    it('uses the last block after redirects', () => {
      const raw = [
        'HTTP/1.1 301 Moved Permanently',
        'Location: http://svc/final',
        '',
        'HTTP/1.1 200 OK',
        'Content-Type: text/plain',
        '',
        'done'
      ].join('\n');

      const parsed = parseCurlMinusIOutput(raw);
      expect(parsed.status).toBe(200);
      expect(parsed.body.toString('utf8')).toBe('done');
      expect(parsed.headers['content-type']).toBe('text/plain');
    });
  });
});
