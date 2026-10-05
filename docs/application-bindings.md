# Application channel and runtime bindings

Set the application's Discord or Slack destination and runtime directory in the
host-written `ROADIE_CHANNELS_CONFIG` file (also accepted as `--channels-config`):

```yaml
application:
  channel: "123456789012345678"
  directory: /srv/agent-context
channels:
  "123456789012345678":
    context: personal-agent
    respond: always
```

`roadie send --prompt "Start this task"` uses `application.channel` regardless of
the caller's directory. All application sessions use `application.directory`,
including child sessions and recovered threads with old working-directory
bindings. Context providers continue to receive the channel's configured context
binding. The host's development workspace remains where repository work happens;
it does not select a Roadie channel or move the application's session runtime.

Configure additional destinations explicitly in `channels`, then select them
with `--channel`. Unconfigured destinations are rejected in application-bound
mode. Existing thread/session sends validate the parent destination. A conflicting
`--cwd` is rejected before sending or scheduling. Channel-level directory values
cannot override the application's runtime directory.

`send` never creates project channels and no longer selects them with `--project`
or the caller's directory. Without an application default, pass `--channel`,
`--thread`, or `--session`. Channel creation remains an explicit operator setup
operation. Existing database mappings are preserved; they do not expand the
application's configured destinations.

## Discord channel commands

Create an ordinary Discord text channel, then run `/channel bind` in it. You can
also run `/channel bind channel:#work` from another channel in the same server.
Roadie administrators can bind previously unconfigured channels; ordinary
messages remain ignored until the explicit binding succeeds. The new binding
inherits the application default channel's context and policy, and all sessions
keep the fixed application directory. No new Discord channel or repository is
created by binding.

`/channel unbind` (or `/channel unbind channel:#work`) writes the existing
`respond: never` policy for that channel, stops its active runtimes and disables
responses in its threads. It retains Discord messages and session history.
Binding again enables the channel with the application's default policy and
existing threads can continue their sessions. The application default itself
cannot be unbound; change `application.channel` explicitly first.

Changes are persisted atomically to the configured YAML/JSON file and apply
immediately without restarting. Other channels and application settings are
preserved. The command requires the configured application's server and the
operator's existing Roadie admin authority; a different server cannot bind
itself to the host runtime.

Use the same config file in the bot service and in local CLI processes. Remote
sends use the running bot's config. Installing this change requires the normal
package release/upgrade and configuring the application bindings; opening a PR
does not change a running integration.
