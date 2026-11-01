# TacPhone host runtime tests

Live tests for the TacPhone host (`ACE_TacPhone_Main`). They talk to the running
game over the same WebSocket protocol as the page and use Node built-ins only.

The options registry itself is page-local, so its UI and live Map behaviour are
covered by the browser checklist in [`browser/options-checklist.md`](browser/options-checklist.md).
The Node suite covers the game-facing half: the app catalog, the
`SaveLayout`/`GetLayout` envelope that stores option values together with the
flexlayout model, and the Remote Access relay.

## Prerequisites

- Arma 3 is running a mission with the current TacPhone PBO loaded.
- The TacPhone web host is listening on `wss://localhost:8001/ws`.
- Node trusts the local HTTPS certificate. If not, point `NODE_EXTRA_CA_CERTS`
  at the certificate PEM; never disable certificate verification.
- **Close the in-game TacPhone page** before running the layout scenario, or use
  a scratch mission. An open page can save its own layout during the round trip.
  The scenario always restores the previous layout, even after a failure.
- The `remote-access` scenario needs an `__A3_DEBUG__` build with the
  server-controlled **TacPhone > Allow debug mode** setting and the same relay
  host configuration the in-game Remote Access panel uses. Without it the
  scenario is skipped unless you request it explicitly with
  `--scenario remote-access`.
- The `display-mode` scenario briefly opens the phone in HUD/DIALOG/HIDDEN
  states and restores `CLOSED` at the end. It also needs an `__A3_DEBUG__` build
  with **Allow debug mode**.

### Trusting the local certificate

The web host uses a self-signed certificate. Export the certificate the running
host presents and point Node at it (never disable verification):

```powershell
$out = Join-Path $env:TEMP 'tacphone-localhost.pem'
$tcp = [System.Net.Sockets.TcpClient]::new('localhost', 8001)
$ssl = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false, { param($s, $c, $ch, $e) $true })
$ssl.AuthenticateAsClient('localhost')
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
[IO.File]::WriteAllText($out, "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n")
$env:NODE_EXTRA_CA_CERTS = $out
```

The certificate changes when the web host regenerates it, so re-export it if the
suites report `self-signed certificate`. Run all suites in the same PowerShell
session, or set `NODE_EXTRA_CA_CERTS` permanently for the user.

## Run

From `websource`:

```powershell
npm run test:host
node ACE_TacPhone_Main/test/run-tests.mjs --list
node ACE_TacPhone_Main/test/run-tests.mjs --scenario layout-options --verbose
```

`npm run test:all` runs this suite together with the Messenger and Map suites
and prints one summary; `-- --suite host` narrows it.

Useful options:

```text
--url <url>          WebSocket URL (default wss://localhost:8001/ws)
--timeout <ms>       Per request timeout (default 8000)
--scenario <name>    One or more scenario names, repeat or comma-separate
--list               List scenario names and exit
--verbose            Log requests and replies
```

## Layout

```text
test/
├── run-tests.mjs                    # CLI, connection, scenario runner
├── lib/
│   ├── ws-client.mjs                # raw RFC 6455 client with Origin header
│   └── assertions.mjs               # assertion helpers + runSuite
├── scenarios/
│   ├── apps.test.mjs                # GetAvailableApps includes main/Map/Messaging
│   ├── layout-options.test.mjs      # options envelope survives SaveLayout/GetLayout
│   ├── remote-access.test.mjs       # relay start, share link, remote clients, dead-peer cleanup
│   └── display-mode.test.mjs        # Debug.SetLocalDisplayMode CLOSED/HUD/DIALOG/HIDDEN
└── browser/
    └── options-checklist.md         # manual Options panel / Map settings checks
```

## Adding a scenario

1. Create `scenarios/<name>.test.mjs`.
2. Export `name`, an optional `description`, and `async run({ client })`.
3. Use `client.request(command, payload)`; `a` is always `main`.
4. Add the module to `ALL_SCENARIOS` in `run-tests.mjs`.
5. Restore any game state you change (`SaveLayout` is the only writable main
   command used today).

Scenarios must not edit app or SQF source. They may use only the public request
protocol.
