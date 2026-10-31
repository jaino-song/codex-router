# OpenCode Go automatic catalog

`bin/opencode-go-auto-catalog` manages an optional macOS launchd job that checks
the OpenCode Go subscription catalog every five minutes. Installation is an
explicit action; no launch agent is created merely by importing the module or
running the router.

```text
bin/opencode-go-auto-catalog install
bin/opencode-go-auto-catalog status
bin/opencode-go-auto-catalog check
bin/opencode-go-auto-catalog disable
```

After the existing discovery-enabled, configured-provider, and provider-selection
gates pass in the updater child, the job makes one credential-free public inventory request to
`https://opencode.ai/inference/go/v1/models`. That single validated JSON snapshot
supplies both live model ids and metadata; the updater does not call the
credential-backed discovery path or fetch the retired HTML endpoint table.

The response must have a successful 2xx status and `application/json` content
type. Redirects fail closed. The request and body share a 10-second deadline,
and both the declared size and streamed body are limited to 2 MiB. The top-level
object must contain a `data` array with unique bounded model ids. Names, positive
integer context/input/output limits, text/MIME modality arrays, and API entries
are validated before any model is adopted.

Each `model.api` entry is keyed by protocol and contains a `base_url` and `sdk`.
Only these exact protocol/base URL tuples map to existing router variants:

| Inventory protocol | Exact base URL | Operation appended to the plan row | Router provider variant |
| --- | --- | --- | --- |
| `chat-completions` | `https://opencode.ai/inference/go/openai/v1` | `/chat/completions` | `opencode-go` |
| `responses` | `https://opencode.ai/inference/go/openai/v1` | `/responses` | `opencode-go-responses` |
| `messages` | `https://opencode.ai/inference/go/anthropic/v1` | `/messages` | `opencode-go-messages` |

The known `generate-content` protocol with
`https://opencode.ai/inference/go/google/v1beta` is valid but has no supported
router adapter. Its ids remain pending while supported rows can activate.
Other tuples, userinfo, query strings, fragments, alternate origins, and
unexpected paths reject the entire snapshot. Existing legacy Zen routes and
user-owned route choices remain intact; the inventory does not rewrite them.

Only display name, context window (with the existing derived auto-compact
threshold), and supported text/image input modalities enter new model metadata.
Output limits/modalities are validated without adding registry fields. Remote
SDK names, capability/compatibility objects, descriptions, instructions, and
other unused fields are never executed or copied into registry metadata.

Unknown eligible ids are written as user-owned models with the existing
`userModelEntry` conservative defaults. Their description identifies the
validated inventory endpoint and says which metadata remains conservative.
Existing models, routes, providers, and user edits are preserved. On first activation,
currently listed Go presets are shown unless the picker already records them
as hidden. Later checks remember every seen provider/id pair, so a model the
operator removed or hid is not silently re-added or made visible.

Activation waits for protected router evidence: a healthy router must report
zero actual `inFlightRequests`, an idle activity snapshot, and two matching
observations separated by a 60-second quiet interval. A changed router
instance, counter, or activity timestamp defers the update. The final check
and request ingress are necessarily separate observations; a tiny request race
can still occur immediately after the final check. The updater does not claim
an absolute interruption guarantee. A restart is performed only after the
overlay transaction has published the new catalog, and the transaction rolls
back user models, picker state, and catalog history if publication or restart
fails.

State is owner-private under the managed router state directory:

* `opencode-go-auto-catalog-policy.json` — enabled flag and stable source root;
* `opencode-go-auto-catalog-status.json` — bounded status and idle observations;
* `opencode-go-auto-catalog-seen.json` — provider/id history;
* `opencode-go-auto-catalog.lock` — short updater single-flight lock.

The independent launchd definition is stored at
`~/Library/LaunchAgents/io.github.codex-router.opencode-go-auto-catalog.plist`.

The launchd program invokes the stable source root directly with quoted XML
arguments. It is independent of the managed router service, so the updater
survives a router restart. It never restarts the Codex app and never sends
credentials to the public inventory request.

The installed updater definition remains path-only: it contains the source and
state locators, with no provider keys. On `--scheduled`, a small parent first
checks that the policy and discovery are enabled and Go remains selected. It
then reads the existing managed router LaunchAgent at the canonical
`LAUNCH_AGENT_PATH` from `paths.mjs`; there is no extra credential path setting.

That router plist must be a bounded regular file, owned by the current user,
with mode `0600`. Symlinks and writable or foreign-owned path components are
rejected. The loader verifies the opened file against the path before and after
the bounded read, including replacement and metadata changes. The exact service
label, two program arguments (the running Node executable and stable
`src/start.mjs`), canonical working directory, and three managed state aliases
must agree with the updater and current install-manifest owner. The optional
`CODEX_ROUTER_SOURCE_ROOT`, when present, must also agree.

The verified snapshot goes to `/usr/bin/plutil` on stdin with bounded output and
no shell, temporary credential files, or raw diagnostics. Only installation
locators and registry-declared Go credential variables are extracted. The
existing `providerApiKeyServiceEnvironment` policy filters that candidate-only
map to active references in authoritative pools. It does not select accounts or
fall back to another credential source. No unrelated managed-service environment
is copied. Legitimate inherited environment is preserved; an equal same-name Go
value is accepted, while a different value fails closed. The parent environment
is never mutated.

After repeating the policy/discovery/selection checks, the parent spawns this
same updater module once with a fixed internal child command. Recovered keys
appear only in that child's environment. The child enters the normal updater
checks directly, including configured-provider eligibility before the public
fetch and again under the overlay transaction. Publication and its descendants
inherit that same effective environment. The normal updater lock stays held
through publication or rollback. The parent waits for completion without a
short publication timeout, forwards termination signals, and preserves the
child's exit or termination outcome. Child stdout/stderr are suppressed because
provider diagnostics may include credentials; status uses fixed failure codes.

Trust, parsing, or environment conflicts produce sanitized pending status before
any updater child, inventory request, publication, or restart. There is no
automatic retry or fallback credential source. A disabled or discovery-off job
performs no managed credential extraction.

This bridge has only offline synthetic-plist and temporary-state verification,
including real macOS `plutil` parsing and controlled child processes. It does not
establish that the installed updater is operationally restored. Installation,
service activation, and a live operational check remain separate steps.
