# Personal kubectl-exec transport

Private Bruno GUI patch: when opted in, **Send** runs the prepared HTTP request with `kubectl exec … -- curl` inside a Running pod. No in-pod proxy setup.

## Enable

Put these in the **collection root `.env`** file (Bruno `process.env` / dotenv — not a Bruno environment JSON variable), or export them in the OS environment before launching Bruno:

```env
KUBE_EXEC=1
KUBE_EXEC_HOST_SUFFIX=service.p.gojek.com
KUBE_NS=a000048
KUBE_POD_GREP=gofood-moderator-http-server
# optional:
# KUBE_CONTEXT=my-context
# KUBE_CONTAINER=my-container
```

- `KUBE_EXEC=1` — required opt-in
- `KUBE_EXEC_HOST_SUFFIX` — required; request hostname must end with this suffix (otherwise Send errors — including public URLs while kexec is on)
- `KUBE_NS` / `KUBE_POD_GREP` — defaults shown above
- Pod selection: Running pods only, first name containing `KUBE_POD_GREP`; chosen pod is logged on the Timeline
- `kubectl` must be on Bruno’s PATH and already authenticated to the cluster

### Quick checks

| Case | Expected |
|------|----------|
| `KUBE_EXEC` unset | Normal axios |
| `KUBE_EXEC=1` + matching host | Timeline shows pod; response from in-pod curl |
| `KUBE_EXEC=1` + `https://example.com` | Error: host does not end with suffix |

## Behaviour

- Pre-request scripts, auth → headers, post-response scripts/tests still run locally
- Wire hop is `kubectl` + `curl` only (GUI Send path; not `bru run`)
- v1 does not support multipart / streamed bodies

## Disable

Unset `KUBE_EXEC` (or set to `0`) to use normal axios.
