/**
 * Personal kubectl-exec transport (not an upstream feature).
 *
 * When enabled, Bruno Send runs the prepared HTTP request via:
 *   kubectl exec … -- curl …
 * inside a Running pod, then maps the response back into the normal
 * post-response / tests path.
 *
 * Collection / process env knobs:
 *   KUBE_EXEC=1                         opt-in
 *   KUBE_EXEC_HOST_SUFFIX               required host suffix (e.g. service.p.gojek.com)
 *   KUBE_NS                             default a000048
 *   KUBE_POD_GREP                       default gofood-moderator-http-server
 *   KUBE_CONTEXT                        optional kube context
 *   KUBE_CONTAINER                      optional container name
 */

const { spawn } = require('node:child_process');
const { STATUS_CODES } = require('node:http');
const { URL } = require('node:url');
const { readCurrentTime, startHop, completeHop } = require('@usebruno/requests');
const { isFormData } = require('@usebruno/common').utils;

const DEFAULT_NS = 'a000048';
const DEFAULT_POD_GREP = 'gofood-moderator-http-server';

const truthy = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const envValue = (processEnvVars, key) => {
  const raw = processEnvVars?.[key];
  if (raw === undefined || raw === null) return undefined;
  return String(raw).trim();
};

const isKexecEnabled = (processEnvVars) => truthy(envValue(processEnvVars, 'KUBE_EXEC'));

const getKexecConfig = (processEnvVars) => {
  const suffix = envValue(processEnvVars, 'KUBE_EXEC_HOST_SUFFIX');
  return {
    suffix,
    ns: envValue(processEnvVars, 'KUBE_NS') || DEFAULT_NS,
    podGrep: envValue(processEnvVars, 'KUBE_POD_GREP') || DEFAULT_POD_GREP,
    context: envValue(processEnvVars, 'KUBE_CONTEXT') || undefined,
    container: envValue(processEnvVars, 'KUBE_CONTAINER') || undefined
  };
};

const getRequestHostname = (requestUrl) => {
  try {
    return new URL(requestUrl).hostname;
  } catch {
    return '';
  }
};

/**
 * Throws when KUBE_EXEC is on but misconfigured / host not allowed.
 * Returns true when this request should use kubectl-exec.
 */
const assertShouldUseKexec = (request, processEnvVars) => {
  if (!isKexecEnabled(processEnvVars)) {
    return false;
  }

  const { suffix } = getKexecConfig(processEnvVars);
  if (!suffix) {
    throw new Error(
      'KUBE_EXEC is enabled but KUBE_EXEC_HOST_SUFFIX is missing. Set it to the allowed host suffix (e.g. service.p.gojek.com).'
    );
  }

  const hostname = getRequestHostname(request.url);
  if (!hostname || !hostname.endsWith(suffix)) {
    throw new Error(
      `KUBE_EXEC is enabled but request host "${hostname || request.url}" does not end with required suffix "${suffix}".`
    );
  }

  return true;
};

const pushTimeline = (timeline, type, message) => {
  timeline.push({
    timestamp: new Date(),
    type,
    message
  });
};

const runCommand = (command, args, { signal, stdinData } = {}) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('REQUEST_CANCELLED');
      err.isCancel = true;
      reject(err);
      return;
    }

    const child = spawn(command, args, {
      stdio: [stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort);

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code, killSignal) => {
      signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (signal?.aborted || killSignal === 'SIGTERM' || killSignal === 'SIGKILL') {
        const err = new Error('REQUEST_CANCELLED');
        err.isCancel = true;
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (code !== 0) {
        const err = new Error(
          stderr.trim() || `${command} exited with code ${code}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
};

const resolvePod = async ({ ns, podGrep, context, signal, timeline }) => {
  const args = ['get', 'pods', '-n', ns, '--field-selector=status.phase=Running', '-o', 'custom-columns=NAME:.metadata.name', '--no-headers'];
  if (context) {
    args.unshift('--context', context);
  }

  pushTimeline(timeline, 'info', `Resolving Running pods in namespace ${ns} matching /${podGrep}/`);
  const { stdout } = await runCommand('kubectl', args, { signal });
  const names = stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => name.includes(podGrep));

  if (!names.length) {
    throw new Error(
      `No Running pods in namespace "${ns}" matched KUBE_POD_GREP "${podGrep}".`
    );
  }

  const pod = names[0];
  pushTimeline(timeline, 'info', `Using pod ${pod}${names.length > 1 ? ` (first of ${names.length} matches)` : ''}`);
  return pod;
};

const serializeBody = (data) => {
  if (data === undefined || data === null || data === '') {
    return undefined;
  }
  if (isFormData(data) || typeof data?.pipe === 'function') {
    throw new Error(
      'kubectl-exec transport does not support multipart or streamed request bodies in v1.'
    );
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return Buffer.from(JSON.stringify(data), 'utf8');
};

const buildCurlArgv = (request) => {
  const method = (request.method || 'GET').toUpperCase();
  const argv = ['curl', '-sS', '-i', '--http1.1', '-X', method];

  const followRedirects = request.settings?.followRedirects ?? true;
  if (followRedirects) {
    const maxRedirects = request.settings?.maxRedirects ?? 5;
    argv.push('-L', '--max-redirs', String(maxRedirects));
  }

  const headers = request.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === false || value === undefined || value === null) {
      continue;
    }
    if (key.toLowerCase() === 'content-type' && value === false) {
      continue;
    }
    argv.push('-H', `${key}: ${String(value)}`);
  }

  const body = serializeBody(request.data);
  if (body !== undefined) {
    argv.push('--data-binary', '@-');
  }

  argv.push(request.url);
  return { argv, body };
};

/**
 * Parse `curl -i` / `--http1.1` output into status, headers, body.
 * When redirects are followed, the last response block wins.
 */
const parseCurlMinusIOutput = (buffer) => {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = [];
  const statusRe = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+(.*))?$/gm;
  let match;
  while ((match = statusRe.exec(normalized)) !== null) {
    blocks.push({
      index: match.index,
      status: Number(match[1]),
      statusText: (match[2] || STATUS_CODES[match[1]] || '').trim(),
      headerStart: match.index + match[0].length + 1
    });
  }

  if (!blocks.length) {
    throw new Error('Failed to parse curl response: no HTTP status line found.');
  }

  const last = blocks[blocks.length - 1];
  const rest = normalized.slice(last.headerStart);
  const separator = rest.indexOf('\n\n');
  const headerSection = separator === -1 ? rest : rest.slice(0, separator);
  const bodyText = separator === -1 ? '' : rest.slice(separator + 2);

  const headers = {};
  for (const line of headerSection.split('\n')) {
    if (!line || line.startsWith('HTTP/')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[name]) {
      if (Array.isArray(headers[name])) {
        headers[name].push(value);
      } else {
        headers[name] = [headers[name], value];
      }
    } else {
      headers[name] = value;
    }
  }

  // Axios-like .get for hasStreamHeaders compatibility if ever used.
  Object.defineProperty(headers, 'get', {
    enumerable: false,
    value: (headerName) => {
      const key = String(headerName).toLowerCase();
      const val = headers[key];
      return Array.isArray(val) ? val.join(', ') : val;
    }
  });

  return {
    status: last.status,
    statusText: last.statusText || STATUS_CODES[last.status] || '',
    headers,
    body: Buffer.from(bodyText, 'utf8')
  };
};

const sendRequestViaKexec = async (request, processEnvVars, { signal } = {}) => {
  const timeline = [];
  const metadata = { timeline };
  startHop(metadata);

  pushTimeline(timeline, 'separator', '');
  pushTimeline(timeline, 'info', 'Using personal kubectl-exec transport');
  pushTimeline(timeline, 'request', `${(request.method || 'GET').toUpperCase()} ${request.url}`);

  try {
    const config = getKexecConfig(processEnvVars);
    const pod = await resolvePod({
      ns: config.ns,
      podGrep: config.podGrep,
      context: config.context,
      signal,
      timeline
    });

    const { argv: curlArgv, body } = buildCurlArgv(request);
    const kubectlArgs = [];
    if (config.context) {
      kubectlArgs.push('--context', config.context);
    }
    kubectlArgs.push('exec');
    if (body !== undefined) {
      kubectlArgs.push('-i');
    }
    kubectlArgs.push('-n', config.ns);
    if (config.container) {
      kubectlArgs.push('-c', config.container);
    }
    kubectlArgs.push(pod, '--', ...curlArgv);

    pushTimeline(
      timeline,
      'info',
      `kubectl exec -n ${config.ns} ${pod} -- curl …`
    );

    const { stdout, stderr } = await runCommand('kubectl', kubectlArgs, {
      signal,
      stdinData: body
    });

    if (stderr?.trim()) {
      pushTimeline(timeline, 'info', stderr.trim());
    }

    const parsed = parseCurlMinusIOutput(stdout);
    completeHop(metadata);

    pushTimeline(
      timeline,
      'response',
      `HTTP ${parsed.status} ${parsed.statusText} (via kubectl-exec / ${pod})`
    );

    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      data: parsed.body,
      config: {
        metadata,
        url: request.url,
        method: request.method
      },
      request
    };
  } catch (error) {
    completeHop(metadata);
    error.timeline = timeline;
    if (error.isCancel) {
      const cancelError = new Error('REQUEST_CANCELLED');
      cancelError.isCancel = true;
      cancelError.timeline = timeline;
      throw cancelError;
    }
    pushTimeline(timeline, 'error', error.message);
    throw error;
  }
};

module.exports = {
  DEFAULT_NS,
  DEFAULT_POD_GREP,
  isKexecEnabled,
  getKexecConfig,
  assertShouldUseKexec,
  buildCurlArgv,
  parseCurlMinusIOutput,
  resolvePod,
  sendRequestViaKexec,
  serializeBody
};
