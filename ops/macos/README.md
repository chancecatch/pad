# PAD Tutor LaunchAgents

These templates run the Mac-local tutor services as user LaunchAgents:

- Ollama on `127.0.0.1:11434`
- MLX-Audio STT/TTS on `127.0.0.1:8000`
- the authenticated PAD gateway on `127.0.0.1:8787`
- an optional remotely managed Cloudflare Tunnel connector

The installer must run from the activated `pad` Conda environment. It resolves
absolute executable paths before rendering the templates:

```bash
conda activate pad
cd "$HOME/Research/Pad/web"
./ops/macos/install-launchagents.sh
```

If the official Ollama app already owns `127.0.0.1:11434`, preserve that
installation and add `--skip-ollama`. To install only MLX-Audio before the
gateway token is available, use:

```bash
./ops/macos/install-launchagents.sh --skip-ollama --skip-gateway
```

To add the gateway later without restarting an already healthy MLX-Audio
LaunchAgent, add `--skip-mlx-audio`.

Before running it, place the existing gateway token in
`.runtime/tutor-gateway/gateway-token.txt`. Do not pass the token on the command
line. The helper requires a non-empty file and changes its mode to `600`.

Cloudflared is deliberately opt-in. Obtain or copy the existing remotely managed
tunnel token through an approved secure flow, store it in
`.runtime/tutor-gateway/cloudflared-token.txt`, and then run:

```bash
./ops/macos/install-launchagents.sh --include-cloudflared
```

Cloudflared is configured as an always-on connector with `KeepAlive=true` and a
30-second launchd throttle. Do not replace this with `NetworkState`; current
launchd no longer implements that condition. The unconditional keep-alive lets
the connector retry if it starts before DNS is ready after login.

To reinstall only Cloudflared without restarting healthy MLX-Audio and gateway
agents:

```bash
./ops/macos/install-launchagents.sh \
  --include-cloudflared \
  --skip-ollama \
  --skip-mlx-audio \
  --skip-gateway \
  --replace
```

Verify the connector and public gateway:

```bash
launchctl print gui/"$(id -u)"/com.pineatdawn.tutor.cloudflared
curl --fail --silent --show-error https://tutor-api.pineatdawn.me/health
```

The helper does not create, display, or extract either token. It also refuses to
install a second Cloudflare connector when the standard Cloudflare LaunchAgent
or LaunchDaemon plist already exists. Existing PAD plists are preserved unless
`--replace` is explicitly supplied.
