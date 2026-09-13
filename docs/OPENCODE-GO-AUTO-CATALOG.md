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

The job reads the provider's live `/models` catalog through the existing
credential-aware discovery path and reads the public OpenCode Go page at
`https://opencode.ai/docs/go/`. The documentation table is the protocol
authority. Only these exact documented endpoints are accepted:

| Documentation endpoint | Router provider variant |
| --- | --- |
| `https://opencode.ai/zen/go/v1/chat/completions` | `opencode-go` |
| `https://opencode.ai/zen/go/v1/messages` | `opencode-go-messages` |
| `https://opencode.ai/zen/go/v1/responses` | `opencode-go-responses` |

Redirects, oversized or malformed pages, duplicate model rows, arbitrary
endpoint hosts, and rows missing a protocol fail closed. A model is eligible
only when the same id is present in the fresh live Go catalog and the official
page documents its endpoint. A documentation or protocol gap records a
pending status for that id while eligible documented models continue to activate.

Unknown eligible ids are written as user-owned models with the existing
`userModelEntry` conservative defaults. Their description identifies the
documented endpoint and says which metadata remains conservative. Existing
models, routes, providers, and user edits are preserved. On first activation,
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
credentials to the public documentation request.
