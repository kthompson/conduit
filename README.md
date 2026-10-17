# conduit

An OpenAI-compatible HTTP proxy in front of local coding-agent providers (Claude Code today; more to
follow). Point any OpenAI-compatible client — including the GitHub Copilot app's bring-your-own-key
custom endpoint — at `conduit serve` and it forwards requests to a provider instance running on your
machine, already signed in with your own subscription.

See [`PLAN.md`](PLAN.md) for the full design and status, and [`docs/`](docs) for usage of each
subcommand (`serve`, `capture`).

## Requirements

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- For the Claude provider: the `claude` CLI, signed in (`claude auth login`, then `claude auth status`
  should say `loggedIn: true`)

## Getting started

```bash
git clone https://github.com/kthompson/conduit.git
cd conduit
dotnet build
```

Write a config at `~/.config/conduit/conduit.conf` (or pass `--config`):

```hocon
server {
  listen = "127.0.0.1:8787"
  api-keys = [ ${?CONDUIT_KEY} ]   # optional on loopback, required on any other address
}
provider-instances {
  claude { driver = claudeAgent, mode = model }
}
```

Then run it:

```bash
dotnet run --project src/Conduit.Cli -- serve
```

Other useful commands:

```bash
dotnet run --project src/Conduit.Cli -- doctor           # check config, auth, and a sample completion
dotnet run --project src/Conduit.Cli -- config validate  # validate the merged config
dotnet run --project src/Conduit.Cli -- connect copilot  # print values for the Copilot app's custom-endpoint form
dotnet run --project src/Conduit.Cli -- capture          # run the logging capture server (see docs/capture.md)
```

Full walkthrough, including wiring up the GitHub Copilot app: [`docs/serve.md`](docs/serve.md).

## Project layout

```
src/
  Conduit.Cli              CLI entry point (serve, config, doctor, connect, capture)
  Conduit.Server           Host: config, instance registry, auth, OpenAI-compatible routes
  Conduit.OpenAi           OpenAI wire-format types and translation
  Conduit.Provider.Core    Provider driver/instance abstractions
  Conduit.Provider.Claude  Claude Code driver
  Conduit.Provider.Fake    Scripted driver used by tests
  Conduit.Capture          Logging capture server (records what a client sends)
tests/
  Conduit.Server.Tests
  Conduit.Capture.Tests
```

## Building and testing

```bash
dotnet build
dotnet test
```

Run a single test project:

```bash
dotnet test tests/Conduit.Server.Tests
```

## Contributing

Issues and pull requests are welcome.

- Keep changes focused and include tests for behavior changes (xUnit, under `tests/`).
- Run `dotnet build` and `dotnet test` before opening a PR; both must pass.
- Match the existing style: nullable reference types are on, `net10.0`, implicit usings — see
  [`Directory.Build.props`](Directory.Build.props).
- Update [`PLAN.md`](PLAN.md) and the relevant file under `docs/` when you change behavior described
  there.
- For anything non-trivial (new provider driver, new wire format, protocol changes), open an issue or
  draft PR first to discuss the approach — see `PLAN.md` for current status and open phases.

## License

MIT — see [`LICENSE`](LICENSE).
