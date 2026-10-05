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

Use the same config file in the bot service and in local CLI processes. Remote
sends use the running bot's config. Installing this change requires the normal
package release/upgrade and configuring the application bindings; opening a PR
does not change a running integration.
